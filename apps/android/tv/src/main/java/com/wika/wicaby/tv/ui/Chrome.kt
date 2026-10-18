package com.wika.wicaby.tv.ui

import android.os.SystemClock
import android.text.format.DateFormat
import androidx.compose.ui.platform.LocalResources
import com.wika.wicaby.tv.data.AppLanguage
import com.wika.wicaby.tv.data.TvSettings
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.layout.Layout
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.User
import com.wika.wicaby.core.data.backdrop
import com.wika.wicaby.tv.R
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// ---------------------------------------------------------------------------
// Overlays: one layer above every screen (alerts, pickers, menus). The screens
// below get a material blur while one is open.

class OverlayHost {
    var content by mutableStateOf<(@Composable () -> Unit)?>(null)
        private set
    private var restore: FocusRequester? = null

    val open get() = content != null

    // Without an explicit target, focus returns to whatever tvFocus element had it.
    fun show(restoreTo: FocusRequester? = null, c: @Composable () -> Unit) {
        restore = restoreTo ?: LastFocus.requester
        content = c
    }

    // While true, the sheet's focus trap lets go, so focus can return to the screen below.
    var closing = false
        private set

    // Focus goes back first, while the sheet still exists: if the focused sheet vanished
    // first, the view would refocus its first child (the Accueil tab) and switch tabs.
    fun close() {
        closing = true
        val r = restore
        restore = null
        if (r != null) runCatching { r.requestFocus() }
        closing = false
        content = null
    }

}

val LocalOverlay = staticCompositionLocalOf { OverlayHost() }

@Composable
fun OverlayLayer(host: OverlayHost) {
    AnimatedVisibility(host.open, enter = fadeIn(tween(200)), exit = fadeOut(tween(160))) {
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.5f)))
    }
    host.content?.invoke()
}

// A floating material card that keeps focus until it is dismissed (Back or an action).
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun TvSheet(
    onDismiss: () -> Unit,
    alignment: Alignment = Alignment.Center,
    width: androidx.compose.ui.unit.Dp = 460.dp,
    padding: androidx.compose.foundation.layout.PaddingValues = androidx.compose.foundation.layout.PaddingValues(0.dp),
    // false while a layer of the same overlay sits above the card (a certificate prompt), so focus can go to it.
    trap: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    BackHandler(onBack = onDismiss)
    val host = LocalOverlay.current
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { shown = true }
    Box(Modifier.fillMaxSize().pointerInput(Unit) { detectTapGestures { onDismiss() } }.padding(padding), contentAlignment = alignment) {
        AnimatedVisibility(shown, enter = fadeIn(tween(220)) + scaleIn(spring(dampingRatio = 0.9f, stiffness = 500f), initialScale = 0.94f), exit = fadeOut() + scaleOut()) {
            Column(
                Modifier
                    .width(width)
                    .pointerInput(Unit) { detectTapGestures { } }
                    .clip(RoundedCornerShape(Radius.xl))
                    .background(C.elevated2.copy(alpha = 0.97f))
                    .focusProperties {
                        @Suppress("DEPRECATION")
                        exit = { if (host.closing || !trap) FocusRequester.Default else FocusRequester.Cancel }
                    }
                    .focusGroup()
                    .padding(28.dp),
                content = content,
            )
        }
    }
}

// tvOS alert: title, optional message, full-width stacked buttons.
class AlertAction(val label: String, val destructive: Boolean = false, val onClick: () -> Unit)

