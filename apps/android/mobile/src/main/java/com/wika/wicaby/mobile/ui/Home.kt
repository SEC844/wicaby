package com.wika.wicaby.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.HomeRefresh
import androidx.navigation.NavController
import coil3.compose.AsyncImage
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.ContinueWatching
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.data.backdrop
import com.wika.wicaby.core.data.logo
import com.wika.wicaby.mobile.R
import kotlinx.coroutines.delay
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.Icon
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.produceState
import com.wika.wicaby.core.data.OfflineProgress
import com.wika.wicaby.core.data.PendingProgress
import com.wika.wicaby.core.data.withPending
import com.wika.wicaby.core.photos.homeMemories
import com.wika.wicaby.mobile.download.DlState
import com.wika.wicaby.mobile.download.Downloads
import com.wika.wicaby.mobile.player.PlayerActivity
import java.io.File
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import com.wika.wicaby.core.R as CoreR

// "music" (music spec MU-08): its own screen (music/MusicScreen.kt).
val BROWSABLE = setOf("movies", "tvshows", "homevideos", "photos", "boxsets", "mixed", "books", "livetv", "music", null)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(api: Api, nav: NavController, openTab: (Tab) -> Unit) {
    val context = LocalContext.current
    var nonce by rememberSaveable { mutableIntStateOf(0) }
    var pulled by remember { mutableStateOf(false) }
    // Both counters only grow: a music source change reloads, the list staying on screen meanwhile.
    val views = rememberLoad("views", nonce + com.wika.wicaby.core.music.MusicSource.version) { allViews(api).filter { it.collectionType in BROWSABLE } }
    val hero = rememberLoad("hero", nonce) {
        Servers.merged(api) { a ->
            a.items(
                "IncludeItemTypes" to "Movie,Series", "Recursive" to true, "SortBy" to "Random", "Limit" to 10,
                "ImageTypes" to "Backdrop", "EnableImageTypes" to "Primary,Backdrop,Logo,Thumb",
            ).items
        }.filter { it.backdropImageTags.isNotEmpty() }.take(6)
    }
    // B10: the rows below (not the random hero) also reload by themselves (HomeRefresh).
    var auto by remember { mutableIntStateOf(0) }
    val owner = LocalLifecycleOwner.current
    val refresh = remember { HomeRefresh() }
    LaunchedEffect(owner) {
        owner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            refresh.run(Core.socketMessages) {
                Cache.invalidateHome()
                auto++
            }
        }
    }
    // X-01: one "Continuer à regarder" row (resume + next up, one card per series, newest first).
    val cont = rememberLoad("continue", nonce + auto) { ContinueWatching.loadAll(api) }
    // Removed this visit (the next load leaves them out); Annuler brings them back at once.
    // Keyed by Servers.key: two servers can both have an item "12".
    val removed = remember { mutableStateListOf<String>() }
    val contItems = cont.value?.items?.filterNot { Servers.key(it) in removed }
    val contDates = cont.value?.seriesDates.orEmpty()
    var menuFor by remember { mutableStateOf<Item?>(null) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val removedText = stringResource(CoreR.string.removed_from_continue)
    val undoText = stringResource(CoreR.string.undo)
    val latest = views.value.orEmpty().filter { it.collectionType != "boxsets" && it.collectionType != "livetv" }.map { v -> v to rememberLoad("latest-${Servers.libraryRef(v)}", nonce + auto) { Servers.forItem(v, api).latest(v.id) } }
    // "Ce jour-là" (photos PH-08): with a photo library, the primary server's photos of this day in earlier years, asked
    // once a day (core homeMemories). shortcut: the primary server only, as on TV.
    val today = String.format(java.util.Locale.ROOT, "%tF", java.util.Calendar.getInstance())
    // An Immich source brings its own memories (photos spec PH-13).
    val photoSources by com.wika.wicaby.core.files.FileSources.photos.collectAsState()
    val memories = if (com.wika.wicaby.core.photos.Immich.source != null || photoSources.isNotEmpty() || views.value.orEmpty().any { it.collectionType in com.wika.wicaby.mobile.ui.photos.PHOTO_COLLECTIONS }) rememberLoad("memories-$today") { api.homeMemories(today) } else null

    val busy = views.loading || hero.loading || cont.loading
    LaunchedEffect(busy) { if (!busy) pulled = false }
    val state = rememberPullToRefreshState()
    val list = rememberLazyListState()

    val offline = views.value == null && views.error != null
    PullToRefreshBox(
        isRefreshing = pulled && busy,
        onRefresh = {
            pulled = true
            nonce++
        },
        state = state,
        modifier = Modifier.fillMaxSize(),
        indicator = {
            PullToRefreshDefaults.Indicator(
                state = state, isRefreshing = pulled && busy, containerColor = G.elevated2, color = G.label,
                modifier = Modifier.align(Alignment.TopCenter).statusBarsPadding(),
            )
        },
    ) {
        when {
            offline -> OfflineHome(api, onRetry = { nonce++ }, onDownloads = { openTab(Tab.Downloads) })
            views.value == null -> Centered { Spinner() }
            else -> Box(Modifier.fillMaxSize()) {
              LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = 28.dp)) {
                val heroItems = hero.value.orEmpty()
                if (heroItems.isNotEmpty()) {
                    item("hero", contentType = "hero") {
                        HeroCarousel(api, heroItems, onPlay = { play(context, it) }, onInfo = { nav.open(it) })
                    }
                } else {
                    item("top") { Spacer(Modifier.statusBarsPadding().height(12.dp)) }
                }
                // A sideloaded update (checked at start, at most every 6 h).
                item("update") { UpdateCard(Modifier.padding(horizontal = 20.dp, vertical = 10.dp)) }
                contItems?.takeIf { it.isNotEmpty() }?.let { list ->
                    item("continue", contentType = "row") {
                        Box {
                            MediaRow(
                                stringResource(CoreR.string.continue_watching_merged), list, api, wide = true, onClick = { play(context, it) },
                                onLongClick = { menuFor = it }, subtitle = { ContinueWatching.subtitle(it) },
                            )
                            DropdownMenu(menuFor != null, { menuFor = null }, containerColor = G.elevated2, shape = RoundedCornerShape(Radius.md)) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(CoreR.string.remove_from_continue), style = Type.body, color = G.label) },
                                    onClick = {
                                        val item = menuFor ?: return@DropdownMenuItem
                                        menuFor = null
                                        removed += Servers.key(item)
                                        scope.launch {
                                            ContinueWatching.remove(Servers.forItem(item, api), item, contDates)
                                            // Shown for 5 s: dismissed when the timeout cancels it.
                                            val r = withTimeoutOrNull(5_000) { snackbar.showSnackbar(removedText, undoText, duration = SnackbarDuration.Indefinite) }
                                            if (r == SnackbarResult.ActionPerformed) {
                                                removed -= Servers.key(item)
                                                ContinueWatching.undo(Servers.forItem(item, api), item)
                                            }
                                        }
                                    },
                                )
                            }
                        }
                    }
                }
                latest.forEach { (view, load) ->
                    load.value?.takeIf { it.isNotEmpty() }?.let { list ->
                        item("latest-${Servers.libraryRef(view)}", contentType = "row") {
                            MediaRow(stringResource(R.string.latest_in, viewLabel(view, views.value.orEmpty())), list, api, wide = false, onClick = { nav.open(it) })
                        }
                    }
                }
                memories?.value?.takeIf { it.isNotEmpty() }?.let { groups ->
                    item("memories", contentType = "row") { com.wika.wicaby.mobile.ui.photos.MemoriesRow(api, groups) }
                }
                val empty = heroItems.isEmpty() && contItems?.isEmpty() == true && latest.all { it.second.value?.isEmpty() == true }
                if (empty) item("empty") { Centered(Modifier.heightIn(min = 320.dp)) { Text(stringResource(R.string.empty_home), style = Type.title3, color = G.label2) } }
              }
              StatusBarScrim { if (list.firstVisibleItemIndex > 0) 1f else (list.firstVisibleItemScrollOffset / 500f).coerceIn(0f, 1f) }
              SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(16.dp))
            }
        }
    }
}

