package com.wika.wicaby.core.player

import android.content.Context
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.doubleOrNull
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.math.roundToLong

// Community skip times from TheIntroDB (api.theintrodb.org) and IntroDB (api.introdb.app), keyed by the movie's or
// the series' TMDB/TVDB/IMDb id. Anonymous reads only; off by default, nothing is sent while off.
object CommunitySegments {
    // Réglages > Lecture, on TV and mobile, next to AniSkip.
    private val sp get() = Core.app.getSharedPreferences("wicaby_player", Context.MODE_PRIVATE)
    var enabled: Boolean
        get() = sp.getBoolean("community_segments", false)
        set(v) = sp.edit().putBoolean("community_segments", v).apply()

    // Per kind, the first source that has it wins: the server, then TheIntroDB, IntroDB, AniSkip.
    fun merge(sources: List<Segments?>): Segments {
        val all = sources.filterNotNull()
        val intro = all.firstOrNull { it.introEnd != null }
        val ranges = SegmentKind.entries.flatMap { k -> all.firstOrNull { s -> s.ranges.any { it.kind == k } }?.ranges.orEmpty().filter { it.kind == k } }
        return Segments(intro?.introStart, intro?.introEnd, all.firstNotNullOfOrNull { it.credits }, ranges.sortedBy { it.startMs })
    }

    // What the server lacks: a title with every kind marked asks nobody (the desktop's missingKinds).
    fun missingKinds(s: Segments): Boolean =
        s.introEnd == null || s.credits == null || listOf(SegmentKind.Recap, SegmentKind.Preview).any { k -> s.ranges.none { it.kind == k } }

    // Milliseconds, rounded; IntroDB may give seconds instead (start_sec / end_sec), as the desktop's parser.
    private fun ms(o: JsonObject, k: String): Long? {
        fun num(v: JsonElement?) = (v as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() }
        return num(o["${k}_ms"])?.roundToLong() ?: num(o["${k}_sec"])?.let { (it * 1000).roundToLong() }
    }

    // The earliest sane span of one kind. A null start is the start of the media (intro, recap), a null end its end
    // (credits, preview); anything else null, reversed, negative or past the runtime (+5 s) is dropped.
    private fun pick(spans: List<JsonObject>, runtimeMs: Long, openStart: Boolean, openEnd: Boolean): Pair<Long, Long>? =
        spans.mapNotNull { o ->
            val s = ms(o, "start") ?: if (openStart) 0L else return@mapNotNull null
            val e = ms(o, "end") ?: if (openEnd) runtimeMs else return@mapNotNull null
            if (s < 0 || e <= s || e > runtimeMs + 5_000) null else s to e
        }.minByOrNull { it.first }

    private fun build(intro: Pair<Long, Long>?, recap: Pair<Long, Long>?, credits: Pair<Long, Long>?, preview: Pair<Long, Long>?): Segments? {
        // A credits start at 0 would mark the item watched as it starts (Segments.kt).
        val c = credits?.first?.takeIf { it > 0 }
        if (intro == null && recap == null && c == null && preview == null) return null
        val ranges = listOfNotNull(
            intro?.let { SkipRange(SegmentKind.Intro, it.first, it.second) },
            recap?.let { SkipRange(SegmentKind.Recap, it.first, it.second) },
            preview?.let { SkipRange(SegmentKind.Preview, it.first, it.second) },
        )
        return Segments(intro?.first, intro?.second, c, ranges.sortedBy { it.startMs })
    }

    private fun obj(body: String) = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull()

