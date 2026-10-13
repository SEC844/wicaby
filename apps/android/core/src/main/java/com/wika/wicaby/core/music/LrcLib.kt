package com.wika.wicaby.core.music

import android.content.Context
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Online lyrics from lrclib.net (music spec MU-13), the twin of desktop's main/music/lrclib.ts: off by default
 * (Réglages), asked only when the server has none. It sends the artist, title, album and duration to a third party.
 * Answers, "not found" included, are kept per track id for 30 days in [cache] ("<at>\n<text>", written back through
 * [save]); a failure is not kept.
 */
class LrcLib(
    private val http: () -> OkHttpClient,
    private val base: String,
    private val userAgent: String,
    private val enabled: () -> Boolean,
    private val cache: MutableMap<String, String> = mutableMapOf(),
    private val save: (Map<String, String>) -> Unit = {},
    private val now: () -> Long = System::currentTimeMillis,
) {
    suspend fun lyrics(item: Item): Lyrics? {
        if (!enabled()) return null
        val artist = item.artistItems.firstOrNull()?.name ?: item.artists.firstOrNull() ?: item.albumArtist ?: return null
        if (item.name.isBlank()) return null
        val t = now()
        cache[item.id]?.let { hit ->
            if (t - at(hit) < TTL_MS) return parse(hit.substringAfter('\n', ""))
        }
        val url = "$base/api/get".toHttpUrl().newBuilder()
            .addQueryParameter("artist_name", artist)
            .addQueryParameter("track_name", item.name)
            .addQueryParameter("album_name", item.album ?: "")
            .addQueryParameter("duration", Math.round((item.runTimeTicks ?: 0) / TICKS_PER_MS / 1000.0).toString())
            .build()
        val req = Request.Builder().url(url).header("User-Agent", userAgent).header("Accept", "application/json").build()
        val text = withContext(Dispatchers.IO) {
            runCatching {
                http().newCall(req).execute().use { r ->
                    when {
                        r.isSuccessful -> textOf(r.body.string())
                        // Anything but "not found" may work next time: not kept.
                        r.code == 404 -> ""
                        else -> null
                    }
                }
            }.getOrNull()
        } ?: return null
        cache.entries.removeAll { t - at(it.value) >= TTL_MS }
        cache[item.id] = "$t\n$text"
        save(cache)
        return parse(text)
    }

    private fun at(entry: String) = entry.substringBefore('\n').toLongOrNull() ?: 0

    private fun parse(text: String): Lyrics? =
        text.takeIf { it.isNotBlank() }?.let { Lrc.parse(it).copy(lrclib = true) }?.takeIf { it.lines.isNotEmpty() }

    companion object {
        const val LRCLIB = "https://lrclib.net"
        const val TTL_MS = 30L * 24 * 3600 * 1000
        private const val MAX_TEXT = 200_000

        /** LRCLIB's /api/get answer: synced lyrics first, plain ones otherwise; instrumental or empty = "". */
        internal fun textOf(body: String): String {
            val o = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return ""
            if (o["instrumental"]?.jsonPrimitive?.booleanOrNull == true) return ""
            return listOf("syncedLyrics", "plainLyrics").firstNotNullOfOrNull { k ->
                runCatching { o[k]?.jsonPrimitive?.contentOrNull }.getOrNull()?.takeIf { it.isNotBlank() && it.length <= MAX_TEXT }
            } ?: ""
        }

        /** The app's instance: Core.http, the MusicPrefs toggle, a SharedPreferences cache (read on first use). */
        val default: LrcLib by lazy {
            val sp = Core.app.getSharedPreferences("wicaby_lrclib", Context.MODE_PRIVATE)
            LrcLib(
                http = { Core.http },
                base = LRCLIB,
                userAgent = "Wicaby/${Core.version} (Android; +https://github.com/WicaebethTheo/wicaby-releases)",
                enabled = { MusicPrefs.lyricsOnline },
                cache = sp.all.mapNotNull { (k, v) -> (v as? String)?.let { k to it } }.toMap(HashMap()),
                save = { all -> sp.edit().clear().apply { all.forEach { (k, v) -> putString(k, v) } }.apply() },
            )
        }
    }
}
