package com.wika.wicaby.core.player

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.MediaSource
import com.wika.wicaby.core.data.OfflineProgress
import com.wika.wicaby.core.data.PendingProgress
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.Versions

// "Ouvrir dans un lecteur externe": VLC, MX Player or any app that plays a video link, for the
// files Media3 cannot play. The app gets the original file (no transcode), the title and the
// resume point; VLC and MX Player hand the position back when they close.
//
// For both apps: show the action only when available(); launch intent() for a result
// (ActivityResultContracts.StartActivityForResult, never with FLAG_ACTIVITY_NEW_TASK, which
// drops the result); give the returned Intent to report().
object ExternalPlayer {
    // Installed apps that open a video link; the Android TV "no app can do this" stubs do not count.
    private fun players(context: Context, intent: Intent): List<String> =
        runCatching { context.packageManager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY) }.getOrDefault(emptyList())
            .map { it.activityInfo.packageName }
            .filterNot { it.contains("frameworkpackagestubs") || it.endsWith(".stubs") || it == context.packageName }

    // Any video player for this server's scheme (http or https). Never for Plex or Navidrome: their tokens never go in a URL, and
    // another app cannot send our headers.
    fun available(context: Context, api: Api): Boolean = api.server.kind !in setOf("plex", "navidrome") && players(context, view(api.base)).isNotEmpty()

    // The original file. The token rides in the query (Emby reads api_key, Jellyfin 10.11+ only
    // ApiKey) because another app cannot send our auth headers; the URL only goes to the app the
    // viewer picked on this device.
    fun streamUrl(api: Api, itemId: String, mediaSourceId: String?): String = api.url(
        "/Videos/$itemId/stream", "static" to true, "MediaSourceId" to mediaSourceId, key(api),
    )

    private fun key(api: Api) = (if (api.server.isEmby) "api_key" else "ApiKey") to api.token.takeUnless { api.server.kind in setOf("plex", "navidrome") }

    internal class Sub(val url: String, val name: String, val default: Boolean)

    // B24: the source's external subtitle files (the /stream file has its embedded tracks only), text formats
    // only, in the server's own route with the same key as streamUrl.
    internal fun subtitles(api: Api, itemId: String, source: MediaSource?): List<Sub> {
        val src = source ?: return emptyList()
        return src.mediaStreams.filter { it.type == "Subtitle" && it.isExternal }.mapNotNull { s ->
            val ext = when (s.codec?.lowercase()) {
                "srt", "subrip" -> "srt"
                "ass" -> "ass"
                "ssa" -> "ssa"
                "vtt", "webvtt" -> "vtt"
                else -> return@mapNotNull null
            }
            Sub(
                api.url("/Videos/$itemId/${src.id}/Subtitles/${s.index}/Stream.$ext", key(api)),
                s.displayTitle ?: s.title ?: s.language ?: "${s.index}",
                s.index == src.defaultSubtitleStreamIndex,
            )
        }
    }

    private fun view(url: String) = Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(url), "video/*")

    // [item] from [startMs] (its resume point by default), in the version picked on the detail page.
    // With a single player installed it opens directly; otherwise the system asks which one.
    fun intent(context: Context, api: Api, item: Item, startMs: Long = item.resumeMs): Intent {
        val source = Versions.selected(item)
        val intent = view(streamUrl(api, item.id, source?.id))
            .putExtra("title", if (item.isEpisode && item.seriesName != null) "${item.seriesName} · ${item.name}" else item.name)
            // ms as an int: MX Player reads only an int, VLC an int or a long.
            .putExtra("position", startMs.coerceIn(0, Int.MAX_VALUE.toLong()).toInt())
            // MX Player answers with the position only when asked; VLC always does.
            .putExtra("return_result", true)
        val subs = subtitles(api, item.id, source)
        if (subs.isNotEmpty()) {
            // MX Player (and Vimu): every file, with names, the server's default one on; VLC takes a single file.
            intent.putExtra("subs", subs.map { Uri.parse(it.url) }.toTypedArray())
                .putExtra("subs.name", subs.map { it.name }.toTypedArray())
                .putExtra("subs.enable", subs.filter { it.default }.map { Uri.parse(it.url) }.toTypedArray())
                .putExtra("subtitles_location", (subs.firstOrNull { it.default } ?: subs.first()).url)
        }
        return players(context, intent).singleOrNull()?.let { intent.setPackage(it) } ?: intent
    }

    // The position the player handed back: VLC "extra_position" (long), MX Player "position" (int).
    fun positionMs(data: Intent?): Long? = longOrInt(data, "extra_position", "position")

    fun durationMs(data: Intent?): Long? = longOrInt(data, "extra_duration", "duration")

    private fun longOrInt(data: Intent?, long: String, int: String): Long? {
        val e = data?.extras ?: return null
        val v = when {
            e.containsKey(long) -> e.getLong(long)
            e.containsKey(int) -> e.getInt(int).toLong()
            else -> return null
        }
        return v.takeIf { it >= 0 }
    }

    // Saves what the player handed back as the item's resume point, or as watched (90 % rule,
    // or MX Player's "played to the end"). Queued in OfflineProgress first, then sent: a failed
    // call stays queued until the next OfflineProgress.flush (app start, or the next report).
    // False when the player sent no position.
    suspend fun report(api: Api, item: Item, data: Intent?): Boolean {
        val pos = positionMs(data) ?: return false
        val completed = data?.getStringExtra("end_by") == "playback_completion"
        val (resume, watched) = progress(pos, durationMs(data), (item.runTimeTicks ?: 0) / TICKS_PER_MS, completed)
        OfflineProgress.add(PendingProgress(api.server.id, api.userId.orEmpty(), item.id, resume * TICKS_PER_MS, watched, System.currentTimeMillis()))
        runCatching { OfflineProgress.flush(api) }
        return true
    }

    // (resume ms, watched) from the returned position; with no returned duration, the item's runtime.
    internal fun progress(posMs: Long, durMs: Long?, runtimeMs: Long, completed: Boolean): Pair<Long, Boolean> {
        val dur = durMs?.takeIf { it > 0 } ?: runtimeMs
        val watched = completed || isWatched(posMs, dur, null)
        return (if (watched) 0L else resumeFrom(posMs, dur)) to watched
    }
}
