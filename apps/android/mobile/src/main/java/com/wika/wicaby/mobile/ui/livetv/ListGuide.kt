package com.wika.wicaby.mobile.ui.livetv

import android.graphics.Bitmap
import android.widget.Toast
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.ripple
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import coil3.request.allowHardware
import coil3.request.crossfade
import coil3.request.transformations
import coil3.size.Size
import coil3.transform.Transformation
import com.wika.wicaby.core.livetv.ChannelRow
import com.wika.wicaby.core.livetv.ClientGroup
import com.wika.wicaby.core.livetv.Daypart
import com.wika.wicaby.core.livetv.GuideClock
import com.wika.wicaby.core.livetv.HOUR
import com.wika.wicaby.core.livetv.LensRef
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.PrefField
import com.wika.wicaby.core.livetv.ProgramLite
import com.wika.wicaby.core.livetv.Viewport
import com.wika.wicaby.core.livetv.programAt
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.ui.Centered
import com.wika.wicaby.mobile.ui.Chip
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.LocalAccent
import com.wika.wicaby.mobile.ui.PillButton
import com.wika.wicaby.mobile.ui.Radius
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.WicabyField
import com.wika.wicaby.mobile.ui.dpPx
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.util.TimeZone
import java.util.concurrent.ConcurrentHashMap
import com.wika.wicaby.core.R as CoreR

// The phone guide (spec §3.2): the channel list with now and next at a chosen time, the lens bar and
// the "Maintenant ▾" time chip. The rows (channelItems) are shared with the En direct tab.

/** The window each row reads: the programme at t and the one after it (one 2-slab tile per 25 channels). */
const val ROW_WINDOW_MS = 2 * HOUR

@Composable
fun ListGuide(repo: LiveTvRepository, onAgenda: (String) -> Unit) {
    val rows by repo.rows.collectAsState()
    val lenses by repo.lenses.collectAsState()
    val prefs by repo.prefs.prefs.collectAsState()
    val ver by repo.guideVersion.collectAsState()
    val now by rememberNow(repo)
    val clock = remember { GuideClock(TimeZone.getDefault()) }
    var part by rememberSaveable { mutableStateOf<String?>(null) }
    var picks by remember { mutableIntStateOf(0) }
    val t = Daypart.fromId(part)?.let { clock.daypartTime(clock.dayStart(now), it) } ?: now
    val list = rememberLazyListState()
    LaunchedEffect(prefs.lens) { list.scrollToItem(0) }

    Column(Modifier.fillMaxSize()) {
        LazyRow(contentPadding = PaddingValues(horizontal = 20.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item("time") { TimeChip(clock, now, part) { part = it; picks++ } }
            items(lenses, key = { lensKey(it) }) { l ->
                Chip(lensLabel(l, prefs.groups), selected = l == prefs.lens) { repo.prefs.update(PrefField.LENS, prefs.copy(lens = l)) }
            }
        }
        if (rows.isEmpty()) {
            Centered { Text(stringResource(CoreR.string.livetv_lens_empty), style = Type.body, color = G.label2, textAlign = TextAlign.Center, modifier = Modifier.padding(32.dp)) }
            return@Column
        }
        // M-4: a tablet in landscape gets the grid.
        if (useTabletGrid()) {
            TabletGuide(repo, rows, part, picks, onAgenda)
            return@Column
        }
        RowsViewport(repo, list, rows, t, offset = 0)
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = 24.dp)) {
            channelItems(repo, rows, t, live = part == null, ver = ver, onAgenda = onAgenda)
        }
    }
}

private fun lensKey(l: LensRef): String = when (l) {
    is LensRef.Tag -> "tag:${l.tag}"
    is LensRef.Group -> "group:${l.id}"
    else -> l.toString()
}

@Composable
private fun lensLabel(l: LensRef, groups: List<ClientGroup>): String = when (l) {
    LensRef.All -> stringResource(CoreR.string.livetv_lens_all)
    LensRef.Favorites -> stringResource(CoreR.string.livetv_lens_favorites)
    LensRef.Recents -> stringResource(CoreR.string.livetv_lens_recents)
    LensRef.Radio -> stringResource(CoreR.string.livetv_lens_radio)
    is LensRef.Tag -> l.tag // server data, never translated
    is LensRef.Group -> groups.firstOrNull { it.id == l.id }?.name ?: l.id
}

