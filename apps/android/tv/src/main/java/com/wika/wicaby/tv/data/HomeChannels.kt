package com.wika.wicaby.tv.data

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.media.tv.TvContract
import android.media.tv.TvContract.Channels
import android.media.tv.TvContract.PreviewPrograms
import android.net.Uri
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.graphics.drawable.toBitmap
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.tv.BuildConfig
import com.wika.wicaby.tv.MainActivity
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.Wicaby
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// The launcher's preview channels on the Android TV home: "À suivre" and "Ajouts récents".
// Programs use the same columns as Watch Next (WatchNext.program). Synced when a session starts
// or changes and after each playback (MainActivity, PlayerActivity); emptied with the session.
// shortcut: no background refresh, so Recently Added only moves when the app is used; add a WorkManager job if that matters.
object HomeChannels {
    const val SIZE = 20

    private class Row(val key: String, val title: Int, val load: suspend (Api) -> List<Item>, val link: (String) -> Uri)

    private val VIDEO_TYPES = setOf("Movie", "Series", "Episode")
    private val rows = listOf(
        Row("wicaby.nextup", R.string.next_up, { it.nextUp(limit = SIZE) }, WatchNext::playUri),
        // Films, series and episodes only: Latest also lists albums or books, which open nowhere useful from the home.
        Row("wicaby.latest", R.string.row_latest, { api -> api.latest().filter { it.type in VIDEO_TYPES } }, WatchNext::openUri),
    )

    // Returns the channels this sync created that the viewer still has to approve.
    suspend fun sync(context: Context, api: Api): List<Long> = withContext(Dispatchers.IO) {
        if (!WatchNext.supported(context)) return@withContext emptyList()
        // OB-X: turned off in the wizard or Réglages > Interface: the rows stay empty.
        if (!TvSettings.homeChannels.value) return@withContext emptyList<Long>().also { clear(context) }
        val loads = rows.map { runCatching { it.load(api) } }
        // Signed out (or switched user) during the loads: clear() already ran, don't bring the old rows back.
        if (Wicaby.app.api !== api) return@withContext emptyList()
        val names = AppLanguage.localized(context)
        val mine = runCatching { channels(context) }.getOrElse { return@withContext emptyList() }
        var first = mine.isEmpty()
        rows.zip(loads).mapNotNull { (row, result) ->
            runCatching {
                val existing = mine[row.key]
                if (missing(result)) existing?.let { context.contentResolver.delete(TvContract.buildChannelUri(it), null, null) }
                val items = shown(result) ?: return@runCatching null
                val id = existing ?: create(context, row, names.getString(row.title))
                fill(context, api, row, id, items)
                // Only a package's first browsable request is granted for sure; the others go through the viewer (MainActivity).
                when {
                    existing != null -> null
                    first -> null.also { first = false; TvContract.requestChannelBrowsable(context, id) }
                    else -> id
                }
            }.onFailure { if (BuildConfig.DEBUG) Log.w("Wicaby", "Home channel ${row.key}", it) }.getOrNull()
        }
    }

    // Sign-out: the rows empty but the channels stay, so the launcher keeps the viewer's approval for the next session.
    suspend fun clear(context: Context) = withContext(Dispatchers.IO) {
        if (!WatchNext.supported(context)) return@withContext
        runCatching {
            val mine = channels(context)
            for (row in rows) mine[row.key]?.let { context.contentResolver.delete(TvContract.buildPreviewProgramsUriForChannel(it), null, null) }
        }
    }

    @RequiresApi(26)
    private fun create(context: Context, row: Row, name: String): Long {
        val channel = ContentValues().apply {
            put(Channels.COLUMN_TYPE, Channels.TYPE_PREVIEW)
            put(Channels.COLUMN_DISPLAY_NAME, name)
            put(Channels.COLUMN_INTERNAL_PROVIDER_ID, row.key)
            put(Channels.COLUMN_APP_LINK_INTENT_URI, Intent(context, MainActivity::class.java).toUri(Intent.URI_INTENT_SCHEME))
        }
        val id = ContentUris.parseId(context.contentResolver.insert(Channels.CONTENT_URI, channel) ?: error("channel insert refused"))
        storeLogo(context, id)
        return id
    }

    // An empty list keeps the channel (the launcher hides a channel without programs): deleting it would lose its approval.
    @RequiresApi(26)
    private fun fill(context: Context, api: Api, row: Row, id: Long, items: List<Item>) {
        val resolver = context.contentResolver
        // shortcut: the row is rewritten each time, so a program the viewer hid comes back; diff by item id if anyone minds.
        resolver.delete(TvContract.buildPreviewProgramsUriForChannel(id), null, null)
        val programs = items.mapIndexed { i, item ->
            WatchNext.program(api, item, row.link(item.id), item.resumeMs, item.runTimeTicks?.div(TICKS_PER_MS) ?: 0, item.id).apply {
                put(PreviewPrograms.COLUMN_CHANNEL_ID, id)
                // The launcher sorts by weight, highest first: keep the server's order.
                put(PreviewPrograms.COLUMN_WEIGHT, items.size - i)
            }
        }
        resolver.bulkInsert(PreviewPrograms.CONTENT_URI, programs.toTypedArray())
        if (BuildConfig.DEBUG) Log.d("Wicaby", "Home channel ${row.key} -> ${programs.size}")
    }

    @RequiresApi(26)
    private fun channels(context: Context): Map<String, Long> =
        context.contentResolver.query(Channels.CONTENT_URI, arrayOf(Channels._ID, Channels.COLUMN_INTERNAL_PROVIDER_ID), null, null, null)?.use { c ->
            buildMap { while (c.moveToNext()) c.getString(1)?.let { put(it, c.getLong(0)) } }
        }.orEmpty()

    // The launcher shows it at the start of the row.
    @RequiresApi(26)
    private fun storeLogo(context: Context, id: Long) = runCatching {
        val icon = context.packageManager.getApplicationIcon(context.applicationInfo).toBitmap(256, 256)
        context.contentResolver.openOutputStream(TvContract.buildChannelLogoUri(id))?.use { icon.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}

// What a channel shows after a load: the items, or null when the load failed (offline, server busy,
// no such endpoint): keep the row as it is.
internal fun shown(result: Result<List<Item>>): List<Item>? = result.getOrNull()?.take(HomeChannels.SIZE)

// A 404: this server has no such endpoint, so the channel goes.
internal fun missing(result: Result<List<Item>>): Boolean = (result.exceptionOrNull() as? ApiException)?.status == 404
