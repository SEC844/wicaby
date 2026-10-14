package com.wika.wicaby.mobile.ui

import com.wika.wicaby.meshui.LogoLoader
import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.data.posterArt
import com.wika.wicaby.core.data.runtimeText
import com.wika.wicaby.core.data.thumb
import com.wika.wicaby.mobile.R
import kotlinx.coroutines.CancellationException
import java.util.concurrent.ConcurrentHashMap

// ---------------------------------------------------------------------------
// Data: stale-while-revalidate, cached across screens and tab switches.

object Cache {
    val map = ConcurrentHashMap<String, Any>()

    // Home rows change after playback or a played/favourite toggle.
    fun invalidateHome() {
        map.keys.removeAll { it == "resume" || it == "nextup" || it.startsWith("latest-") || it.startsWith("item-") }
    }
}

class Loaded<T>(val value: T?, val error: Throwable?, val loading: Boolean)

// Reloads whenever [nonce] changes (pull to refresh) while showing the cached value meanwhile.
@Suppress("UNCHECKED_CAST")
@Composable
fun <T : Any> rememberLoad(key: String, nonce: Int = 0, block: suspend () -> T): Loaded<T> {
    var state by remember(key) { mutableStateOf(Loaded(Cache.map[key] as T?, null, true)) }
    LaunchedEffect(key, nonce) {
        state = Loaded(state.value, null, true)
        state = try {
            val v = block()
            Cache.map[key] = v
            Loaded(v, null, false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Loaded(state.value, e, false)
        }
    }
    return state
}

// ---------------------------------------------------------------------------
// Shared-element plumbing: poster -> detail. Off when there is no transition scope.

@OptIn(ExperimentalSharedTransitionApi::class)
val LocalSharedScope = compositionLocalOf<SharedTransitionScope?> { null }
val LocalNavScope = compositionLocalOf<AnimatedVisibilityScope?> { null }

@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun Modifier.sharedPoster(id: String): Modifier {
    val shared = LocalSharedScope.current ?: return this
    val anim = LocalNavScope.current ?: return this
    return with(shared) {
        this@sharedPoster.sharedElement(rememberSharedContentState("poster-$id"), anim)
    }
}

// ---------------------------------------------------------------------------
// Building blocks.

@Composable
fun Modifier.pressScale(source: MutableInteractionSource): Modifier {
    val pressed by source.collectIsPressedAsState()
    val s by animateFloatAsState(if (pressed) 0.96f else 1f, spring(dampingRatio = 0.6f, stiffness = 600f), label = "press")
    return graphicsLayer {
        scaleX = s
        scaleY = s
    }
}

// Pill button: the accent fill only for the primary action.
@Composable
fun PillButton(
    text: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    primary: Boolean = false,
    selected: Boolean = false,
    // Over artwork a white fill washes out; dark glass keeps the label legible.
    onArt: Boolean = false,
    compact: Boolean = false,
    // For an icon-only button (no [text]).
    contentDescription: String? = text,
) {
    val accent = LocalAccent.current
    val source = remember { MutableInteractionSource() }
    val bg = when {
        primary -> accent
        selected -> G.label
        onArt -> Color.Black.copy(alpha = 0.4f)
        else -> G.fill3
    }
    val fg = when {
        primary -> onAccent(accent)
        selected -> Color.Black
        else -> G.label
    }
    Row(
        modifier
            .pressScale(source)
            .clip(CircleShape)
            .background(bg)
            .clickable(source, null, role = Role.Button, onClick = onClick)
            .padding(horizontal = if (text == null) 12.dp else if (compact) 14.dp else 20.dp, vertical = if (compact) 10.dp else 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
    ) {
        if (icon != null) Icon(icon, contentDescription = if (text != null) null else contentDescription, tint = fg, modifier = Modifier.size(20.dp))
        if (text != null) Text(text, style = if (compact) Type.callout else Type.headline, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// A round icon with a caption under it (Apple-style secondary actions on the detail page).
@Composable
fun ActionIcon(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier, active: Boolean = false, progress: Float? = null) {
    val source = remember { MutableInteractionSource() }
    Column(
        modifier.pressScale(source).clickable(source, null, role = Role.Button, onClick = onClick).padding(vertical = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(48.dp).clip(CircleShape).background(G.fill2), contentAlignment = Alignment.Center) {
            if (progress != null) {
                CircularProgressIndicator(progress = { progress }, modifier = Modifier.size(48.dp), color = LocalAccent.current, trackColor = Color.Transparent, strokeWidth = 2.dp)
            }
            Icon(icon, contentDescription = label, tint = if (active) G.label else G.label2, modifier = Modifier.size(22.dp))
        }
        Text(label, style = Type.caption, color = if (active) G.label else G.label2, maxLines = 1, modifier = Modifier.padding(top = 6.dp))
    }
}

@Composable
fun ProgressLine(progress: Float, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(3.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.28f))) {
        Box(Modifier.fillMaxWidth(progress).fillMaxHeight().clip(CircleShape).background(LocalAccent.current))
    }
}

@Composable
// A bare Spinner() is a page waiting with no content: it shows the painted Wicaby mark
// (LogoLoader). Sized calls (buttons, rows, player buffering) keep the small ring.
fun Spinner(modifier: Modifier? = null, color: Color = G.label2) {
    if (modifier == null) return LogoLoader(G.label, stringResource(R.string.loading))
    CircularProgressIndicator(modifier, color = color, strokeWidth = 2.dp, trackColor = Color.Transparent)
}

@Composable
fun Centered(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }
}

@Composable
fun ErrorState(onRetry: () -> Unit, modifier: Modifier = Modifier, extra: (@Composable () -> Unit)? = null) {
    Column(modifier.padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(Ic.WifiOff, null, tint = G.label3, modifier = Modifier.size(36.dp))
        Text(stringResource(R.string.load_error), style = Type.headline, color = G.label, textAlign = TextAlign.Center)
        Text(stringResource(R.string.offline_hint), style = Type.footnote, color = G.label2, textAlign = TextAlign.Center)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 8.dp)) {
            PillButton(stringResource(R.string.retry), onRetry, icon = Ic.Refresh)
            extra?.invoke()
        }
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, style = Type.title3, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = modifier.padding(start = 20.dp, end = 20.dp, bottom = 10.dp))
}

