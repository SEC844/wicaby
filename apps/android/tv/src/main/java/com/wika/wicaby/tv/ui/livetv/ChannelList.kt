package com.wika.wicaby.tv.ui.livetv

import android.graphics.Bitmap
import android.text.format.DateFormat
import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import coil3.request.allowHardware
import coil3.toBitmap
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.livetv.ChannelRow
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.ProgramLite
import com.wika.wicaby.tv.BuildConfig
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.dpPx
import com.wika.wicaby.tv.ui.tvFocus
import java.util.Date

// The compact channel list of "Toutes les chaînes" (spec §3.1: number, logo, name, now title,
// progress, next; never a wall of tiles), and the pieces the other Live TV screens share:
// the channel logo (F1 plate, server-resized, decoded at slot size, §21.9) and now/next lookup.

internal const val LIVE_TAG = "WicabyLive"
private const val HOUR = 3_600_000L

/** F1: alpha-weighted mean luminance of a 16 × 16 downscale (same formula as the desktop logoPlate). */
internal fun darkLogo(px: IntArray): Boolean {
    var sum = 0.0
    var n = 0.0
    for (p in px) {
        val a = (p ushr 24) / 255.0
        sum += a * (0.2126 * (p shr 16 and 0xFF) + 0.7152 * (p shr 8 and 0xFF) + 0.0722 * (p and 0xFF)) / 255.0
        n += a
    }
    return n > 0 && sum / n < 0.3
}

private fun darkLogo(b: Bitmap): Boolean {
    val s = Bitmap.createScaledBitmap(b, 16, 16, true)
    val px = IntArray(256)
    s.getPixels(px, 0, 16, 0, 0, 16, 16)
    if (s !== b) s.recycle()
    return darkLogo(px)
}

/** The programme on air at [now] and the one after it, from the memory cache (main-thread safe). */
internal fun nowNext(repo: LiveTvRepository, channelId: String, now: Long): Pair<ProgramLite?, ProgramLite?> {
    val list = repo.programs(channelId, now, now + 6 * HOUR)
    val cur = list.firstOrNull { it.start <= now && it.end > now }
    val next = list.firstOrNull { it !== cur && it.start >= (cur?.end ?: now) }
    return cur to next
}

/** Live TV time plus the guide version: a new value when the clock ticks or a tile lands (cards re-read the cache). */
data class Tick(val now: Long, val version: Long)

internal fun progressOf(p: ProgramLite, now: Long): Float =
    if (p.end <= p.start) 0f else ((now - p.start).toFloat() / (p.end - p.start)).coerceIn(0f, 1f)

/** The system 12/24 h setting (§21.8), never a hard-coded pattern. */
@Composable
internal fun timeText(t: Long): String = DateFormat.getTimeFormat(LocalContext.current).format(Date(t))

/** Progress in the guide colours: `--label` at 60 % on a faint track (§11), never the accent. */
@Composable
internal fun LiveProgress(progress: Float, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(3.dp).clip(CircleShape).background(C.fill3)) {
        Box(Modifier.fillMaxWidth(progress).fillMaxHeight().clip(CircleShape).background(C.label.copy(alpha = 0.6f)))
    }
}

/**
 * A channel logo in a fixed [height] × 2 slot: asked from the server at slot size (`maxHeight`/`maxWidth`,
 * alpha kept), decoded at slot size by Coil (no crossfade), drawn on a light plate when it is dark (F1).
 * No logo: the number (mono) above the name, unless [fallback] is off (the list row already shows both).
 */
@Composable
fun ChannelLogo(api: Api, row: ChannelRow, height: Dp, modifier: Modifier = Modifier, fallback: Boolean = true) {
    val hPx = dpPx(height)
    val wPx = hPx * 2
    val tag = row.logoTag
    val key = "${row.id}|$tag"
    var failed by remember(key) { mutableStateOf(false) }
    Box(modifier.width(height * 2).height(height), contentAlignment = Alignment.Center) {
        if (tag == null || failed) {
            if (fallback) Column(horizontalAlignment = Alignment.CenterHorizontally) {
                if (row.number.isNotEmpty()) Text(row.number, style = Type.mono, color = C.label2, maxLines = 1)
                Text(row.name, style = Type.caption, color = C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
            }
            return@Box
        }
        var plate by remember(key) { mutableStateOf(LiveTv.plates[key] == true) }
        val context = LocalContext.current
        val request = remember(key, hPx) {
            val url = api.image(row.id, "Primary", tag, maxWidth = wPx, maxHeight = hPx)
            if (BuildConfig.DEBUG) Log.d(LIVE_TAG, "logo ${row.id} request size ${wPx}x$hPx")
            ImageRequest.Builder(context)
                .data(url)
                .size(wPx, hPx)
                .allowHardware(false) // the plate check reads pixels; logos are small
                .listener(
                    onError = { _, _ -> failed = true },
                    onSuccess = { _, r ->
                        val b = r.image.toBitmap()
                        if (BuildConfig.DEBUG) Log.d(LIVE_TAG, "logo ${row.id} decoded ${b.width}x${b.height} (slot ${wPx}x$hPx)")
                        plate = LiveTv.plates.getOrPut(key) { darkLogo(b) }
                    },
                )
                .build()
        }
        AsyncImage(
            request,
            contentDescription = stringResource(R.string.livetv_channel_logo_alt, row.name),
            imageLoader = LiveTv.logoLoader(context),
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize()
                .then(if (plate) Modifier.clip(RoundedCornerShape(Radius.xs)).background(C.label.copy(alpha = 0.85f)).padding(horizontal = 6.dp, vertical = 3.dp) else Modifier),
        )
    }
}

/** One row of the list: focus is `fill-4` + label, no scale (§11). OK tunes. */
@Composable
fun ChannelListRow(api: Api, repo: LiveTvRepository, row: ChannelRow, tick: Tick, onTune: () -> Unit, modifier: Modifier = Modifier) {
    val now = tick.now
    var focused by remember { mutableStateOf(false) }
    val (cur, next) = nowNext(repo, row.id, now)
    val label = stringResource(R.string.livetv_guide_aria_channel, row.number, row.name) + (cur?.let { ", ${it.title}" } ?: "")
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .tvFocus(RoundedCornerShape(Radius.sm), focusedScale = 1f, sheen = false, elevation = 0.dp, onFocusChange = { focused = it }, onClick = onTune)
            .background(if (focused) C.fill4 else C.fill1)
            .semantics(mergeDescendants = true) { contentDescription = label }
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(row.number, style = Type.mono, color = if (focused) C.label else C.label2, maxLines = 1, modifier = Modifier.width(52.dp))
        ChannelLogo(api, row, 40.dp, fallback = false)
        Column(Modifier.weight(1f)) {
            Text(row.name, style = Type.headline, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (cur != null) {
                Text(cur.title, style = Type.footnote, color = C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                LiveProgress(progressOf(cur, now), Modifier.padding(top = 5.dp).width(220.dp))
            }
        }
        Column(Modifier.width(320.dp)) {
            if (next != null) {
                Text(timeText(next.start), style = Type.mono, color = C.label3, maxLines = 1)
                Text(next.title, style = Type.footnote, color = C.label3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
