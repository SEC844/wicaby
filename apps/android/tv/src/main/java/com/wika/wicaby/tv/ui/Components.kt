package com.wika.wicaby.tv.ui

import androidx.compose.foundation.focusGroup
import androidx.compose.ui.focus.FocusDirection
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.meshui.LogoLoader
import com.wika.wicaby.core.data.posterArt
import com.wika.wicaby.core.data.thumb
import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.platform.InterceptPlatformTextInput
import androidx.compose.ui.platform.PlatformTextInputMethodRequest
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import com.wika.wicaby.tv.R
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.runtimeText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

// ---------------------------------------------------------------------------
// Focus: tvOS-like lift (spring scale), soft shadow and a specular sheen.

private fun isSelect(key: Key) = key == Key.DirectionCenter || key == Key.Enter || key == Key.NumPadEnter || key == Key.ButtonA

// The system's "Animator duration scale" at 0 (accessibility, or developer options): no focus lift. Read once.
object Motion {
    private var off: Boolean? = null
    fun off(context: android.content.Context): Boolean = off ?: (
        android.provider.Settings.Global.getFloat(context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    ).also { off = it }
}

fun Modifier.tvFocus(
    shape: Shape,
    focusedScale: Float = 1.08f,
    sheen: Boolean = true,
    ring: Color? = null,
    ringWidth: Dp = 3.dp,
    elevation: Dp = 16.dp,
    onFocusChange: ((Boolean) -> Unit)? = null,
    onClick: () -> Unit,
): Modifier = composed {
    var focused by remember { mutableStateOf(false) }
    var pressed by remember { mutableStateOf(false) }
    val still = Motion.off(androidx.compose.ui.platform.LocalContext.current)
    val scale by animateFloatAsState(
        when {
            still -> 1f
            pressed -> (if (focused) focusedScale else 1f) * 0.96f
            focused -> focusedScale
            else -> 1f
        },
        spring(dampingRatio = 0.62f, stiffness = 420f),
        label = "focus-scale",
    )
    val lift by animateFloatAsState(if (focused) 1f else 0f, spring(stiffness = 320f), label = "focus-lift")
    val click by rememberUpdatedState(onClick)
    val focusCb by rememberUpdatedState(onFocusChange)
    val self = remember { FocusRequester() }
    this
        .focusRequester(self)
        .onFocusChanged { s ->
            if (focused != s.hasFocus) {
                focused = s.hasFocus
                if (s.hasFocus) LastFocus.requester = self
                focusCb?.invoke(s.hasFocus)
            }
            if (!s.hasFocus) pressed = false
        }
        .onKeyEvent { e ->
            if (!isSelect(e.key)) return@onKeyEvent false
            when (e.type) {
                KeyEventType.KeyDown -> {
                    pressed = true
                    true
                }
                KeyEventType.KeyUp -> {
                    if (pressed) {
                        pressed = false
                        click()
                    }
                    true
                }
                else -> false
            }
        }
        // Touch screens: a tap is OK. Scrolling parents still win once the finger moves.
        .pointerInput(Unit) {
            detectTapGestures(
                onPress = {
                    pressed = true
                    tryAwaitRelease()
                    pressed = false
                },
                onTap = { click() },
            )
        }
        .focusable()
        .graphicsLayer {
            scaleX = scale
            scaleY = scale
            shadowElevation = elevation.toPx() * lift
            this.shape = shape
            clip = true
        }
        .drawWithContent {
            drawContent()
            if (lift > 0.01f) {
                if (sheen) {
                    drawRect(
                        Brush.linearGradient(
                            0f to Color.White.copy(alpha = 0.22f * lift),
                            0.45f to Color.White.copy(alpha = 0.04f * lift),
                            0.7f to Color.Transparent,
                            start = Offset.Zero,
                            end = Offset(size.width, size.height),
                        ),
                    )
                }
                if (ring != null) {
                    drawOutline(shape.createOutline(size, layoutDirection, this), ring.copy(alpha = ring.alpha * lift), style = Stroke(ringWidth.toPx()))
                }
            }
        }
}

// The last tvFocus element that took focus: where an overlay sends focus back on close.
object LastFocus {
    var requester: FocusRequester? = null
}

// Remembers which element had focus on a screen and gives it back when the
// screen returns (after Back). `default` takes focus on the first visit.
class FocusMemory(var key: String?) {
    var restored = false
}

@Composable
fun rememberFocusMemory(): FocusMemory =
    rememberSaveable(saver = Saver<FocusMemory, String>(save = { it.key.orEmpty() }, restore = { FocusMemory(it.ifEmpty { null }) })) {
        FocusMemory(null)
    }

// False while the user browses the tab bar, so a tab that appears does not steal focus.
val LocalAutoFocus = androidx.compose.runtime.compositionLocalOf { true }

fun Modifier.remembered(memory: FocusMemory, key: String, default: Boolean = false): Modifier = composed {
    val requester = remember { FocusRequester() }
    val allowed = LocalAutoFocus.current
    LaunchedEffect(Unit) {
        if (allowed && !memory.restored && (memory.key == key || (memory.key == null && default))) {
            memory.restored = true
            delay(40)
            runCatching { requester.requestFocus() }
        }
    }
    focusRequester(requester).onFocusChanged { if (it.hasFocus) memory.key = key }
}

// ---------------------------------------------------------------------------
// Scrolling: rows keep the focused card clear of the edges.

@OptIn(ExperimentalFoundationApi::class)
class EdgeSpec(private val margin: Float) : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
        val end = offset + size
        return when {
            offset < margin -> offset - margin
            end > containerSize - margin -> (end - (containerSize - margin)).coerceAtMost(offset - margin)
            else -> 0f
        }
    }
}