private val DAYPART_LABELS = mapOf(
    Daypart.MORNING to R.string.livetv_guide_dayparts_morning,
    Daypart.AFTERNOON to R.string.livetv_guide_dayparts_afternoon,
    Daypart.EVENING to R.string.livetv_guide_dayparts_evening,
    Daypart.TONIGHT to R.string.livetv_guide_dayparts_tonight,
    Daypart.NIGHT to R.string.livetv_guide_dayparts_night,
)

/** "Maintenant ▾": shifts the list to one of today's dayparts still ahead. */
@Composable
private fun TimeChip(clock: GuideClock, now: Long, part: String?, onPick: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val fmt = rememberTimeFormat()
    val today = clock.dayStart(now)
    val label = Daypart.fromId(part)?.let { stringResource(DAYPART_LABELS.getValue(it)) } ?: stringResource(R.string.livetv_guide_dayparts_now)
    Box {
        Chip(label, selected = true, icon = Ic.ChevronDown) { open = true }
        DropdownMenu(open, { open = false }, containerColor = G.elevated2, shape = RoundedCornerShape(Radius.md)) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.livetv_guide_dayparts_now), style = Type.body, color = G.label) },
                trailingIcon = { if (part == null) Icon(Ic.Check, null, tint = LocalAccent.current, modifier = Modifier.size(18.dp)) },
                onClick = { onPick(null); open = false },
            )
            for (p in Daypart.entries) {
                val at = clock.daypartTime(today, p)
                if (at <= now) continue
                DropdownMenuItem(
                    text = { Text(stringResource(DAYPART_LABELS.getValue(p)), style = Type.body, color = G.label) },
                    trailingIcon = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(fmt(at), style = Type.mono, color = G.label2)
                            if (part == p.id) Icon(Ic.Check, null, tint = LocalAccent.current, modifier = Modifier.padding(start = 8.dp).size(18.dp))
                        }
                    },
                    onClick = { onPick(p.id); open = false },
                )
            }
        }
    }
}

/**
 * Feeds the repository's tile planner with the rows on screen (rows start at list index [offset]),
 * widened to whole tiles of `tileChannels` rows so each request carries a full tile; the planner adds
 * the next tile ahead. Mid-fling a tile is only published once the list stays on it (§16 request
 * budget). After 2 s without a change it adds the idle "now" prefetch (§6.3 P3).
 */
@Composable
fun RowsViewport(repo: LiveTvRepository, list: LazyListState, rows: List<ChannelRow>, t: Long, offset: Int) {
    val ids = remember(rows) { rows.map { it.id } }
    // A list never scrolls in time, and rows go by whole tiles: no time or row overscan.
    val tuning = remember(repo) { repo.tuning.copy(rowOverscan = 0, timeOverscanMin = 0) }
    LaunchedEffect(repo, list, ids, t) {
        if (ids.isEmpty()) return@LaunchedEffect
        val tc = maxOf(1, tuning.tileChannels)
        snapshotFlow {
            val first = list.firstVisibleItemIndex - offset
            val f = first.coerceIn(0, ids.lastIndex)
            val l = (first + list.layoutInfo.visibleItemsInfo.size - 1).coerceIn(f, ids.lastIndex)
            f / tc to l / tc
        }.collectLatest { (a, b) ->
            if (list.isScrollInProgress) delay(TILE_SETTLE_MS)
            val v = Viewport(ids, a * tc, minOf(ids.lastIndex, b * tc + tc - 1), t, t + ROW_WINDOW_MS, tuning)
            repo.setViewport(v)
            delay(2_000)
            repo.setViewport(v, idle = true)
        }
    }
}

/** A tile scrolled past faster than this during a fling is never requested. */
private const val TILE_SETTLE_MS = 250L