// Server unreachable: this account's downloads play from here, with the progress watched offline
// (OfflineProgress), under a banner that tries the server again. Nothing downloaded: the error page.
@Composable
private fun OfflineHome(api: Api, onRetry: () -> Unit, onDownloads: () -> Unit) {
    val context = LocalContext.current
    val entries by Downloads.entries.collectAsState()
    // TP-06: the extra accounts' downloads too, each played and synced against its own server.
    val done = entries.filter { e -> e.state == DlState.Done && Servers.all.any { it.server.id == e.serverId && it.userId == e.userId } }.sortedBy { it.item.seriesName ?: it.item.name }
    // Re-read on every return to the screen: the player (its own task) records progress meanwhile.
    var resumes by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) {
        resumes++
        onPauseOrDispose {}
    }
    val pending by produceState(emptyList<PendingProgress>(), entries, resumes) { value = OfflineProgress.pending() }
    if (done.isEmpty()) {
        Centered { ErrorState(onRetry) { PillButton(stringResource(R.string.nav_downloads), onDownloads, icon = Ic.Download) } }
        return
    }
    LazyVerticalGrid(
        columns = GridCells.Adaptive(108.dp),
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 24.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        item("banner", span = { GridItemSpan(maxLineSpan) }) {
            Row(
                Modifier.statusBarsPadding().padding(top = 12.dp).clip(RoundedCornerShape(Radius.lg)).background(G.elevated).padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Ic.WifiOff, null, tint = G.label2, modifier = Modifier.size(24.dp))
                Column(Modifier.weight(1f).padding(horizontal = 14.dp)) {
                    Text(stringResource(R.string.load_error), style = Type.headline, color = G.label)
                    Text(stringResource(R.string.offline_hint), style = Type.footnote, color = G.label2)
                }
                PillButton(stringResource(R.string.retry), onRetry, icon = Ic.Refresh, compact = true)
            }
        }
        item("title", span = { GridItemSpan(maxLineSpan) }) { Text(stringResource(R.string.tab_downloads), style = Type.title3, color = G.label, modifier = Modifier.padding(top = 10.dp)) }
        items(done, key = { "${it.serverId}:${it.id}" }, contentType = { "poster" }) { e ->
            // Local artwork: no server to ask.
            val art = remember(e.poster) { e.poster?.let(::File)?.takeIf { it.exists() } }
            PosterCard(e.item.withPending(pending, e.serverId, e.userId), api, onClick = { PlayerActivity.start(context, e.id, false, server = Servers.extraOf(e.serverId)?.server?.id) }, width = null, art = art)
        }
    }
}