// Focused content settles at a fixed line, like tvOS.
@OptIn(ExperimentalFoundationApi::class)
class PivotSpec(private val fraction: Float, private val override: () -> Float? = { null }) : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float =
        override() ?: (offset - containerSize * fraction)
}

// ---------------------------------------------------------------------------
// Data loading: stale-while-revalidate, cached across screens.

object Cache {
    // LRU: browsing many shows and libraries must not keep every page in memory.
    val map: MutableMap<String, Any> = object : LinkedHashMap<String, Any>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Any>?) = size > MAX
    }
    const val MAX = 64

    // Bumped when watched/favourite state changes on the server (playback ended, a toggle):
    // every screen on show refetches, so Reprendre and Épisode suivant are current.
    var version by mutableIntStateOf(0)
        private set

    fun changed() {
        version++
    }
}

class Loaded<T>(val value: T?, val error: Throwable?)

@Suppress("UNCHECKED_CAST")
@Composable
fun <T : Any> rememberLoad(cacheKey: String, refresh: Boolean = true, block: suspend () -> T): State<Loaded<T>> {
    val key = LocalCacheNs.current + cacheKey
    val state = remember(key) { mutableStateOf(Loaded(Cache.map[key] as T?, null)) }
    LaunchedEffect(key, Cache.version) {
        if (!refresh && state.value.value != null) return@LaunchedEffect
        try {
            val v = block()
            Cache.map[key] = v
            state.value = Loaded(v, null)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (state.value.value == null) state.value = Loaded(null, e)
        }
    }
    return state
}

@Composable
fun dpPx(dp: Dp): Int = with(LocalDensity.current) { dp.roundToPx() }

// ---------------------------------------------------------------------------
// Building blocks.