/**
 * The channel rows of [rows] at time [t] (programme at t, then the next one). [live]: t is now (progress
 * shown). [ver] is the repository's guideVersion, read once by the list rather than once per row.
 */
fun LazyListScope.channelItems(repo: LiveTvRepository, rows: List<ChannelRow>, t: Long, live: Boolean, ver: Long, onAgenda: (String) -> Unit) {
    items(rows, key = { "ch-" + it.id }, contentType = { "channel" }) { ch ->
        val progs = remember(ch.id, t, ver) { repo.programs(ch.id, t, t + ROW_WINDOW_MS) }
        val cur = programAt(progs, t)
        val next = progs.firstOrNull { it.start >= (cur?.end ?: t) }
        val failed = cur == null && repo.rowFailed(ch.id, t, t + ROW_WINDOW_MS)
        ChannelLine(repo, ch, cur, next, if (live) t else null, failed, onAgenda)
    }
}

/** Row height (§21.7): max(60 dp, 2 lines × lineHeight × fontScale + 12 dp), clamped to 84 dp; [twoLines] false at the clamp. */
data class RowSpec(val height: Dp, val twoLines: Boolean)

fun rowSpec(lineHeight: Dp): RowSpec {
    val want = lineHeight * 2 + 12.dp
    return RowSpec(want.coerceIn(60.dp, 84.dp), want <= 84.dp)
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChannelLine(repo: LiveTvRepository, ch: ChannelRow, cur: ProgramLite?, next: ProgramLite?, now: Long?, failed: Boolean, onAgenda: (String) -> Unit) {
    val context = LocalContext.current
    val fmt = rememberTimeFormat()
    val density = LocalDensity.current
    val spec = remember(density) { rowSpec(with(density) { Type.headline.lineHeight.toDp() }) }
    var menu by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.fillMaxWidth().height(spec.height)
                .combinedClickable(role = Role.Button, onClick = { onAgenda(ch.id) }, onLongClick = { menu = true })
                .padding(start = 20.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ChannelLogo(repo, ch, 36.dp, Modifier.width(76.dp), nameLines = if (spec.twoLines) 2 else 1)
            Column(Modifier.weight(1f).padding(start = 12.dp)) {
                when {
                    cur != null -> Text(cur.title, style = Type.headline, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    failed -> Text(
                        stringResource(CoreR.string.livetv_guide_retry), style = Type.callout, color = G.label2,
                        modifier = Modifier.clip(CircleShape).clickable(role = Role.Button) { repo.retryRow(ch.id) },
                    )
                    else -> Text(stringResource(CoreR.string.livetv_guide_no_info), style = Type.callout, color = G.label2, maxLines = 1)
                }
                // 1 + 2 + 1 dp fits in the 4 dp a footnote line leaves under a headline line.
                if (cur != null && now != null) ProgramProgress(cur, now, Modifier.padding(vertical = 1.dp).width(120.dp))
                if (next != null && spec.twoLines) {
                    Text("${fmt(next.start)}  ${next.title}", style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            val watch = stringResource(R.string.livetv_sheet_watch_channel)
            Box(
                // An unbounded ripple instead of a clip: no clip path per row on the render thread.
                Modifier.size(48.dp).clickable(null, ripple(bounded = false, radius = 24.dp), role = Role.Button) { tune(context, repo, ch.id) },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Ic.Play, contentDescription = watch, tint = G.label2, modifier = Modifier.size(20.dp))
            }
        }
        // Composed only once opened: a closed menu per row costs every row on the scroll path.
        if (menu) ChannelMenu(repo, ch, onDismiss = { menu = false }, onAgenda = onAgenda)
    }
}

/** Long-press (§10.3): favourite, hide, group, agenda. */
@Composable
internal fun ChannelMenu(repo: LiveTvRepository, ch: ChannelRow, onDismiss: () -> Unit, onAgenda: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val unavailable = stringResource(CoreR.string.livetv_toasts_favorites_unavailable)
    val hiddenToast = stringResource(CoreR.string.livetv_channel_hidden_toast)
    var groups by remember { mutableStateOf(false) }
    if (groups) {
        GroupDialog(repo, ch, onDismiss)
        return
    }
    DropdownMenu(true, onDismiss, containerColor = G.elevated2, shape = RoundedCornerShape(Radius.md)) {
        DropdownMenuItem(
            text = { Text(stringResource(if (ch.favorite) CoreR.string.livetv_channel_favorite_remove else CoreR.string.livetv_channel_favorite_add), style = Type.body, color = G.label) },
            onClick = {
                onDismiss()
                scope.launch { if (!repo.setFavorite(ch.id, !ch.favorite)) Toast.makeText(context, unavailable, Toast.LENGTH_SHORT).show() }
            },
        )
        DropdownMenuItem(
            text = { Text(stringResource(R.string.livetv_channel_hide), style = Type.body, color = G.label) },
            onClick = {
                onDismiss()
                val p = repo.prefs.prefs.value
                if (ch.id !in p.hidden) repo.prefs.update(PrefField.HIDDEN, p.copy(hidden = p.hidden + ch.id))
                Toast.makeText(context, hiddenToast, Toast.LENGTH_SHORT).show()
            },
        )
        DropdownMenuItem(
            text = { Text(stringResource(R.string.livetv_channel_add_to_group), style = Type.body, color = G.label) },
            onClick = { groups = true },
        )
        DropdownMenuItem(
            text = { Text(stringResource(R.string.livetv_channel_agenda), style = Type.body, color = G.label) },
            onClick = { onDismiss(); onAgenda(ch.id) },
        )
    }
}

/** "Ajouter à un groupe…": toggles the channel in each client group, or makes a new group holding it (server tags stay read-only). */
@Composable
private fun GroupDialog(repo: LiveTvRepository, ch: ChannelRow, onDismiss: () -> Unit) {
    val prefs by repo.prefs.prefs.collectAsState()
    var name by remember { mutableStateOf("") }
    fun create() {
        val n = name.trim()
        if (n.isEmpty()) return
        // Same id shape as the desktop store (createGroup).
        val id = "g" + System.currentTimeMillis().toString(36) + (0 until 4).map { "0123456789abcdefghijklmnopqrstuvwxyz".random() }.joinToString("")
        val p = repo.prefs.prefs.value
        repo.prefs.update(PrefField.GROUPS, p.copy(groups = p.groups + ClientGroup(id, n, listOf(ch.id))))
        onDismiss()
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = G.elevated2,
        shape = RoundedCornerShape(Radius.lg),
        title = { Text(stringResource(R.string.livetv_channel_add_to_group), style = Type.title3, color = G.label) },
        text = {
            Column {
                for (g in prefs.groups) {
                    val member = ch.id in g.ids
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.sm))
                            .toggleable(member, role = Role.Checkbox) { on ->
                                val p = repo.prefs.prefs.value
                                repo.prefs.update(PrefField.GROUPS, p.copy(groups = p.groups.map { if (it.id == g.id) it.copy(ids = if (on) it.ids - ch.id + ch.id else it.ids - ch.id) else it }))
                            }
                            .padding(horizontal = 4.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(g.name, style = Type.body, color = G.label, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (member) Icon(Ic.Check, null, tint = G.label, modifier = Modifier.size(18.dp))
                    }
                }
                WicabyField(name, { name = it }, stringResource(R.string.livetv_manage_group_name), Modifier.padding(top = 8.dp), onSubmit = ::create)
            }
        },
        confirmButton = { PillButton(stringResource(R.string.livetv_manage_new_group), ::create, icon = Ic.Plus, primary = name.isNotBlank(), compact = true) },
    )
}

/** Elapsed part of the airing programme: monochrome, `label` at 60 % (§11). */
@Composable
fun ProgramProgress(p: ProgramLite, now: Long, modifier: Modifier = Modifier) {
    val f = ((now - p.start).toFloat() / (p.end - p.start).coerceAtLeast(1)).coerceIn(0f, 1f)
    Box(modifier.height(2.dp).background(G.fill3, CircleShape)) {
        Box(Modifier.fillMaxWidth(f).fillMaxHeight().background(G.label.copy(alpha = 0.6f), CircleShape))
    }
}

// ---- Logos (§21.2 F1, §21.9) ----

/** Logo tag → dark (needs the light plate). Measured once per tag. */
private val darkLogos = ConcurrentHashMap<String, Boolean>()

/**
 * Measures a logo the first time it decodes, on Coil's decode thread (never the main thread), then
 * hands back a hardware copy so the render thread never uploads it mid-fling.
 */
private class LumaProbe(private val tag: String) : Transformation() {
    override val cacheKey = "luma-probe"
    override suspend fun transform(input: Bitmap, size: Size): Bitmap {
        darkLogos.getOrPut(tag) { runCatching { isDarkLogo(input) }.getOrDefault(false) }
        return input.copy(Bitmap.Config.HARDWARE, false) ?: input
    }
}

/** Alpha-weighted mean luminance of a 16 × 16 downscale, as the desktop guide measures it. */
private fun isDarkLogo(src: Bitmap): Boolean {
    val small = Bitmap.createScaledBitmap(src, 16, 16, true)
    val px = IntArray(256)
    small.getPixels(px, 0, 16, 0, 0, 16, 16)
    var sum = 0.0
    var n = 0.0
    for (c in px) {
        val a = (c ushr 24) / 255.0
        sum += a * (0.2126 * ((c shr 16) and 0xFF) + 0.7152 * ((c shr 8) and 0xFF) + 0.0722 * (c and 0xFF)) / 255.0
        n += a
    }
    return n > 0 && sum / n < 0.3
}

/**
 * A channel logo [height] tall, asked server-resized (maxHeight = slot, maxWidth = 2 × slot); a dark
 * logo sits on a `label`-at-85 % plate. No logo (or a failed one): the number (mono, unless [showNumber] is off) above the name.
 */
@Composable
fun ChannelLogo(repo: LiveTvRepository, ch: ChannelRow, height: Dp, modifier: Modifier = Modifier, nameLines: Int = 2, showNumber: Boolean = true) {
    val tag = ch.logoTag
    var failed by remember(ch.id, tag) { mutableStateOf(false) }
    if (tag == null || failed) {
        Column(modifier) {
            if (showNumber && ch.number.isNotEmpty()) Text(ch.number, style = Type.mono, color = G.label2, maxLines = 1)
            Text(ch.name, style = Type.caption, color = G.label, maxLines = nameLines, overflow = TextOverflow.Ellipsis)
        }
        return
    }
    val context = LocalContext.current
    val px = dpPx(height)
    var dark by remember(tag) { mutableStateOf(darkLogos[tag]) }
    val request = remember(ch.id, tag, px) {
        ImageRequest.Builder(context)
            .data(repo.api.api.image(ch.id, "Primary", tag, maxWidth = px * 2, maxHeight = px))
            // No crossfade, as on TV: a fade that starts while the row scrolls can stall part-way, leaving the slot blank (M-4).
            .crossfade(false)
            // Unmeasured: a software bitmap for the probe. Measured: a hardware bitmap.
            .apply { if (darkLogos[tag] == null) allowHardware(false).transformations(LumaProbe(tag)) }
            .build()
    }
    Box(modifier.height(height), contentAlignment = Alignment.CenterStart) {
        AsyncImage(
            request,
            contentDescription = stringResource(R.string.livetv_channel_logo_alt, ch.name),
            contentScale = ContentScale.Fit,
            alignment = Alignment.CenterStart,
            onSuccess = { if (dark == null) dark = darkLogos[tag] },
            onError = { failed = true },
            // A fixed 2:1 slot, as on TV: sized from the painter, a logo landing mid-scroll could keep a 0-wide box (M-4).
            modifier = (if (dark == true) Modifier.background(G.label.copy(alpha = 0.85f), RoundedCornerShape(Radius.xs)).padding(horizontal = 6.dp, vertical = 3.dp) else Modifier).fillMaxHeight().aspectRatio(2f, matchHeightConstraintsFirst = true),
        )
    }
}
