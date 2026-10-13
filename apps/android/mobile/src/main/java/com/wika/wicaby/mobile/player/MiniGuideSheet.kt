package com.wika.wicaby.mobile.player

import android.os.Build
import android.view.accessibility.AccessibilityManager
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.livetv.ChannelRow
import com.wika.wicaby.core.livetv.LensRef
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.PrefField
import com.wika.wicaby.core.livetv.programAt
import com.wika.wicaby.mobile.ui.Chip
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Radius
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.livetv.ChannelLogo
import com.wika.wicaby.mobile.ui.livetv.ProgramProgress
import com.wika.wicaby.mobile.ui.livetv.ROW_WINDOW_MS
import com.wika.wicaby.mobile.ui.livetv.RowsViewport
import com.wika.wicaby.mobile.ui.livetv.rememberNow
import com.wika.wicaby.mobile.ui.livetv.rememberTimeFormat
import kotlinx.coroutines.delay
import com.wika.wicaby.core.R as CoreR

// The mini-guide over the video on mobile (spec §8.6, §10.3): a bottom sheet at half height, dragged up
// to full height. The lens chips switch the zap list too; a tap tunes and the sheet stays 1.5 s so
// several channels can be sampled; 10 s without a touch closes it.

private const val TUNE_LINGER_MS = 1_500L
private const val IDLE_CLOSE_MS = 10_000

@Composable
fun BoxScope.MiniGuideSheet(visible: Boolean, repo: LiveTvRepository, currentId: String?, onTune: (String) -> Unit, onClose: () -> Unit) {
    AnimatedVisibility(visible, enter = fadeIn(tween(180)), exit = fadeOut(tween(180))) {
        Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.35f)).clickable(interactionSource = null, indication = null, onClick = onClose))
    }
    AnimatedVisibility(
        visible,
        enter = slideInVertically(tween(300)) { it } + fadeIn(tween(200)),
        exit = slideOutVertically(tween(240)) { it } + fadeOut(tween(200)),
        modifier = Modifier.align(Alignment.BottomCenter),
    ) {
        Sheet(repo, currentId, onTune, onClose)
    }
}

@Composable
private fun Sheet(repo: LiveTvRepository, currentId: String?, onTune: (String) -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    val rows by repo.rows.collectAsState()
    val lenses by repo.lenses.collectAsState()
    val prefs by repo.prefs.prefs.collectAsState()
    val ver by repo.guideVersion.collectAsState()
    val now by rememberNow(repo)
    var full by remember { mutableStateOf(false) }
    var touch by remember { mutableIntStateOf(0) }
    var tunedAt by remember { mutableStateOf<Long?>(null) }
    val idle = remember {
        // WCAG 2.2.1: the user's accessibility timeout when longer.
        val am = context.getSystemService(AccessibilityManager::class.java)
        if (Build.VERSION.SDK_INT >= 29 && am != null) am.getRecommendedTimeoutMillis(IDLE_CLOSE_MS, AccessibilityManager.FLAG_CONTENT_CONTROLS or AccessibilityManager.FLAG_CONTENT_TEXT).toLong() else IDLE_CLOSE_MS.toLong()
    }
    LaunchedEffect(touch, tunedAt) {
        delay(if (tunedAt != null) TUNE_LINGER_MS else idle)
        onClose()
    }
    val start = remember { rows.indexOfFirst { it.id == currentId }.coerceAtLeast(0) }
    // Centred on the current channel: one row above it shows.
    val list = rememberLazyListState(initialFirstVisibleItemIndex = (start - 1).coerceAtLeast(0))
    LaunchedEffect(prefs.lens) { if (list.firstVisibleItemIndex >= rows.size) list.scrollToItem(0) }
    LaunchedEffect(list.isScrollInProgress) { touch++ }
    RowsViewport(repo, list, rows, now, offset = 0)

    Column(
        Modifier
            .widthIn(max = 680.dp)
            .fillMaxWidth()
            .fillMaxHeight(if (full) 0.94f else 0.5f)
            .clip(RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl))
            .background(G.elevated)
            .clickable(interactionSource = null, indication = null) { touch++ },
    ) {
        // The handle: drag up for full height, down to half height then closed.
        Box(
            Modifier.fillMaxWidth().height(24.dp).pointerInput(Unit) {
                var dy = 0f
                detectVerticalDragGestures(
                    onDragStart = { dy = 0f },
                    onDragEnd = {
                        touch++
                        when {
                            dy < -24.dp.toPx() -> full = true
                            dy > 24.dp.toPx() -> if (full) full = false else onClose()
                        }
                    },
                ) { c, d ->
                    c.consume()
                    dy += d
                }
            },
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.width(36.dp).height(4.dp).clip(CircleShape).background(G.fill4))
        }
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(lenses, key = { it.toString() }) { l ->
                Chip(lensLabel(l, prefs), selected = l == prefs.lens) {
                    touch++
                    repo.prefs.update(PrefField.LENS, prefs.copy(lens = l))
                }
            }
        }
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(vertical = 6.dp)) {
            items(rows, key = { it.id }, contentType = { "channel" }) { ch ->
                MiniRow(repo, ch, ch.id == currentId, now, ver) {
                    onTune(ch.id)
                    tunedAt = System.nanoTime()
                }
            }
        }
    }
}

@Composable
private fun lensLabel(l: LensRef, prefs: com.wika.wicaby.core.livetv.LiveTvPrefs): String = when (l) {
    LensRef.All -> stringResource(CoreR.string.livetv_lens_all)
    LensRef.Favorites -> stringResource(CoreR.string.livetv_lens_favorites)
    LensRef.Recents -> stringResource(CoreR.string.livetv_lens_recents)
    LensRef.Radio -> stringResource(CoreR.string.livetv_lens_radio)
    is LensRef.Tag -> l.tag // server data, never translated
    is LensRef.Group -> prefs.groups.firstOrNull { it.id == l.id }?.name ?: l.id
}

/** Number, logo, name, now title with progress, end time; the current channel carries a 3 dp bar. */
@Composable
private fun MiniRow(repo: LiveTvRepository, ch: ChannelRow, current: Boolean, now: Long, ver: Long, onClick: () -> Unit) {
    val fmt = rememberTimeFormat()
    val cur = remember(ch.id, now, ver) { programAt(repo.programs(ch.id, now, now + ROW_WINDOW_MS), now) }
    Row(
        Modifier.fillMaxWidth().height(64.dp).clickable(role = Role.Button, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(if (current) G.label else androidx.compose.ui.graphics.Color.Transparent))
        Text(ch.number, style = Type.mono, color = G.label2, maxLines = 1, modifier = Modifier.padding(start = 13.dp).width(44.dp))
        ChannelLogo(repo, ch, 32.dp, Modifier.width(64.dp), nameLines = 1)
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(ch.name, style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(cur?.title ?: stringResource(CoreR.string.livetv_guide_no_info), style = Type.headline, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (cur != null) ProgramProgress(cur, now, Modifier.padding(top = 3.dp).width(120.dp))
        }
        if (cur != null) Text(fmt(cur.end), style = Type.mono, color = G.label2, modifier = Modifier.padding(end = 16.dp))
    }
}