@Composable
fun Pill(
    text: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    primary: Boolean = false,
    selected: Boolean = false,
    onFocus: ((Boolean) -> Unit)? = null,
) {
    var focused by remember { mutableStateOf(false) }
    val accent = LocalAccent.current
    val bg by animateColorAsState(
        when {
            primary -> accent
            focused -> Color.White
            selected -> C.fill4
            else -> C.fill3
        },
        tween(160),
        label = "pill-bg",
    )
    val fg = when {
        primary -> onAccent(accent)
        focused -> Color.Black
        else -> C.label
    }
    Row(
        modifier
            .tvFocus(RoundedCornerShape(50), focusedScale = 1.08f, onFocusChange = { focused = it; onFocus?.invoke(it) }, onClick = onClick)
            .background(bg)
            .padding(horizontal = if (text == null) 13.dp else 22.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (icon != null) Icon(icon, contentDescription = text, tint = fg, modifier = Modifier.size(20.dp))
        if (text != null) Text(text, style = Type.headline, color = fg, maxLines = 1)
    }
}

@Composable
fun ProgressLine(progress: Float, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(4.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.28f))) {
        Box(Modifier.fillMaxWidth(progress).fillMaxHeight().clip(CircleShape).background(LocalAccent.current))
    }
}

@Composable
private fun CardBadge(item: Item, modifier: Modifier) {
    val accent = LocalAccent.current
    val unplayed = item.userData?.unplayedItemCount ?: 0
    when {
        item.userData?.played == true -> Box(modifier.size(22.dp).clip(CircleShape).background(accent), contentAlignment = Alignment.Center) {
            Icon(Ic.Check, null, tint = onAccent(accent), modifier = Modifier.size(15.dp))
        }
        item.isSeries && unplayed > 0 -> Box(modifier.clip(RoundedCornerShape(50)).background(accent).padding(horizontal = 7.dp, vertical = 2.dp)) {
            Text(unplayed.toString(), style = Type.caption.copy(fontSize = 11.sp), color = onAccent(accent))
        }
    }
}

@Composable
fun PosterCard(
    item: Item,
    api: Api,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    focusModifier: Modifier = Modifier,
    width: Dp? = 120.dp,
    onFocus: (() -> Unit)? = null,
    // TP-07: 1f for music albums (desktop's "square" row variant).
    aspect: Float = 2f / 3f,
    // TP-06: merged rows name the card's server (desktop Card showServer).
    server: String? = null,
) {
    var focused by remember { mutableStateOf(false) }
    val h = dpPx((width ?: 120.dp) * 1.5f)
    Column(if (width != null) modifier.width(width) else modifier.fillMaxWidth()) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(aspect)
                .then(focusModifier)
                .tvFocus(RoundedCornerShape(Radius.md), onFocusChange = { focused = it; if (it) onFocus?.invoke() }, onClick = onClick)
                .background(C.elevated2),
        ) {
            val url = remember(item.id) { Servers.forItem(item, api).posterArt(item, h) }
            // A generated comic cover can fail (no page, server without Range): the title, as with no art.
            var failed by remember(item.id) { mutableStateOf(false) }
            if (url != null && !failed) {
                AsyncImage(url, contentDescription = item.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(), onError = { failed = true })
            } else {
                Text(item.name, style = Type.callout, color = C.label2, textAlign = TextAlign.Center, modifier = Modifier.align(Alignment.Center).padding(12.dp))
            }
            CardBadge(item, Modifier.align(Alignment.TopEnd).padding(8.dp))
            item.progress?.let { ProgressLine(it, Modifier.align(Alignment.BottomCenter).padding(8.dp)) }
        }
        Text(
            item.name,
            style = Type.footnote,
            color = if (focused) C.label else C.label2,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 12.dp, start = 2.dp, end = 2.dp),
        )
        if (server != null) Text(server, style = Type.footnote, color = C.label3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp, start = 2.dp, end = 2.dp))
    }
}

// desktop stores serverName(): the card's server, named in merged views.
fun serverName(item: Item): String? = Servers.of(item.serverId)?.server?.name

@Composable
fun episodeLine(item: Item): String? {
    if (!item.isEpisode) return null
    val s = item.parentIndexNumber
    val e = item.indexNumber
    val code = if (s != null && e != null) stringResource(R.string.episode_code, s, e) else null
    return listOfNotNull(code, item.name.takeIf { it.isNotBlank() }).joinToString(" · ")
}