    // GET /v4/media: arrays of {start_ms, end_ms} per kind. The "versions" and "episodes" shapes carry none: null.
    fun parseTheIntroDb(body: String, runtimeMs: Long): Segments? {
        val root = obj(body) ?: return null
        fun spans(k: String) = (root[k] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
        return build(
            pick(spans("intro"), runtimeMs, openStart = true, openEnd = false),
            pick(spans("recap"), runtimeMs, openStart = true, openEnd = false),
            pick(spans("credits"), runtimeMs, openStart = false, openEnd = true),
            pick(spans("preview"), runtimeMs, openStart = false, openEnd = true),
        )
    }

    // GET /segments: intro, recap, outro each null or {start_ms, end_ms, …}; post_credits is ignored.
    fun parseIntroDb(body: String, runtimeMs: Long): Segments? {
        val root = obj(body) ?: return null
        fun spans(k: String) = listOfNotNull(root[k] as? JsonObject)
        return build(
            pick(spans("intro"), runtimeMs, openStart = false, openEnd = false),
            pick(spans("recap"), runtimeMs, openStart = false, openEnd = false),
            pick(spans("outro"), runtimeMs, openStart = false, openEnd = true),
            null,
        )
    }

    // ProviderIds keys compared case-insensitively ("Tmdb", "tmdb"…), values checked before they go in a URL.
    private fun id(ids: Map<String, String?>, name: String, shape: Regex): String? =
        ids.entries.firstOrNull { it.key.equals(name, true) }?.value?.trim()?.takeIf { shape.matches(it) }

    private val NUM = Regex("\\d{1,10}")
    private val IMDB = Regex("tt\\d{5,10}")

    // One id only, in the API's own order of preference (TVDB, TMDB, IMDb). Movies: no season/episode.
    fun theIntroDbUrl(ids: Map<String, String?>, season: Int?, episode: Int?): HttpUrl? {
        val b = "https://api.theintrodb.org/v4/media".toHttpUrl().newBuilder()
        id(ids, "Tvdb", NUM)?.let { b.addQueryParameter("tvdb_id", it) }
            ?: id(ids, "Tmdb", NUM)?.let { b.addQueryParameter("tmdb_id", it) }
            ?: id(ids, "Imdb", IMDB)?.let { b.addQueryParameter("imdb_id", it) }
            ?: return null
        if (season != null && episode != null) b.addQueryParameter("season", "$season").addQueryParameter("episode", "$episode")
        return b.build()
    }

    fun introDbUrl(ids: Map<String, String?>, season: Int?, episode: Int?): HttpUrl? {
        val imdb = id(ids, "Imdb", IMDB) ?: return null
        val b = "https://api.introdb.app/segments".toHttpUrl().newBuilder().addQueryParameter("imdb_id", imdb)
        if (season != null && episode != null) b.addQueryParameter("season", "$season").addQueryParameter("episode", "$episode")
        else b.addQueryParameter("is_movie", "true")
        return b.build()
    }

    // As AniSkip: no redirects, a short timeout, the shared client (its server credentials stay on the server's origin).
    private val client by lazy {
        Core.http.newBuilder().followRedirects(false).followSslRedirects(false).callTimeout(5, TimeUnit.SECONDS).build()
    }
    private val cache = HashMap<String, Segments?>()
    private val blockedUntil = HashMap<String, Long>()

    // The body of a 200, null for a 404 (nothing known). A 429 pauses that host for its Retry-After; anything else
    // throws, so it is not cached.
    private suspend fun get(url: HttpUrl): String? = withContext(Dispatchers.IO) {
        synchronized(blockedUntil) { if ((blockedUntil[url.host] ?: 0) > System.currentTimeMillis()) throw IOException("${url.host} 429") }
        client.newCall(Request.Builder().url(url).build()).execute().use {
            if (it.code == 429) {
                val wait = (it.header("Retry-After")?.toLongOrNull() ?: 60).coerceIn(1, 3_600)
                synchronized(blockedUntil) { blockedUntil[url.host] = System.currentTimeMillis() + wait * 1_000 }
            }
            when {
                it.code == 404 -> null
                !it.isSuccessful -> throw IOException("${url.host} ${it.code}")
                else -> it.body.string()
            }
        }
    }

    private suspend fun one(url: HttpUrl?, runtimeMs: Long, parse: (String, Long) -> Segments?): Segments? {
        val key = "${url ?: return null}|$runtimeMs"
        synchronized(cache) { if (cache.containsKey(key)) return cache[key] }
        val s = runCatching { get(url)?.let { parse(it, runtimeMs) } }.getOrElse { return null }
        synchronized(cache) { cache[key] = s }
        return s
    }

    // [TheIntroDB's, IntroDB's] for a movie or an episode (the series' ids with its season and episode numbers);
    // each null when the service has nothing, fails or the title has no usable id.
    suspend fun segments(api: Api, item: Item): List<Segments?> {
        val runtimeMs = (item.runTimeTicks ?: 0) / TICKS_PER_MS
        if (runtimeMs <= 0) return emptyList()
        val season = item.parentIndexNumber
        val episode = item.indexNumber
        val ids = when {
            item.isEpisode -> if (season == null || episode == null) return emptyList() else api.item(item.seriesId ?: return emptyList()).providerIds
            item.type == "Movie" -> item.providerIds
            else -> return emptyList()
        }
        val s = season.takeIf { item.isEpisode }
        val e = episode.takeIf { item.isEpisode }
        return coroutineScope {
            listOf(
                async { one(theIntroDbUrl(ids, s, e), runtimeMs, ::parseTheIntroDb) },
                async { one(introDbUrl(ids, s, e), runtimeMs, ::parseIntroDb) },
            ).awaitAll()
        }
    }
}