@Composable
fun TvAlert(title: String, message: String?, actions: List<AlertAction>, focusIndex: Int, onDismiss: () -> Unit) {
    TvSheet(onDismiss) {
        Text(title, style = Type.title2, color = C.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        if (message != null) {
            Text(message, style = Type.callout, color = C.label2, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
        }
        Spacer(Modifier.height(24.dp))
        val first = remember { FocusRequester() }
        LaunchedEffect(Unit) {
            delay(60)
            runCatching { first.requestFocus() }
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            actions.forEachIndexed { i, a ->
                SheetButton(a.label, onClick = a.onClick, modifier = if (i == focusIndex) Modifier.focusRequester(first) else Modifier)
            }
        }
    }
}

@Composable
fun SheetButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: ImageVector? = null, checked: Boolean = false, centered: Boolean = icon == null) {
    var focused by remember { mutableStateOf(false) }
    val bg = if (focused) TvFocus.bg else C.fill2
    val fg = if (focused) TvFocus.fg else C.label
    Row(
        modifier
            .fillMaxWidth()
            .tvFocus(RoundedCornerShape(Radius.md), focusedScale = 1.04f, sheen = false, elevation = 10.dp, onFocusChange = { focused = it }, onClick = onClick)
            .background(bg)
            .padding(horizontal = 20.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (icon != null) Icon(icon, null, tint = if (focused) TvFocus.fg else C.label2, modifier = Modifier.size(20.dp))
        Text(text, style = Type.headline, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f), textAlign = if (centered) TextAlign.Center else TextAlign.Start)
        if (!centered) Box(Modifier.size(18.dp)) { if (checked) Icon(Ic.Check, null, tint = if (focused) TvFocus.fg else C.label, modifier = Modifier.size(18.dp)) }
    }
}

// A list picker in a sheet; focus starts on the current value.
@Composable
fun TvPicker(title: String, options: List<String>, selected: Int, onSelect: (Int) -> Unit, onDismiss: () -> Unit, width: androidx.compose.ui.unit.Dp = 420.dp) {
    TvSheet(onDismiss, width = width) {
        Text(title, style = Type.title3, color = C.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(bottom = 18.dp))
        val first = remember { FocusRequester() }
        LaunchedEffect(Unit) {
            delay(60)
            runCatching { first.requestFocus() }
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            options.forEachIndexed { i, o ->
                SheetButton(
                    o, checked = i == selected, centered = false,
                    onClick = { onSelect(i); onDismiss() },
                    modifier = if (i == selected.coerceIn(options.indices)) Modifier.focusRequester(first) else Modifier,
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Clock, like the tvOS top-right corner.

// The UI language this screen resolved (the in-app choice, or the system's), for
// locale-aware number and date formatting. LocalResources (not LocalConfiguration) carries
// the activity's language override below API 33.
@Composable
fun uiLocale(): java.util.Locale = AppLanguage.localeOf(LocalResources.current.configuration)

// "15:05" or "3:05 PM": the UI language's pattern, in the system's 12/24-hour setting
// (re-read every minute, so a change applies without restarting).
@Composable
fun ClockText(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val locale = uiLocale()
    fun format(now: Long): String {
        val skeleton = if (DateFormat.is24HourFormat(context)) "Hm" else "hm"
        return java.text.SimpleDateFormat(DateFormat.getBestDateTimePattern(locale, skeleton), locale).format(java.util.Date(now))
    }
    val text by produceState(remember(locale) { format(System.currentTimeMillis()) }, locale) {
        while (true) {
            val now = System.currentTimeMillis()
            value = format(now)
            delay(60_000 - now % 60_000 + 50)
        }
    }
    Text(text, style = Type.headline.copy(fontSize = 17.sp), color = C.label, modifier = modifier)
}

// ---------------------------------------------------------------------------
// Top navigation: a floating material pill of text tabs (icons for Recherche and
// Réglages), a soft white indicator that slides to the selected tab, and the clock
// and the user's avatar on the right.

class TopTab(val key: String, val label: String, val icon: ImageVector? = null)

private val TabText = Type.headline.copy(fontSize = 15.sp, lineHeight = 19.sp)

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun TopBar(
    tabs: List<TopTab>,
    selected: String,
    requesters: Map<String, FocusRequester>,
    content: FocusRequester,
    avatar: FocusRequester,
    barFocused: Boolean,
    visible: Boolean,
    showClock: Boolean,
    user: User?,
    api: Api,
    userName: String,
    onSelect: (String) -> Unit,
    onFocus: (Boolean) -> Unit,
    onAvatar: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shown by animateFloatAsState(if (visible) 1f else 0f, tween(if (visible) 260 else 200), label = "bar")
    Box(
        modifier
            .fillMaxWidth()
            .graphicsLayer { alpha = shown }
            .onFocusChanged { onFocus(it.hasFocus) },
    ) {
        // Legibility over hero art: a soft scrim fading down from the top edge.
        Box(Modifier.fillMaxWidth().height(150.dp).background(Brush.verticalGradient(0f to Color.Black.copy(alpha = 0.62f), 0.55f to Color.Black.copy(alpha = 0.22f), 1f to Color.Transparent)))
        // The pill is centred on the screen when it fits beside the clock and avatar; with many
        // libraries it slides left, and past the available width it scrolls with the focus.
        Layout(
            content = {
                TabPill(tabs, selected, requesters, content, barFocused, onSelect, Modifier)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                    if (showClock) ClockText()
                    AvatarButton(user, api, userName, onAvatar, Modifier.focusRequester(avatar).focusProperties { down = content })
                }
            },
            modifier = Modifier.fillMaxWidth().padding(top = 22.dp).graphicsLayer { translationY = (1f - shown) * -18.dp.toPx() },
        ) { m, constraints ->
            val width = constraints.maxWidth
            val margin = 40.dp.roundToPx()
            val gap = 24.dp.roundToPx()
            val right = m[1].measure(Constraints())
            val pill = m[0].measure(Constraints(maxWidth = (width - right.width - margin * 2 - gap).coerceAtLeast(0)))
            val x = ((width - pill.width) / 2).coerceAtMost(width - margin - right.width - gap - pill.width).coerceAtLeast(margin)
            val h = maxOf(pill.height, right.height)
            layout(width, h) {
                pill.place(x, (h - pill.height) / 2)
                right.place(width - margin - right.width, (h - right.height) / 2)
            }
        }
    }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun TabPill(
    tabs: List<TopTab>,
    selected: String,
    requesters: Map<String, FocusRequester>,
    content: FocusRequester,
    barFocused: Boolean,
    onSelect: (String) -> Unit,
    modifier: Modifier,
) {
    // Per tab: its group (0 = the scrolling text tabs, 1 = the pinned icon tabs), x and width in that group.
    val bounds = remember { mutableStateMapOf<String, Triple<Int, Float, Float>>() }
    val target = bounds[selected]
    val x = remember { Animatable(0f) }
    val w = remember { Animatable(0f) }
    var group by remember { mutableStateOf(-1) }
    LaunchedEffect(target) {
        val (g, tx, tw) = target ?: return@LaunchedEffect
        if (w.value == 0f || g != group) {
            group = g; x.snapTo(tx); w.snapTo(tw)
        } else {
            val spec = spring<Float>(dampingRatio = 0.9f, stiffness = 380f)
            coroutineScope {
                launch { x.animateTo(tx, spec) }
                launch { w.animateTo(tw, spec) }
            }
        }
    }
    // White only while a tab holds focus (not the avatar next to it).
    var pillFocused by remember { mutableStateOf(false) }
    // lift is read only in drawBehind (no recomposition per frame); the colour switches at once, the size eases.
    val lift by animateFloatAsState(if (pillFocused) 1f else 0f, spring(dampingRatio = 0.9f, stiffness = 420f), label = "pill-lift")
    val indicator = if (pillFocused) TvFocus.bg else Color.White.copy(alpha = 0.16f)
    val scroll = rememberScrollState()
    val edge = with(LocalDensity.current) { 28.dp.toPx() }
    // With many libraries the text tabs scroll: the selected one stays in view, also when picked by touch or
    // restored without focus (focus brings a tab into view by itself).
    LaunchedEffect(target, scroll.viewportSize) {
        val (g, tx, tw) = target ?: return@LaunchedEffect
        val view = scroll.viewportSize
        if (g != 0 || view == 0 || pillFocused) return@LaunchedEffect
        when {
            tx < scroll.value + edge -> scroll.animateScrollTo((tx - edge).toInt())
            tx + tw > scroll.value + view - edge -> scroll.animateScrollTo((tx + tw - view + edge).toInt())
        }
    }
    fun Modifier.indicator(g: Int) = drawBehind {
        if (group == g && w.value > 0f) {
            // The selected tab's pill grows a little when the bar has focus (the lift).
            val grow = 0.06f * lift
            val ww = w.value * (1 + grow)
            val hh = size.height * (1 + grow)
            drawRoundRect(
                indicator,
                topLeft = Offset(x.value - (ww - w.value) / 2, (size.height - hh) / 2),
                size = Size(ww, hh),
                cornerRadius = CornerRadius(hh / 2),
            )
        }
    }

    // Left/Right follow this order: geometric search would jump from a half-hidden tab to the pinned icons,
    // skipping the scrolled-out tabs between them.
    val order = tabs.filter { it.icon == null } + tabs.filter { it.icon != null }

    @Composable
    fun Tab(t: TopTab, g: Int) {
        val i = order.indexOf(t)
        val isSel = t.key == selected
        val fg = when {
            isSel && pillFocused -> TvFocus.fg
            isSel -> C.label
            else -> C.label2
        }
        Row(
            Modifier
                // Written only on change: a fresh Triple each callback (bar slide-in) would recompose TabPill every frame.
                .onGloballyPositioned { val v = Triple(g, it.positionInParent().x, it.size.width.toFloat()); if (bounds[t.key] != v) bounds[t.key] = v }
                .focusRequester(requesters.getValue(t.key))
                .focusProperties {
                    down = content
                    order.getOrNull(i - 1)?.let { left = requesters.getValue(it.key) }
                    order.getOrNull(i + 1)?.let { right = requesters.getValue(it.key) }
                }
                .tvFocus(RoundedCornerShape(50), focusedScale = 1.06f, sheen = false, elevation = 0.dp, onFocusChange = { if (it) onSelect(t.key) }, onClick = { onSelect(t.key) })
                .padding(horizontal = if (t.icon != null) 12.dp else 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (t.icon != null) Icon(t.icon, t.label, tint = fg, modifier = Modifier.size(18.dp))
            if (t.icon == null) Text(t.label, style = TabText, color = fg, maxLines = 1)
        }
    }

    Row(
        modifier
            .onFocusChanged { pillFocused = it.hasFocus }
            .focusRestorer(requesters[selected] ?: FocusRequester.Default)
            .clip(RoundedCornerShape(50))
            .background(C.elevated2.copy(alpha = 0.72f))
            .padding(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Keyed: focusRestorer finds the tab to restore by its composite key, which unkeyed loop items share, so it
        // always restored the first tab (Home) and switched the screen to Home.
        Row(
            Modifier.weight(1f, fill = false).fadeEdges(scroll, edge).horizontalScroll(scroll).indicator(0),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            tabs.filter { it.icon == null }.forEach { t -> key(t.key) { Tab(t, 0) } }
        }
        // Torrents, Recherche and Réglages stay in view however many libraries there are.
        Row(Modifier.indicator(1), verticalAlignment = Alignment.CenterVertically) {
            tabs.filter { it.icon != null }.forEach { t -> key(t.key) { Tab(t, 1) } }
        }
    }
}

// Fades the scrolled-out edges of a horizontal scroller, so a cut tab reads as "more this way".
private fun Modifier.fadeEdges(scroll: androidx.compose.foundation.ScrollState, width: Float) =
    graphicsLayer { compositingStrategy = androidx.compose.ui.graphics.CompositingStrategy.Offscreen }
        .drawWithContent {
            drawContent()
            val f = width.coerceAtMost(size.width / 2)
            if (scroll.value > 0) {
                drawRect(Brush.horizontalGradient(0f to Color.Transparent, 1f to Color.Black, startX = 0f, endX = f), size = Size(f, size.height), blendMode = androidx.compose.ui.graphics.BlendMode.DstIn)
            }
            if (scroll.value < scroll.maxValue) {
                drawRect(
                    Brush.horizontalGradient(0f to Color.Black, 1f to Color.Transparent, startX = size.width - f, endX = size.width),
                    topLeft = Offset(size.width - f, 0f), size = Size(f, size.height), blendMode = androidx.compose.ui.graphics.BlendMode.DstIn,
                )
            }
        }

@Composable
fun UserAvatar(user: User?, api: Api, name: String, size: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier) {
    Box(modifier.size(size).clip(CircleShape).background(C.raised), contentAlignment = Alignment.Center) {
        Text(name.take(1).uppercase(), style = if (size > 40.dp) Type.title2 else Type.headline, color = C.label)
        val url = user?.let { api.userImage(it, 160) }
        if (url != null) AsyncImage(url, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    }
}

@Composable
private fun AvatarButton(user: User?, api: Api, name: String, onClick: () -> Unit, modifier: Modifier) {
    UserAvatar(
        user, api, name, 40.dp,
        modifier.tvFocus(CircleShape, focusedScale = 1.16f, elevation = 12.dp, onClick = onClick),
    )
}

// ---------------------------------------------------------------------------
// Idle tracking and the backdrop screensaver.

object Idle {
    var last by mutableLongStateOf(SystemClock.uptimeMillis())
    var saver by mutableStateOf(false)
    fun poke() {
        last = SystemClock.uptimeMillis()
    }
}

// source: TvSettings.SCREENSAVER_BACKDROPS (the default), SCREENSAVER_PHOTOS or SCREENSAVER_MEMORIES (photos spec
// PH-07); Dream reads the same.
@Composable
fun Screensaver(api: Api, source: String = TvSettings.screensaverSource.value, album: String = TvSettings.screensaverAlbum.value) {
    // Music playing (MU-09): the ambient now-playing layout instead, in the app and in the system Dream alike.
    com.wika.wicaby.tv.music.Music.ambient(api)?.let { return com.wika.wicaby.tv.music.Ambient(it) }
    if (source == TvSettings.SCREENSAVER_PHOTOS || source == TvSettings.SCREENSAVER_MEMORIES) {
        return com.wika.wicaby.tv.ui.photos.PhotoScreensaver(api, album.ifEmpty { null }, memories = source == TvSettings.SCREENSAVER_MEMORIES)
    }
    val items by produceState<List<Item>>(emptyList()) {
        value = runCatching {
            api.items(
                "IncludeItemTypes" to "Movie,Series", "Recursive" to true, "SortBy" to "Random", "Limit" to 40,
                "ImageTypes" to "Backdrop", "EnableImageTypes" to "Backdrop,Logo",
            ).items.filter { it.backdropImageTags.isNotEmpty() }
        }.getOrDefault(emptyList())
    }
    var index by remember { mutableStateOf(0) }
    LaunchedEffect(items) {
        while (items.isNotEmpty()) {
            delay(9_000)
            index = (index + 1) % items.size
        }
    }
    Box(Modifier.fillMaxSize().background(Color.Black).pointerInput(Unit) { detectTapGestures { Idle.saver = false; Idle.poke() } }) {
        val item = items.getOrNull(index)
        Crossfade(item, animationSpec = tween(1600), label = "saver") { it ->
            if (it != null) {
                val zoom = remember(it.id) { Animatable(1f) }
                LaunchedEffect(it.id) { zoom.animateTo(1.08f, tween(11_000, easing = LinearEasing)) }
                AsyncImage(
                    api.backdrop(it), null, contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize().graphicsLayer { scaleX = zoom.value; scaleY = zoom.value },
                )
            }
        }
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.55f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.7f))))
        Row(Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(horizontal = 56.dp, vertical = 40.dp), verticalAlignment = Alignment.Bottom) {
            Text(item?.name.orEmpty(), style = Type.title3, color = C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            ClockText()
        }
    }
}

@Composable
fun ScreensaverHost(api: Api?, minutes: Int, content: @Composable BoxScope.() -> Unit) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(minutes, api) {
        if (minutes <= 0 || api == null) return@LaunchedEffect
        while (true) {
            delay(5_000)
            // Only while this activity is in front: never behind the player or another app.
            val front = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
            if (front && !Idle.saver && SystemClock.uptimeMillis() - Idle.last > minutes * 60_000L) Idle.saver = true
        }
    }
    Box(Modifier.fillMaxSize()) {
        content()
        if (api != null) {
            AnimatedVisibility(Idle.saver, enter = fadeIn(tween(1200)), exit = fadeOut(tween(300))) { Screensaver(api) }
        }
    }
}
