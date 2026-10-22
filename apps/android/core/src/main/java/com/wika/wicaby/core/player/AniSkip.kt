package com.wika.wicaby.core.player

import android.content.Context
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import kotlin.math.roundToLong

data class AniSkipTarget(val mal: Int?, val anilist: Int?, val episode: Int)

// AniSkip (api.aniskip.com, community opening/ending times keyed by MyAnimeList id) for anime episodes the server
// has no intro or credits markers for. Same rules as the desktop src/shared/aniskip.ts: both run
// tools/checks/fixtures/aniskip.json.
object AniSkip {
    // Réglages > Lecture, on TV and mobile. A third party: off by default.
    private val sp get() = Core.app.getSharedPreferences("wicaby_player", Context.MODE_PRIVATE)
    var enabled: Boolean
        get() = sp.getBoolean("aniskip", false)
        set(v) = sp.edit().putBoolean("aniskip", v).apply()

    // ProviderIds spellings of the anime plugins (Emby/Jellyfin MyAnimeList, AniList); keys compared case-insensitively.
    private fun idOf(ids: Map<String, String?>, names: List<String>): Int? =
        ids.entries.firstOrNull { it.key.lowercase() in names }?.value?.takeIf { Regex("\\d{1,9}").matches(it) }?.toInt()

    private fun target(ids: Map<String, String?>, episode: Int): AniSkipTarget? {
        val mal = idOf(ids, listOf("myanimelist", "mal"))
        val anilist = idOf(ids, listOf("anilist"))
        return if (mal != null || anilist != null) AniSkipTarget(mal, anilist, episode) else null
    }

    // MAL numbers episodes per entry, and each season of an anime is its own entry: a season with its own id uses it,
    // the series id only in season 1. Specials, or a later season with only a series id, are skipped.
    fun target(index: Int?, parentIndex: Int?, seasonIds: Map<String, String?>, seriesIds: Map<String, String?>): AniSkipTarget? {
        if (index == null || index < 1 || parentIndex == null || parentIndex == 0) return null
        return target(seasonIds, index) ?: if (parentIndex == 1) target(seriesIds, index) else null
    }

    fun url(mal: Int, episode: Int, lengthMs: Long): String =
        "https://api.aniskip.com/v2/skip-times/$mal/$episode?" + listOf("op", "ed", "mixed-op", "mixed-ed", "recap").joinToString("&") { "types[]=$it" } +
            "&episodeLength=${(lengthMs / 1000.0).roundToLong()}"

    private fun ms(v: Any?): Long? = (v as? JsonPrimitive)?.doubleOrNull?.let { (it * 1000).roundToLong() }

    // The earliest opening as the intro, the earliest ending's start as the credits, a recap as a range. Null when none.
    fun parse(body: String): Segments? {
        val root = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return null
        if ((root["found"] as? JsonPrimitive)?.booleanOrNull != true) return null
        val spans = runCatching { root["results"]!!.jsonArray }.getOrNull().orEmpty().mapNotNull { r ->
            val o = r as? JsonObject ?: return@mapNotNull null
            val i = o["interval"] as? JsonObject
            val s = ms(i?.get("startTime")) ?: return@mapNotNull null
            val e = ms(i?.get("endTime")) ?: return@mapNotNull null
            if (s < 0 || e <= s) null else Triple((o["skipType"] as? JsonPrimitive)?.contentOrNull.orEmpty(), s, e)
        }.sortedBy { it.second }
        val op = spans.firstOrNull { it.first == "op" || it.first == "mixed-op" }
        // A credits marker at 0 would mark the item watched as it starts (Segments.kt).
        val ed = spans.firstOrNull { (it.first == "ed" || it.first == "mixed-ed") && it.second > 0 }
        val recap = spans.firstOrNull { it.first == "recap" }
        if (op == null && ed == null && recap == null) return null
        val ranges = listOfNotNull(op?.let { SkipRange(SegmentKind.Intro, it.second, it.third) }, recap?.let { SkipRange(SegmentKind.Recap, it.second, it.third) })
        return Segments(op?.second, op?.third, ed?.second, ranges.sortedBy { it.startMs })
    }

    // The server's kinds win over AniSkip's.
    fun merge(server: Segments, a: Segments): Segments = CommunitySegments.merge(listOf(server, a))

    // In memory for the run: one answer per (MAL id, episode), one MAL id per AniList id.
    private val cache = HashMap<String, Segments?>()
    private val malOfAnilist = HashMap<Int, Int?>()

    // AniSkip answers "not found" with a 404 and a JSON body. Sends only the ids, episode number and length.
    private suspend fun fetch(url: String, post: String? = null): String = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(url)
        if (post != null) req.post(post.toRequestBody("application/json".toMediaType()))
        Core.http.newCall(req.build()).execute().use {
            if (!it.isSuccessful && it.code != 404) throw IOException("${req.build().url.host} ${it.code}")
            it.body.string()
        }
    }

    private suspend fun malOf(anilist: Int): Int? {
        synchronized(malOfAnilist) { if (malOfAnilist.containsKey(anilist)) return malOfAnilist[anilist] }
        val body = """{"query":"query(${'$'}id:Int){Media(id:${'$'}id,type:ANIME){idMal}}","variables":{"id":$anilist}}"""
        val r = json.parseToJsonElement(fetch("https://graphql.anilist.co", body)).jsonObject
        val mal = runCatching { r["data"]!!.jsonObject["Media"]!!.jsonObject["idMal"]!!.jsonPrimitive.contentOrNull?.toIntOrNull() }.getOrNull()
        synchronized(malOfAnilist) { malOfAnilist[anilist] = mal }
        return mal
    }

    // Intro, credits and recap of an anime episode whose season or series has a MyAnimeList or AniList id.
    suspend fun segments(api: Api, item: Item): Segments? {
        val season = item.seasonId
        val series = item.seriesId
        val lengthMs = (item.runTimeTicks ?: 0) / TICKS_PER_MS
        if (!item.isEpisode || season == null || series == null || lengthMs <= 0) return null
        val t = target(item.indexNumber, item.parentIndexNumber, api.item(season).providerIds, api.item(series).providerIds) ?: return null
        val mal = t.mal ?: t.anilist?.let { malOf(it) } ?: return null
        val key = "$mal:${t.episode}"
        synchronized(cache) { if (cache.containsKey(key)) return cache[key] }
        val s = parse(fetch(url(mal, t.episode, lengthMs)))
        synchronized(cache) { cache[key] = s }
        return s
    }
}