@Composable
fun ThumbCard(
    item: Item,
    api: Api,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    focusModifier: Modifier = Modifier,
    width: Dp = 232.dp,
    onFocus: (() -> Unit)? = null,
    inSeries: Boolean = false,
    // The merged Continue Watching row (X-01) names the next episode or the time left.
    subtitle: String? = null,
    server: String? = null,
) {
    var focused by remember { mutableStateOf(false) }
    val w = dpPx(width)
    Column(modifier.width(width)) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(16f / 9f)
                .then(focusModifier)
                .tvFocus(RoundedCornerShape(Radius.md), focusedScale = 1.07f, onFocusChange = { focused = it; if (it) onFocus?.invoke() }, onClick = onClick)
                .background(C.elevated2),
        ) {
            val url = remember(item.id) { Servers.forItem(item, api).thumb(item, w) }
            if (url != null) AsyncImage(url, contentDescription = item.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.55f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.55f))))
            CardBadge(item, Modifier.align(Alignment.TopEnd).padding(8.dp))
            item.progress?.let { ProgressLine(it, Modifier.align(Alignment.BottomCenter).padding(horizontal = 12.dp, vertical = 10.dp)) }
        }
        val code = item.indexNumber?.takeIf { inSeries }?.let { stringResource(R.string.episode_short, it) + " · " } ?: ""
        val title = if (item.isEpisode && !inSeries) item.seriesName ?: item.name else code + item.name
        val sub = subtitle ?: (if (inSeries) runtimeText(item.runTimeTicks) else episodeLine(item)) ?: item.progress?.let { p ->
            runtimeText(((item.runTimeTicks ?: 0) * (1 - p)).toLong())?.let { stringResource(R.string.time_left, it) }
        } ?: item.productionYear?.toString()
        val line = listOfNotNull(sub, server).joinToString(" · ").ifEmpty { null }
        Text(title, style = Type.callout, color = if (focused) C.label else C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 12.dp, start = 2.dp))
        if (line != null) Text(line, style = Type.footnote, color = C.label3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp, start = 2.dp))
    }
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalComposeUiApi::class)
@Composable
fun MediaRow(
    title: String,
    items: List<Item>,
    api: Api,
    memory: FocusMemory,
    rowKey: String,
    wide: Boolean,
    onFocusItem: (Item) -> Unit,
    onClick: (Item) -> Unit,
    modifier: Modifier = Modifier,
    subtitle: (@Composable (Item) -> String?)? = null,
    square: Boolean = false,
    // TP-07: a card of the row's own (Home's Live TV channels), given the card's focus modifier.
    card: (@Composable (Item, Modifier) -> Unit)? = null,
    // TP-06: desktop showServer={multi}, for rows merged from several servers.
    showServer: Boolean = false,
) {
    val margin = with(LocalDensity.current) { 56.dp.toPx() }
    val spec = remember(margin) { EdgeSpec(margin) }
    Column(modifier.fillMaxWidth().padding(top = 14.dp)) {
        Text(title, style = Type.title3, color = C.label, modifier = Modifier.padding(start = 48.dp, bottom = 2.dp))
        CompositionLocalProvider(LocalBringIntoViewSpec provides spec) {
            LazyRow(
                modifier = Modifier.fillMaxWidth().dpadEdges().focusRestorer(),
                contentPadding = PaddingValues(horizontal = 48.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(if (wide) 22.dp else 20.dp),
            ) {
                // TP-06: merged rows hold several servers' items, whose ids may clash.
                items(items, key = { Servers.key(it) }) { item ->
                    val fm = Modifier.remembered(memory, "$rowKey/${Servers.key(item)}")
                    val server = if (showServer) serverName(item) else null
                    if (card != null) {
                        card(item, fm)
                    } else if (wide) {
                        ThumbCard(item, api, onClick = { onClick(item) }, focusModifier = fm, onFocus = { onFocusItem(item) }, subtitle = subtitle?.invoke(item), server = server)
                    } else {
                        PosterCard(item, api, onClick = { onClick(item) }, focusModifier = fm, onFocus = { onFocusItem(item) }, aspect = if (square) 1f else 2f / 3f, server = server)
                    }
                }
            }
        }
    }
}

// D-pad at the ends of a row (and the sides of a grid): a dead end. Without it the 2D focus search takes the nearest
// focusable that way anywhere on screen, the row above or the tab bar. An outer focus group of its own, so the row's
// focusRestorer keeps its exit; [left] false lets LEFT through (a grid's A–Z rail).
fun Modifier.dpadEdges(left: Boolean = true, right: Boolean = true): Modifier = focusProperties {
    onExit = {
        val d = requestedFocusDirection
        if ((left && d == FocusDirection.Left) || (right && d == FocusDirection.Right)) cancelFocusChange()
    }
}.focusGroup()

@Composable
// A bare Spinner() is a page waiting with no content: it shows the painted Wicaby mark
// (LogoLoader). Sized calls (buttons, rows, player buffering) keep the small ring.
fun Spinner(modifier: Modifier? = null, color: Color = C.label2) {
    if (modifier == null) return LogoLoader(C.label, stringResource(R.string.loading))
    val t = rememberInfiniteTransition(label = "spinner")
    val angle by t.animateFloat(0f, 360f, infiniteRepeatable(tween(900, easing = LinearEasing)), label = "spin")
    Canvas(modifier.rotate(angle)) {
        drawArc(color, startAngle = 0f, sweepAngle = 280f, useCenter = false, style = Stroke(3.dp.toPx(), cap = StrokeCap.Round))
    }
}

@Composable
fun Backdrop(url: Any?, modifier: Modifier = Modifier, dim: Float = 0f) {
    Box(modifier.fillMaxSize()) {
        Crossfade(url, animationSpec = tween(520), label = "backdrop") { u ->
            if (u != null) AsyncImage(u, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
        Box(
            Modifier.fillMaxSize().background(
                Brush.horizontalGradient(0f to C.bg.copy(alpha = 0.94f), 0.38f to C.bg.copy(alpha = 0.62f), 0.72f to C.bg.copy(alpha = 0.08f), 1f to Color.Transparent),
            ),
        )
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.4f to Color.Transparent, 1f to C.bg)))
        val d by animateFloatAsState(dim, tween(320), label = "dim")
        if (d > 0f) Box(Modifier.fillMaxSize().graphicsLayer { alpha = d }.background(C.bg))
    }
}