@Composable
fun dpPx(dp: Dp): Int = with(LocalDensity.current) { dp.roundToPx() }

@Composable
fun episodeLine(item: Item): String? {
    if (!item.isEpisode) return null
    val s = item.parentIndexNumber
    val e = item.indexNumber
    val code = if (s != null && e != null) stringResource(R.string.episode_code, s, e) else null
    return listOfNotNull(code, item.name.takeIf { it.isNotBlank() }).joinToString(" · ")
}

@Composable
fun metaLine(item: Item): String = listOfNotNull(
    item.productionYear?.toString(),
    item.officialRating,
    runtimeText(item.runTimeTicks),
    item.communityRating?.let { stringResource(R.string.rating, formatNumber(it, maxFractionDigits = 1, minFractionDigits = 1)) },
    item.genres.take(2).joinToString(", ").ifEmpty { null },
).joinToString("  ·  ")

// Watched tick or unplayed count: neutral glass, the accent stays for progress and actions.
@Composable
private fun CardBadge(item: Item, modifier: Modifier) {
    val unplayed = item.userData?.unplayedItemCount ?: 0
    when {
        item.userData?.played == true -> Box(modifier.size(22.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.55f)), contentAlignment = Alignment.Center) {
            Icon(Ic.Check, stringResource(R.string.watched), tint = Color.White, modifier = Modifier.size(14.dp))
        }
        item.isSeries && unplayed > 0 -> Box(modifier.clip(CircleShape).background(Color.Black.copy(alpha = 0.55f)).padding(horizontal = 7.dp, vertical = 2.dp)) {
            Text(formatNumber(unplayed), style = Type.caption, color = Color.White)
        }
    }
}