@Composable
private fun HeroCarousel(api: Api, items: List<Item>, onPlay: (Item) -> Unit, onInfo: (Item) -> Unit) {
    val pager = rememberPagerState { items.size }
    // Advances every 8 s unless the viewer is swiping.
    LaunchedEffect(pager.settledPage, items.size) {
        if (items.size < 2) return@LaunchedEffect
        delay(8_000)
        if (!pager.isScrollInProgress) pager.animateScrollToPage((pager.settledPage + 1) % items.size)
    }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val compact = maxWidth < 600.dp
        // Portrait phones: a tall, poster-like stage; wide windows: a cinema strip.
        val h = if (compact) (maxWidth * 1.18f).coerceAtMost(600.dp) else (maxWidth * 0.42f).coerceIn(340.dp, 540.dp)
        val px = dpPx(if (compact) maxWidth * 2f else maxWidth)
        Column {
            HorizontalPager(pager, key = { Servers.key(items[it]) }, modifier = Modifier.fillMaxWidth().height(h), beyondViewportPageCount = 1) { page ->
                val item = items[page]
                Box(Modifier.fillMaxSize().clickable(interactionSource = null, indication = null) { onInfo(item) }) {
                    val url = remember(item.id, px) { Servers.forItem(item, api).backdrop(item, px) }
                    AsyncImage(url, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    // Artwork scrims: legible status bar on top, a fade into the page below.
                    Box(Modifier.fillMaxWidth().height(110.dp).background(Brush.verticalGradient(listOf(G.bg.copy(alpha = 0.45f), G.bg.copy(alpha = 0f)))))
                    Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().fillMaxHeight(0.6f).background(Brush.verticalGradient(listOf(G.bg.copy(alpha = 0f), G.bg.copy(alpha = 0.7f), G.bg))))
                    Column(Modifier.align(Alignment.BottomStart).padding(start = 20.dp, end = 20.dp, bottom = 14.dp).widthIn(max = 560.dp)) {
                        HeroTitle(api, item)
                        Text(metaLine(item), style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
                        Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            PillButton(stringResource(if (item.resumeMs > 0) R.string.resume else R.string.play), { onPlay(item) }, icon = Ic.Play, primary = true)
                            PillButton(stringResource(R.string.more_info), { onInfo(item) }, onArt = true)
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally)) {
                repeat(items.size) { i ->
                    val sel = i == pager.currentPage
                    // Instant, like every selection: an animated width relays the row out every frame of a swipe.
                    Box(Modifier.width(if (sel) 16.dp else 6.dp).height(6.dp).clip(CircleShape).background(if (sel) G.label else G.label3))
                }
            }
        }
    }
}

@Composable
fun HeroTitle(api: Api, item: Item, maxLogoHeight: androidx.compose.ui.unit.Dp = 84.dp) {
    val logo = remember(item.id) { Servers.forItem(item, api).logo(item, 800) }
    var failed by remember(item.id) { mutableStateOf(false) }
    if (logo != null && !failed) {
        AsyncImage(
            logo, item.name, contentScale = ContentScale.Fit, alignment = Alignment.CenterStart, onError = { failed = true },
            modifier = Modifier.heightIn(max = maxLogoHeight).widthIn(max = 300.dp),
        )
    } else {
        Text(item.seriesName?.takeIf { item.isEpisode } ?: item.name, style = Type.hero, color = G.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}