// Text input that does not grab the keyboard while the user only moves focus
// past it: OK opens the IME, the IME action closes it.
//
// TV keyboards cover the lower half of the screen: the window resizes for the IME (root
// imePadding, adjustResize) and the field scrolls itself into the visible part. `label`
// becomes EditorInfo.hintText/label, which fullscreen keyboards (Sony, some Gboard TV
// builds) show as the title of their own text box. Passwords get a Show/Hide toggle to
// the right of the field, reachable with the D-pad.
@OptIn(ExperimentalComposeUiApi::class, ExperimentalLayoutApi::class)
@Composable
fun TvTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    password: Boolean = false,
    imeAction: ImeAction = ImeAction.Done,
    autoEdit: Boolean = false,
    onSubmit: () -> Unit = {},
    label: String = placeholder,
) {
    val outer = remember { FocusRequester() }
    val inner = remember { FocusRequester() }
    var editing by remember { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    var reveal by rememberSaveable { mutableStateOf(false) }
    val keyboard = LocalSoftwareKeyboardController.current
    val bring = remember { BringIntoViewRequester() }
    val imeVisible = WindowInsets.isImeVisible
    LaunchedEffect(editing) {
        if (editing) {
            delay(30)
            runCatching { inner.requestFocus() }
            keyboard?.show()
        }
    }
    LaunchedEffect(autoEdit) {
        if (autoEdit) {
            delay(60)
            runCatching { outer.requestFocus() }
            editing = true
        }
    }
    // Once the window has shrunk for the keyboard, scroll the field into what is left.
    LaunchedEffect(editing, imeVisible) {
        if (editing && imeVisible) {
            delay(120)
            bring.bringIntoView()
        }
    }
    // A field that goes away while typing (a panel swap after submit) takes its keyboard along.
    val editingNow by rememberUpdatedState(editing)
    DisposableEffect(Unit) { onDispose { if (editingNow) keyboard?.hide() } }
    // Back on the remote hides the keyboard: leave editing too, so the D-pad moves focus
    // again (to the Show toggle, the buttons) instead of the caret.
    var imeShown by remember { mutableStateOf(false) }
    LaunchedEffect(imeVisible) {
        if (imeVisible) {
            imeShown = true
        } else if (imeShown) {
            imeShown = false
            if (editing) {
                editing = false
                runCatching { outer.requestFocus() }
            }
        }
    }
    val hint by rememberUpdatedState(label)
    val field = @Composable { m: Modifier ->
        Row(
            m
                .focusRequester(outer)
                // A touch goes straight to the inner field, which only accepts focus while editing.
                .pointerInput(Unit) { awaitEachGesture { awaitFirstDown(pass = PointerEventPass.Initial); editing = true } }
                // Neutral focus: a brighter fill and a white hairline, no accent ring.
                .tvFocus(
                    RoundedCornerShape(Radius.md), focusedScale = 1.03f, sheen = false,
                    ring = Color.White.copy(alpha = if (editing) 0.9f else 0.55f), ringWidth = 1.dp,
                    onFocusChange = { focused = it }, onClick = { editing = true },
                )
                .background(
                    when {
                        editing -> C.fill4.compositeOver(C.raised)
                        focused -> C.raised
                        else -> C.fill3
                    },
                )
                .padding(horizontal = 18.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(Ic.Keyboard, null, tint = C.label3, modifier = Modifier.size(20.dp))
            InterceptPlatformTextInput(
                interceptor = { request, next ->
                    next.startInputMethod(object : PlatformTextInputMethodRequest {
                        override fun createInputConnection(outAttributes: EditorInfo): InputConnection {
                            val connection = request.createInputConnection(outAttributes)
                            outAttributes.hintText = hint
                            outAttributes.label = hint
                            return connection
                        }
                    })
                },
            ) {
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    singleLine = true,
                    textStyle = Type.body.copy(color = C.label, fontSize = 17.sp),
                    cursorBrush = SolidColor(C.label),
                    visualTransformation = if (password && !reveal) PasswordVisualTransformation() else VisualTransformation.None,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = if (password) KeyboardType.Password else KeyboardType.Text,
                        imeAction = imeAction,
                        autoCorrectEnabled = false,
                    ),
                    keyboardActions = KeyboardActions(onAny = {
                        editing = false
                        keyboard?.hide()
                        runCatching { outer.requestFocus() }
                        onSubmit()
                    }),
                    modifier = Modifier
                        .weight(1f)
                        .focusRequester(inner)
                        .focusProperties { canFocus = editing }
                        .onFocusChanged { if (!it.isFocused && editing) editing = false },
                    decorationBox = { content ->
                        Box {
                            if (value.isEmpty()) Text(placeholder, style = Type.body.copy(fontSize = 17.sp), color = C.label3, maxLines = 1)
                            content()
                        }
                    },
                )
            }
        }
    }
    if (!password) {
        field(modifier.bringIntoViewRequester(bring))
    } else {
        // The caller's modifier (focus requesters, width) goes to the field itself.
        Row(
            Modifier.fillMaxWidth().bringIntoViewRequester(bring),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            field(Modifier.weight(1f).then(modifier))
            val toggle = stringResource(if (reveal) R.string.password_hide_desc else R.string.password_show_desc)
            Pill(
                stringResource(if (reveal) R.string.password_hide else R.string.password_show),
                onClick = { reveal = !reveal },
                icon = if (reveal) Ic.EyeOff else Ic.Eye,
                modifier = Modifier.semantics { contentDescription = toggle },
            )
        }
    }
}

@Composable
fun Centered(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }
}

@Composable
fun ErrorState(message: String? = null, onRetry: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(message ?: stringResource(R.string.load_error), style = Type.title3, color = C.label2, textAlign = TextAlign.Center)
        Pill(stringResource(R.string.retry), onClick = onRetry, icon = Ic.Refresh)
    }
}