// onLongClick: a file source's card menu (Play from start, Mark as watched).
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun PosterCard(item: Item, api: Api, onClick: () -> Unit, modifier: Modifier = Modifier, width: Dp? = 116.dp, showTitle: Boolean = true, art: Any? = null, onLongClick: (() -> Unit)? = null) {
    val source = remember { MutableInteractionSource() }
    // One URL size for every poster, so the detail page's copy is already in the memory cache.
    // [art]: a local file instead (downloads, offline).
    val url = remember(item.id, art) { art ?: Servers.forItem(item, api).posterArt(item, POSTER_PX) }
    // A generated comic cover can fail (no page, server without Range): the title, as with no art.
    var failed by remember(item.id, art) { mutableStateOf(false) }
    Column(
        (if (width != null) modifier.width(width) else modifier.fillMaxWidth())
            .pressScale(source)
            .combinedClickable(source, null, role = Role.Button, onLongClick = onLongClick, onClick = onClick),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(2f / 3f)
                .sharedPoster(item.id)
                .clip(RoundedCornerShape(Radius.md))
                .background(G.elevated2),
        ) {
            if (url != null && !failed) {
                AsyncImage(url, contentDescription = item.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(), onError = { failed = true })
            } else if (com.wika.wicaby.core.music.MusicArt.isMusic(item)) {
                // Music without art (music spec MU-A4): initials on a colour from the name.
                com.wika.wicaby.mobile.music.ArtPlaceholder(item.name, width ?: 116.dp)
            } else {
                Text(item.name, style = Type.callout, color = G.label2, textAlign = TextAlign.Center, modifier = Modifier.align(Alignment.Center).padding(10.dp))
            }
            CardBadge(item, Modifier.align(Alignment.TopEnd).padding(7.dp))
            item.progress?.let { ProgressLine(it, Modifier.align(Alignment.BottomCenter).padding(8.dp)) }
        }
        if (showTitle) {
            Text(item.name, style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp, start = 2.dp, end = 2.dp))
        }
    }
}

const val POSTER_PX = 480

// onLongClick / subtitle: the merged Continue Watching row (X-01).
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun ThumbCard(item: Item, api: Api, onClick: () -> Unit, width: Dp, modifier: Modifier = Modifier, onLongClick: (() -> Unit)? = null, subtitle: String? = null) {
    val source = remember { MutableInteractionSource() }
    val px = dpPx(width)
    val url = remember(item.id) { Servers.forItem(item, api).thumb(item, px) }
    Column(modifier.width(width).pressScale(source).combinedClickable(source, null, role = Role.Button, onLongClick = onLongClick, onClick = onClick)) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(Radius.md)).background(G.elevated2)) {
            if (url != null) AsyncImage(url, contentDescription = item.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            item.progress?.let { ProgressLine(it, Modifier.align(Alignment.BottomCenter).padding(horizontal = 10.dp, vertical = 9.dp)) }
        }
        val title = if (item.isEpisode) item.seriesName ?: item.name else item.name
        val sub = subtitle ?: if (item.isEpisode) episodeLine(item) else item.productionYear?.toString()
        Text(title, style = Type.callout, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp, start = 2.dp))
        if (sub != null) Text(sub, style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 2.dp))
    }
}

@Composable
fun MediaRow(
    title: String, items: List<Item>, api: Api, wide: Boolean, onClick: (Item) -> Unit, thumbWidth: Dp = 264.dp,
    onLongClick: ((Item) -> Unit)? = null, subtitle: (@Composable (Item) -> String?)? = null,
) {
    Column(Modifier.fillMaxWidth().padding(top = 22.dp)) {
        SectionTitle(title)
        LazyRow(contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            items(items, key = { Servers.key(it) }, contentType = { if (wide) "thumb" else "poster" }) { item ->
                if (wide) ThumbCard(item, api, { onClick(item) }, thumbWidth, onLongClick = onLongClick?.let { { it(item) } }, subtitle = subtitle?.invoke(item))
                else PosterCard(item, api, { onClick(item) })
            }
        }
    }
}

// A translucent round button that stays readable over artwork (back, close).
@Composable
fun GlassIconButton(icon: ImageVector, contentDescription: String?, onClick: () -> Unit, modifier: Modifier = Modifier, glass: Float = 1f) {
    val source = remember { MutableInteractionSource() }
    Box(
        modifier
            .size(40.dp)
            .pressScale(source)
            .clip(CircleShape)
            .background(Color.Black.copy(alpha = 0.38f * glass))
            .clickable(source, null, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription, tint = G.label, modifier = Modifier.size(22.dp))
    }
}

// Content scrolls under the transparent status bar; this keeps the clock legible over it.
@Composable
fun StatusBarScrim(alpha: () -> Float = { 1f }) {
    // Opaque behind the bar, then a short fade so there is no hard edge over artwork.
    Spacer(
        Modifier.fillMaxWidth().drawBehind {
            val a = 0.94f * alpha()
            val solid = ((size.height - 16.dp.toPx()) / size.height).coerceIn(0f, 1f)
            drawRect(Brush.verticalGradient(0f to G.bg.copy(alpha = a), solid to G.bg.copy(alpha = a), 1f to G.bg.copy(alpha = 0f)))
        }.windowInsetsPadding(WindowInsets.statusBars.only(WindowInsetsSides.Top)).height(16.dp),
    )
}
