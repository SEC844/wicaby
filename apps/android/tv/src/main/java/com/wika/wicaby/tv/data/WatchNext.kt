package com.wika.wicaby.tv.data

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.tv.TvContract
import android.media.tv.TvContract.WatchNextPrograms
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.annotation.ChecksSdkIntAtLeast
import androidx.annotation.RequiresApi
import androidx.core.net.toUri
import com.wika.wicaby.tv.BuildConfig
import com.wika.wicaby.tv.MainActivity
import com.wika.wicaby.core.player.resumeFrom
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.thumb
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// The launcher's "Continuer à regarder" row (Watch Next, android.media.tv.TvContract).
// One entry per series (or film); refreshed whenever a playback session ends.
// program() and supported() are shared with the preview channels (HomeChannels).
// Uses the framework provider contract directly (Watch Next is API 26+ anyway): androidx.tvprovider's
// WatchNextProgram.Builder setters are inherited from @RestrictTo base classes, which lint rejects.
object WatchNext {
    const val SCHEME = "wicaby"

    fun playUri(id: String): Uri = "$SCHEME://play/$id".toUri()

    // The detail page instead of playback (a series, or a film from Recently Added).
    fun openUri(id: String): Uri = "$SCHEME://open/$id".toUri()

    // Watch Next and preview channels: Android TV 8.0+ launchers only.
    @ChecksSdkIntAtLeast(api = 26)
    fun supported(context: Context) = Build.VERSION.SDK_INT >= 26 && context.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)

    // One of our rows in the provider: what update() needs to decide between insert, update and delete.
    private class Row(val id: Long, val browsable: Boolean)

    suspend fun update(context: Context, api: Api, item: Item, positionMs: Long, durationMs: Long, watched: Boolean) = withContext(Dispatchers.IO) {
        if (!supported(context)) return@withContext
        runCatching {
            val key = item.seriesId ?: item.id
            val existing = find(context, key)
            // Removed by the viewer from the row: keep it removed.
            if (existing != null && !existing.browsable) {
                delete(context, existing.id)
                return@runCatching
            }
            val program = when {
                watched && item.isEpisode -> api.nextEpisode(item)?.let { watchNext(api, it, WatchNextPrograms.WATCH_NEXT_TYPE_NEXT, 0, it.runTimeTicks?.div(TICKS_PER_MS) ?: 0, key) }
                watched -> null
                resumeFrom(positionMs, durationMs) > 0 -> watchNext(api, item, WatchNextPrograms.WATCH_NEXT_TYPE_CONTINUE, positionMs, durationMs, key)
                // Too early to be "started": leave whatever was there.
                else -> return@runCatching
            }
            val resolver = context.contentResolver
            when {
                program == null -> existing?.let { delete(context, it.id) }
                existing != null -> resolver.update(TvContract.buildWatchNextProgramUri(existing.id), program, null, null)
                else -> resolver.insert(WatchNextPrograms.CONTENT_URI, program)
            }
            if (BuildConfig.DEBUG) Log.d("Wicaby", "Watch Next $key -> ${program?.getAsInteger(WatchNextPrograms.COLUMN_WATCH_NEXT_TYPE) ?: "removed"}")
        }.onFailure { if (BuildConfig.DEBUG) Log.w("Wicaby", "Watch Next", it) }
    }

    @RequiresApi(26)
    private fun watchNext(api: Api, item: Item, type: Int, positionMs: Long, durationMs: Long, key: String) =
        program(api, item, playUri(item.id), positionMs, durationMs, key).apply {
            put(WatchNextPrograms.COLUMN_WATCH_NEXT_TYPE, type)
            put(WatchNextPrograms.COLUMN_LAST_ENGAGEMENT_TIME_UTC_MILLIS, System.currentTimeMillis())
        }

    // The columns Watch Next and preview programs share (TvContract.PreviewPrograms has the same names);
    // the same ones androidx.tvprovider's WatchNextProgram.toContentValues() wrote on API 26+.
    @RequiresApi(26)
    fun program(api: Api, item: Item, link: Uri, positionMs: Long, durationMs: Long, key: String): ContentValues {
        val intent = Intent(Intent.ACTION_VIEW, link).setClassName(BuildConfig.APPLICATION_ID, MainActivity::class.java.name)
        return ContentValues().apply {
            put(
                WatchNextPrograms.COLUMN_TYPE,
                when {
                    item.isEpisode -> WatchNextPrograms.TYPE_TV_EPISODE
                    item.type == "Series" -> WatchNextPrograms.TYPE_TV_SERIES
                    else -> WatchNextPrograms.TYPE_MOVIE
                },
            )
            put(WatchNextPrograms.COLUMN_TITLE, item.seriesName ?: item.name)
            if (item.isEpisode) {
                put(WatchNextPrograms.COLUMN_EPISODE_TITLE, item.name)
                item.parentIndexNumber?.let { put(WatchNextPrograms.COLUMN_SEASON_DISPLAY_NUMBER, it.toString()) }
                item.indexNumber?.let { put(WatchNextPrograms.COLUMN_EPISODE_DISPLAY_NUMBER, it.toString()) }
            }
            put(WatchNextPrograms.COLUMN_SHORT_DESCRIPTION, item.overview)
            put(WatchNextPrograms.COLUMN_POSTER_ART_URI, api.thumb(item, 640))
            put(WatchNextPrograms.COLUMN_POSTER_ART_ASPECT_RATIO, WatchNextPrograms.ASPECT_RATIO_16_9)
            put(WatchNextPrograms.COLUMN_LAST_PLAYBACK_POSITION_MILLIS, positionMs.toInt())
            put(WatchNextPrograms.COLUMN_DURATION_MILLIS, durationMs.toInt())
            put(WatchNextPrograms.COLUMN_INTERNAL_PROVIDER_ID, key)
            put(WatchNextPrograms.COLUMN_INTENT_URI, intent.toUri(Intent.URI_INTENT_SCHEME))
        }
    }

    @RequiresApi(26)
    private fun find(context: Context, key: String): Row? =
        context.contentResolver.query(
            WatchNextPrograms.CONTENT_URI,
            arrayOf(WatchNextPrograms._ID, WatchNextPrograms.COLUMN_INTERNAL_PROVIDER_ID, WatchNextPrograms.COLUMN_BROWSABLE),
            null, null, null,
        )?.use { c ->
            while (c.moveToNext()) {
                if (c.getString(1) == key) return@use Row(c.getLong(0), browsable = c.isNull(2) || c.getInt(2) == 1)
            }
            null
        }

    @RequiresApi(26)
    private fun delete(context: Context, id: Long) {
        context.contentResolver.delete(TvContract.buildWatchNextProgramUri(id), null, null)
    }

    // Sign-out: the next user must not inherit this one's row. The provider only lets us touch our own programs.
    suspend fun clear(context: Context) = withContext(Dispatchers.IO) {
        if (supported(context)) runCatching { context.contentResolver.delete(WatchNextPrograms.CONTENT_URI, null, null) }
    }
}
