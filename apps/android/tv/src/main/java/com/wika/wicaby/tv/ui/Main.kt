package com.wika.wicaby.tv.ui

import androidx.compose.foundation.layout.aspectRatio
import com.wika.wicaby.core.data.LetterIndex
import com.wika.wicaby.core.data.Servers
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.wika.wicaby.core.VoiceSearch
import com.wika.wicaby.tv.ui.livetv.liveHitRows
import com.wika.wicaby.core.data.backdrop
import com.wika.wicaby.core.data.logo
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.flow.collectLatest
import com.wika.wicaby.core.livetv.FormFactor
import com.wika.wicaby.core.livetv.DeviceClassDetector
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.foundation.focusGroup
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import com.wika.wicaby.tv.BuildConfig
import com.wika.wicaby.tv.LocalApi
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.LocalSnapshot
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.Route
import com.wika.wicaby.tv.Wicaby
import com.wika.wicaby.core.data.AccessSchedules
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.ContinueWatching
import com.wika.wicaby.core.data.HomeRows
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ItemsResult
import com.wika.wicaby.core.data.Session
import com.wika.wicaby.core.data.User
import com.wika.wicaby.tv.data.TvSettings
import androidx.activity.compose.BackHandler
import com.wika.wicaby.core.data.runtimeText
import com.wika.wicaby.tv.play
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import com.wika.wicaby.core.photos.homeMemories

// music: rows of albums, playlists, artists and genres (music/MusicHome.kt, MU-09).
private val BROWSABLE = setOf("movies", "tvshows", "homevideos", "photos", "boxsets", "mixed", "livetv", "books", "music", null)

/** The libraries that get a tab of their own (Home's rows take every library). */
fun tabViews(libs: List<Item>) = libs.filter { it.collectionType in BROWSABLE }

fun Item.route(): Route =
    Servers.extraOf(serverId)?.server?.id.let { sid ->
        when {
            // Photos (PH-06): an album opens its photo timeline.
            type == "PhotoAlbum" -> Route.PhotoAlbum(id, name, sid)
            // Music (MU-09): an album or an audio playlist opens its page (art, tracks, Lire / Aléatoire / Mix).
            type == "MusicAlbum" || (type == "Playlist" && mediaType == "Audio") -> Route.MusicAlbum(id, name, sid)
            // An artist opens their page (albums, singles, appears on), as on desktop and mobile.
            type == "MusicArtist" -> Route.MusicArtist(id, name, sid)
            isFolder && !isSeries && type != "Season" -> Route.Folder(id, name, sid)
            else -> Route.Detail(id, sid)
        }
    }

// One top-level destination of the tab bar. Libraries come from the server; other
// screens (Torrents, ...) are listed in extraTabs() and appear before Recherche.
private class Dest(val tab: TopTab, val content: @Composable (onScrolled: (Boolean) -> Unit) -> Unit)

@Composable
private fun extraTabs(): List<Dest> = listOf(
    Dest(TopTab("torrents", stringResource(R.string.tab_torrents), TorrentsIcon)) { onScrolled -> TorrentsTab(onScrolled = onScrolled, top = 104.dp) },
)

@OptIn(ExperimentalComposeUiApi::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun MainScreen() {
    val api = LocalApi.current ?: return
    val nav = LocalNav.current
    val overlay = LocalOverlay.current
    val snap = LocalSnapshot.current
    val activity = checkNotNull(LocalActivity.current)
    // TP-07: Home's rows need every library (music, Live TV…); the tabs only the browsable ones.
    // A music source change reloads them, keeping the tabs on screen meanwhile (and if the server does not answer).
    val loadedLibs = rememberLoad("views", nonce = com.wika.wicaby.core.music.MusicSource.version) { allViews(api) }.value.value
    val libs = loadedLibs.orEmpty()
    val views = tabViews(libs)
    val user = rememberLoad("me-${api.userId}") { api.get<User>("/Users/${api.userId}") }.value.value
    var tab by rememberSaveable { mutableStateOf("home") }
    // Onboarding Done → Réglages > Accès à distance (SettingsTab picks the section and clears the link).
    LaunchedEffect(SettingsLink.remote) { if (SettingsLink.remote) tab = "settings" }
    var scrolled by remember { mutableStateOf(false) }
    var barFocused by remember { mutableStateOf(false) }
    val tabHolder = rememberSaveableStateHolder()

    val onScrolled: (Boolean) -> Unit = { scrolled = it }
    val fileSources by com.wika.wicaby.core.files.FileSources.list.collectAsState()
    val photoSources by com.wika.wicaby.core.files.FileSources.photos.collectAsState()
    val dests = buildList {
        add(Dest(TopTab("home", stringResource(R.string.tab_home))) { HomeTab(api, libs, it) })
        // IPTV (core/iptv) comes right after Live TV; without a server tuner, Live TV stays on its setup page.
        val iptv = Dest(TopTab("iptv", stringResource(com.wika.wicaby.core.R.string.iptv_title))) { com.wika.wicaby.tv.ui.livetv.IptvTab(top = 104.dp, onScrolled = it) }
        val lastLive = views.lastOrNull { it.collectionType == "livetv" }
        views.forEach { v ->
            // TP-06: an extra server's library is its own tab, named after its server when a name repeats.
            val extra = Servers.extraOf(v.serverId)
            add(
                Dest(TopTab(if (extra == null) "lib:${v.id}" else "lib:${extra.server.id}:${v.id}", viewLabel(v, views))) {
                    if (v.collectionType == "livetv") com.wika.wicaby.tv.ui.livetv.LiveTvScreen(api, top = 104.dp, onScrolled = it)
                    else ServerScope(extra?.server?.id) { LibraryTab(extra ?: api, v, onScrolled = it) }
                },
            )
            if (v === lastLive) add(iptv)
        }
        if (lastLive == null && loadedLibs != null) {
            add(Dest(TopTab("livetv-setup", stringResource(com.wika.wicaby.core.R.string.livesetup_title))) { com.wika.wicaby.tv.ui.livetv.LiveSetupTab(top = 104.dp, onIptv = { tab = "iptv" }) })
            add(iptv)
        }
        // File sources (FS-10): after the libraries, once one exists (Réglages > Sources de fichiers adds the first).
        if (fileSources.isNotEmpty()) add(Dest(TopTab("files", stringResource(com.wika.wicaby.core.R.string.files_title))) { FilesTab(it) })
        // Immich photo source (photos spec PH-13): its own library tab.
        com.wika.wicaby.core.photos.Immich.source?.let { s ->
            add(Dest(TopTab("immich", s.name)) { com.wika.wicaby.tv.ui.photos.PhotosTab(api, s.id, s.name, top = 104.dp, onScrolled = it, kind = com.wika.wicaby.tv.ui.photos.IMMICH) })
        }
        // Photo sources (a folder or a share used as a photo library): each its own tab, like Immich.
        photoSources.forEach { s ->
            add(Dest(TopTab("photos:${s.id}", s.name)) { scroll ->
                ServerScope(s.id) { LocalApi.current?.let { a -> com.wika.wicaby.tv.ui.photos.PhotosTab(a, com.wika.wicaby.core.files.pure.Ids.ROOT, s.name, top = 104.dp, onScrolled = scroll) } }
            })
        }
        addAll(extraTabs())
        // Réglages > Barre d'onglets lists these, in their default order.
        val movable = map { it.tab }.filter { it.key != TabOrder.HOME }
        add(Dest(TopTab("search", stringResource(R.string.tab_search), Ic.Search)) { SearchTab(api, live = views.any { it.collectionType == "livetv" }) })
        add(Dest(TopTab("settings", stringResource(R.string.tab_settings), Ic.Gear)) { SettingsTab(api, user, movable, it) })
    }
    // #6: the user's order, hidden tabs left out (the content below still resolves them, for programmatic jumps).
    val byKey = dests.associateBy { it.tab.key }
    val tabs = TabOrder.bar(dests.map { it.tab.key }, TvSettings.tabBar(homeUser(api)), current = tab).map { byKey.getValue(it).tab }
    // TV-3: the live player's GUIDE / Back lands on the Live TV tab, whose screen opens the Guide on the channel.
    val liveView = views.firstOrNull { it.collectionType == "livetv" }?.id
    LaunchedEffect(liveView) {
        com.wika.wicaby.tv.ui.livetv.LiveTv.guideFor.collect { a ->
            if (a == null) return@collect
            if (com.wika.wicaby.tv.ui.livetv.LiveTv.serverId == com.wika.wicaby.core.iptv.Iptv.SERVER_ID) tab = "iptv" else if (liveView != null) tab = "lib:$liveView"
        }
    }

    // The tab bar floats over the content, so plain geometric search cannot go down
    // from it; Down jumps into the content, which restores its last focused child.
    val content = remember { FocusRequester() }
    val avatar = remember { FocusRequester() }
    val tabRequesters = remember(tabs.map { it.key }) { tabs.associate { it.key to FocusRequester() } }

    val quitTitle = stringResource(R.string.quit_title)
    val quit = stringResource(R.string.quit)
    val cancel = stringResource(R.string.cancel)
    // Back: from the content, up to the tab bar (tvOS); from the bar, the exit confirmation.
    BackHandler(enabled = nav.depth == 1 && !overlay.open) {
        if (!barFocused) {
            runCatching { tabRequesters[tab]?.requestFocus() }
        } else {
            overlay.show(tabRequesters[tab]) {
                TvAlert(
                    quitTitle, null,
                    listOf(
                        AlertAction(quit, destructive = true) { overlay.close(); activity.finish() },
                        AlertAction(cancel) { overlay.close() },
                    ),
                    focusIndex = 1, onDismiss = overlay::close,
                )
            }
        }
    }

    fun openProfile() {
        val session = snap.session ?: return
        overlay.show(avatar) {
            ProfileMenu(api, user, session, onDismiss = overlay::close, onSettings = {
                overlay.close()
                tab = "settings"
                scrolled = false
            })
        }
    }

    Box(Modifier.fillMaxSize()) {
        Box(
            Modifier
                .fillMaxSize()
                .focusProperties {
                    @Suppress("DEPRECATION")
                    exit = { dir -> if (dir == FocusDirection.Up) tabRequesters[tab] ?: FocusRequester.Default else FocusRequester.Default }
                }
                .focusRequester(content)
                .focusRestorer()
                // Its own focus target: without it these properties land on the first focus target inside the tab
                // (a grid's or row's group) and replace that one's exit rule (dpadEdges).
                .focusGroup(),
        ) {
            CompositionLocalProvider(LocalAutoFocus provides !barFocused) {
                tabHolder.SaveableStateProvider(tab) {
                    (dests.firstOrNull { it.tab.key == tab } ?: dests.first()).content(onScrolled)
                }
            }
        }
        TopBar(
            tabs, tab, tabRequesters, content, avatar, barFocused,
            // Typing: the keyboard takes the lower half, the field may scroll up under the bar.
            visible = (barFocused || !scrolled) && !WindowInsets.isImeVisible,
            showClock = TvSettings.clock.value,
            user = user, api = api, userName = snap.session?.userName.orEmpty(),
            onSelect = {
                if (tab != it) {
                    tab = it
                    scrolled = false
                }
            },
            onFocus = { barFocused = it },
            onAvatar = ::openProfile,
            modifier = Modifier.align(Alignment.TopCenter),
        )
    }
}

@Composable
private fun ProfileMenu(api: Api, user: User?, session: Session, onDismiss: () -> Unit, onSettings: () -> Unit) {
    val nav = LocalNav.current
    // Navigate first: signing out drops the api, which disposes this screen and its scope.
    fun leave(route: Route, revoke: Boolean) {
        onDismiss()
        nav.reset(route)
        com.wika.wicaby.tv.signOutCleanup() // Changer de serveur too: its music must not play on with this token
        com.wika.wicaby.core.Core.scope.launch {
            // A token shared by the phone (pairing) stays valid: revoking it would sign the phone out.
            if (revoke && !session.shared) runCatching { api.raw("POST", "/Sessions/Logout") }
            // TP-10: signing out forgets the saved profile (and its PIN); Changer d’utilisateur keeps it.
            if (revoke) Wicaby.app.prefs.removeProfile(session.server.id, session.userId)
            Wicaby.app.prefs.signOut()
        }
    }
    TvSheet(onDismiss, alignment = Alignment.TopEnd, width = 340.dp, padding = PaddingValues(top = 76.dp, end = 32.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 20.dp)) {
            UserAvatar(user, api, session.userName, 52.dp)
            Column(Modifier.padding(start = 14.dp)) {
                Text(session.userName, style = Type.title3, color = C.label, maxLines = 1)
                Text(session.server.name, style = Type.footnote, color = C.label3, maxLines = 1)
            }
        }
        val first = remember { FocusRequester() }
        LaunchedEffect(Unit) {
            delay(60)
            runCatching { first.requestFocus() }
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            SheetButton(stringResource(R.string.switch_user), icon = Ic.Person, onClick = { onDismiss(); nav.push(Route.Login(session.server)) }, modifier = Modifier.focusRequester(first))
            SheetButton(stringResource(R.string.switch_server), icon = Ic.Server, onClick = { leave(Route.Servers, false) })
            // TP-08: desktop's account menu opens History too.
            SheetButton(stringResource(com.wika.wicaby.core.R.string.history), icon = Ic.History, onClick = { onDismiss(); nav.push(Route.History) })
            SheetButton(stringResource(R.string.tab_settings), icon = Ic.Gear, onClick = onSettings)
            SheetButton(stringResource(R.string.sign_out), icon = Ic.Logout, onClick = { leave(Route.Login(session.server), true) })
        }
    }
}

// ---------------------------------------------------------------------------
// Home: hero carousel over a full-bleed backdrop, then rows.

// The hero's titles: random movies and series that have a backdrop. With hideWatched, unwatched ones only, falling
// back to every title when none is left, so the carousel never goes empty.
private suspend fun heroItems(api: Api, hideWatched: Boolean): List<Item> {
    suspend fun pick(unwatched: Boolean) = Servers.merged(api) { a ->
        a.items(
            "IncludeItemTypes" to "Movie,Series", "Recursive" to true, "SortBy" to "Random", "Limit" to 8,
            "ImageTypes" to "Backdrop", "EnableImageTypes" to "Primary,Backdrop,Logo,Thumb",
            "Filters" to if (unwatched) "IsUnplayed" else null,
        ).items
    }.filter { it.backdropImageTags.isNotEmpty() }.take(6)
    return if (hideWatched) pick(unwatched = true).ifEmpty { pick(unwatched = false) } else pick(unwatched = false)
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HomeTab(api: Api, views: List<Item>, onScrolled: (Boolean) -> Unit) {
    val showHero = TvSettings.rowHero.value
    val merged = TvSettings.mergeContinue.value
    // TP-07: the user's rows, in their order (Réglages > Accueil); only the shown ones are loaded.
    val latestViews = latestViews(views)
    val homeDefaults = homeDefaults(views, merged)
    val homePref = TvSettings.homeRows(homeUser(api), homeDefaults)
    val shown = HomeRows.arrange(homeDefaults, homePref).filter { it !in homePref.hidden }
    val showResume = HomeRows.RESUME in shown
    val context = LocalContext.current
    val nav = LocalNav.current
    val memory = rememberFocusMemory()
    val overlay = LocalOverlay.current
    val scope = rememberCoroutineScope()
    val hideWatched = TvSettings.heroHideWatched.value
    val hero = rememberLoad(if (hideWatched) "hero-unwatched" else "hero", refresh = false) { heroItems(api, hideWatched) }.value
    // X-01: one "Continuer à regarder" row (resume + next up) while merge_continue is on (the default).
    val cont = if (merged && showResume) rememberLoad("continue") { ContinueWatching.loadAll(api) }.value else null
    val resume = if (merged || !showResume) null else rememberLoad("resume") { Servers.merged(api, byDate = true) { it.resume() } }.value
    val nextUp = if (merged || HomeRows.NEXT_UP !in shown) null else rememberLoad("nextup") { Servers.merged(api, byDate = true) { it.nextUp() } }.value
    val upcoming = if (HomeRows.UPCOMING in shown) rememberLoad("upcoming") { Servers.byAirDate(Servers.merged(api) { it.upcoming() }) }.value else null
    // Desktop's "Live TV" row: each Live TV server's first 24 channels, those airing something now.
    val liveNow = if (HomeRows.LIVE_NOW in shown) {
        rememberLoad("live-now") {
            HomeRows.onNow(Servers.merge(Servers.fanOut(liveViews(views).map { Servers.forItem(it, api) }.distinctBy { it.server.id }) { it.liveChannels() }))
        }.value
    } else null
    // Removed this visit (the next load leaves them out); Annuler brings them back at once.
    // Keyed by Servers.key: two Emby servers can both have an item "12".
    val removed = remember { mutableStateListOf<String>() }
    val contItems = cont?.value?.items?.filterNot { Servers.key(it) in removed }
    // Desktop Home.svelte showServer={multi}: merged rows name each card's server.
    val multi = Servers.multi
    val contDates = cont?.value?.seriesDates.orEmpty()
    val contRow = remember { FocusRequester() }
    // Row ids, load and list keys use Servers.libraryRef: two servers can both have a "lib-movies".
    val latest = latestViews.filter { HomeRows.latest(Servers.libraryRef(it)) in shown }.map { v -> v to rememberLoad("latest-${Servers.libraryRef(v)}") { Servers.forItem(v, api).latest(v.id) }.value }
    // Desktop's "Because you watched": titles similar to the 2 latest played, minus what the rows above show.
    val played = if (HomeRows.BECAUSE in shown) {
        rememberLoad("because") {
            Servers.merged(api, byDate = true) { it.items("Filters" to "IsPlayed", "Recursive" to true, "IncludeItemTypes" to "Movie,Episode", "SortBy" to "DatePlayed", "SortOrder" to "Descending", "Limit" to 20).items }
        }.value.value
    } else null
    // "Ce jour-là" (photos PH-08): the primary server's photos of this day in earlier years, one card per year, kept
    // until the date changes. shortcut: the primary server only; fan out like the other rows if users ask.
    val today = String.format(java.util.Locale.ROOT, "%tF", java.util.Calendar.getInstance())
    val memories = if (HomeRows.MEMORIES in shown) rememberLoad("memories-$today", refresh = false) { api.homeMemories(today) }.value else null
    val becauseLoads = HomeRows.becauseSeeds(played.orEmpty()).map { s -> s to rememberLoad("similar-${Servers.key(s)}") { Servers.forItem(s, api).similar(s.id, 16) }.value }
    var seen = (contItems.orEmpty() + resume?.value.orEmpty() + nextUp?.value.orEmpty() + latest.flatMap { it.second.value.orEmpty() })
    val because = becauseLoads.map { (seed, load) -> seed to HomeRows.unseen(load.value.orEmpty(), seen).also { seen = seen + it } }

    val heroItems = if (showHero) hero.value.orEmpty() else emptyList()
    var heroIndex by rememberSaveable { mutableIntStateOf(0) }
    val heroItem = heroItems.getOrNull(heroIndex.coerceAtMost((heroItems.size - 1).coerceAtLeast(0)))
    var heroFocused by remember { mutableStateOf(false) }
    var focusedItem by remember { mutableStateOf<Item?>(null) }
    var bgUrl by remember { mutableStateOf<String?>(null) }
    // focusedItem is read in a snapshotFlow, never in composition: a D-pad move must not recompose the whole Home.
    val heroNow by rememberUpdatedState(heroItem)
    val lowTv = remember { DeviceClassDetector.detect(context, FormFactor.TV).isLow }
    LaunchedEffect(api) {
        snapshotFlow { if (heroFocused || focusedItem == null) heroNow else focusedItem }
            .distinctUntilChangedBy { it?.id }
            .collectLatest { target ->
                if (!heroFocused) delay(280)
                // It sits under 62-94 % gradients: 1280 px is plenty on tv-low.
                bgUrl = target?.let { Servers.forItem(it, api).backdrop(it, if (lowTv) 1280 else 1920) } ?: bgUrl
            }
    }

    val listState = rememberLazyListState()
    LaunchedEffect(listState) {
        snapshotFlow { listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > 80 }.collect(onScrolled)
    }
    // Rows settle with their cards at a fixed line; the hero always scrolls fully back into view.
    val pivotSpec = remember(listState) {
        PivotSpec(0.26f) {
            if (heroFocused) listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key == "hero" }?.offset?.toFloat() ?: 0f else null
        }
    }

    fun openRow(item: Item, playable: Boolean) {
        if (playable) play(context, item) else nav.push(item.route())
    }

    Box(Modifier.fillMaxSize()) {
        Backdrop(bgUrl, dim = if (heroFocused) 0f else 0.42f)
        val loading = hero.value == null && hero.error == null && (if (merged) cont?.value == null else resume?.value == null)
        if (loading) {
            Centered { Spinner() }
        }
        // Every row loaded and empty (null: still loading); hidden rows are not loaded.
        val rowLists = buildList {
            if (cont != null) add(contItems)
            if (resume != null) add(resume.value)
            if (nextUp != null) add(nextUp.value)
            if (upcoming != null) add(upcoming.value)
            if (liveNow != null) add(liveNow.value)
            if (memories != null) add(memories.value?.flatMap { (_, p) -> p.map { it.item } })
            latest.forEach { add(it.second.value) }
            becauseLoads.forEach { add(it.second.value) }
        }
        val allEmpty = hero.value?.isEmpty() == true && rowLists.all { it?.isEmpty() == true } && (played != null || HomeRows.BECAUSE !in shown)
        if (allEmpty) Centered { Text(stringResource(R.string.empty_home), style = Type.title3, color = C.label2) }
        // TP-11: nothing loads (outside the parental hours, or the server is down): say why instead of a blank home.
        val heroError = hero.error
        val refusal by produceState<String?>(null, heroError) {
            if (heroError != null) {
                AccessSchedules.refresh(api) // Jellyfin still answers /Users/{id}: the hours of a first refusal
                value = AccessSchedules.explain(context, api.server.id, api.userId, heroError)
            }
        }
        if (heroError != null && heroItem == null && rowLists.all { it.isNullOrEmpty() }) Centered { ErrorState(refusal) { Cache.changed() } }
        CompositionLocalProvider(LocalBringIntoViewSpec provides pivotSpec) {
            LazyColumn(state = listState, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 80.dp)) {
                if (heroItem != null) {
                    item("hero", contentType = "hero") {
                        Hero(
                            api, heroItems, heroIndex, heroItem, memory, heroFocused,
                            onIndex = { heroIndex = it },
                            onFocus = { heroFocused = it },
                            onPlay = { play(context, heroItem) },
                            onInfo = { nav.push(heroItem.route()) },
                        )
                    }
                } else {
                    item("top", contentType = "top") { Spacer(Modifier.height(104.dp)) }
                }
                // The one-time living-room theme suggestion (ThemeCards.kt).
                if (TvSettings.theme.value == "graphite" && !TvSettings.themeHintShown.value) item("theme-hint", contentType = "hint") { ThemeHint() }
                shown.forEach { id ->
                    when (id) {
                        HomeRows.RESUME -> {
                        contItems?.takeIf { it.isNotEmpty() }?.let { list ->
                            item("continue", contentType = "row") {
                                // Holding SELECT on a card opens a minimal menu (X-11 builds the full one).
                                var held by remember { mutableStateOf(false) }
                                fun undoPrompt(item: Item) = overlay.show(contRow) {
                                    LaunchedEffect(Unit) {
                                        delay(5000)
                                        overlay.close()
                                    }
                                    TvAlert(
                                        stringResource(com.wika.wicaby.core.R.string.removed_from_continue), null,
                                        listOf(
                                            AlertAction(stringResource(com.wika.wicaby.core.R.string.undo)) {
                                                removed -= Servers.key(item)
                                                overlay.close()
                                                scope.launch {
                                                    // The row was gone if this was its last card: focus it once it is back.
                                                    delay(80)
                                                    runCatching { contRow.requestFocus() }
                                                    ContinueWatching.undo(Servers.forItem(item, api), item)
                                                }
                                            },
                                        ),
                                        focusIndex = 0, onDismiss = overlay::close,
                                    )
                                }
                                fun menu(item: Item) = overlay.show(contRow) {
                                    TvAlert(
                                        item.seriesName?.takeIf { item.isEpisode } ?: item.name, null,
                                        listOf(
                                            AlertAction(stringResource(com.wika.wicaby.core.R.string.remove_from_continue)) {
                                                overlay.close()
                                                removed += Servers.key(item)
                                                scope.launch { ContinueWatching.remove(Servers.forItem(item, api), item, contDates) }
                                                undoPrompt(item)
                                            },
                                        ),
                                        focusIndex = 0, onDismiss = overlay::close,
                                    )
                                }
                                MediaRow(
                                    stringResource(com.wika.wicaby.core.R.string.continue_watching_merged), list, api, memory, "continue", wide = true,
                                    onFocusItem = { focusedItem = it }, onClick = { openRow(it, true) },
                                    subtitle = { ContinueWatching.subtitle(it) }, showServer = multi,
                                    modifier = Modifier.focusRequester(contRow).focusGroup().onPreviewKeyEvent { e ->
                                        val select = e.key == Key.DirectionCenter || e.key == Key.Enter || e.key == Key.NumPadEnter || e.key == Key.ButtonA
                                        when {
                                            !select -> false
                                            // A new press: whatever the last hold left (its release went to the menu).
                                            e.type == KeyEventType.KeyDown && e.nativeKeyEvent.repeatCount == 0 -> {
                                                held = false
                                                false
                                            }
                                            e.type == KeyEventType.KeyDown -> {
                                                val item = focusedItem
                                                held = true
                                                if (!overlay.open && item != null && item in list) menu(item)
                                                true
                                            }
                                            // The release of a hold never plays the card.
                                            e.type == KeyEventType.KeyUp && held -> {
                                                held = false
                                                true
                                            }
                                            else -> false
                                        }
                                    },
                                )
                            }
                        }
                        resume?.value?.takeIf { it.isNotEmpty() }?.let { list ->
                            item("resume", contentType = "row") {
                                MediaRow(stringResource(R.string.continue_watching), list, api, memory, "resume", wide = true, onFocusItem = { focusedItem = it }, onClick = { openRow(it, true) }, showServer = multi)
                            }
                        }
                        }
                        HomeRows.NEXT_UP -> {
                        nextUp?.value?.takeIf { it.isNotEmpty() }?.let { list ->
                            item("nextup", contentType = "row") {
                                MediaRow(stringResource(R.string.next_up), list, api, memory, "nextup", wide = true, onFocusItem = { focusedItem = it }, onClick = { openRow(it, true) }, showServer = multi)
                            }
                        }
                        }
                        HomeRows.UPCOMING -> upcoming?.value?.takeIf { it.isNotEmpty() }?.let { list ->
                            item("upcoming", contentType = "row") {
                                MediaRow(stringResource(R.string.row_upcoming), list, api, memory, "upcoming", wide = true, onFocusItem = { focusedItem = it }, onClick = { openRow(it, false) }, showServer = multi)
                            }
                        }
                        HomeRows.LIVE_NOW -> liveNow?.value?.takeIf { it.isNotEmpty() }?.let { list ->
                            item("live-now", contentType = "row") {
                                MediaRow(
                                    stringResource(R.string.row_live_now), list, api, memory, "live-now", wide = true,
                                    onFocusItem = { focusedItem = it }, onClick = { play(context, it) },
                                    card = { ch, fm -> LiveNowCard(ch, api, fm, onFocus = { focusedItem = ch }, onClick = { play(context, ch) }) },
                                )
                            }
                        }
                        HomeRows.MEMORIES -> memories?.value?.takeIf { it.isNotEmpty() }?.let { groups ->
                            item("memories", contentType = "row") {
                                val covers = groups.map { (_, p) -> com.wika.wicaby.tv.ui.photos.memoryCover(p).item }
                                MediaRow(
                                    stringResource(com.wika.wicaby.core.R.string.photos_memories_title), covers, api, memory, "memories", wide = true,
                                    onFocusItem = { focusedItem = it }, onClick = {},
                                    card = { cover, fm ->
                                        val (years, photos) = groups[covers.indexOf(cover)]
                                        com.wika.wicaby.tv.ui.photos.MemoryCard(api, years, photos, fm, onFocus = { focusedItem = cover }, onClick = { nav.push(com.wika.wicaby.tv.ui.photos.memoryRoute(years, photos)) })
                                    },
                                )
                            }
                        }
                        HomeRows.BECAUSE -> because.forEach { (seed, list) ->
                            if (list.isNotEmpty()) item("because-${Servers.key(seed)}", contentType = "row") {
                                MediaRow(stringResource(R.string.row_because, seed.name), list, api, memory, "because-${Servers.key(seed)}", wide = false, onFocusItem = { focusedItem = it }, onClick = { openRow(it, false) }, showServer = multi)
                            }
                        }
                        else -> latest.firstOrNull { HomeRows.latest(Servers.libraryRef(it.first)) == id }?.let { (view, load) ->
                            load.value?.takeIf { it.isNotEmpty() }?.let { list ->
                                item("latest-${Servers.libraryRef(view)}", contentType = "row") {
                                    MediaRow(
                                        stringResource(R.string.latest_in, viewLabel(view, latestViews)), list, api, memory, "latest-${Servers.libraryRef(view)}", wide = id in homePref.thumb,
                                        square = view.collectionType == "music",
                                        onFocusItem = { focusedItem = it }, onClick = { openRow(it, false) },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun metaLine(item: Item): String = listOfNotNull(
    item.productionYear?.toString(),
    item.officialRating,
    runtimeText(item.runTimeTicks),
    item.communityRating?.let { String.format(uiLocale(), "★ %.1f", it) },
    item.genres.take(2).joinToString(", ").ifEmpty { null },
).joinToString("  ·  ")

@Composable
private fun Hero(
    api: Api,
    items: List<Item>,
    index: Int,
    item: Item,
    memory: FocusMemory,
    focused: Boolean,
    onIndex: (Int) -> Unit,
    onFocus: (Boolean) -> Unit,
    onPlay: () -> Unit,
    onInfo: () -> Unit,
) {
    val n = items.size
    LaunchedEffect(index, focused, n) {
        if (focused && n > 1) {
            delay(9000)
            onIndex((index + 1) % n)
        }
    }
    fun step(d: Int) {
        if (n > 1) onIndex((index + d + n) % n)
    }
    Box(Modifier.fillMaxWidth().height(430.dp).onFocusChanged { onFocus(it.hasFocus) }) {
        Column(Modifier.align(Alignment.BottomStart).padding(start = 56.dp, bottom = 34.dp).width(520.dp)) {
            AnimatedContent(item, transitionSpec = { fadeIn(tween(420, 120)) togetherWith fadeOut(tween(180)) }, contentKey = { it.id }, label = "hero") { it ->
                HeroText(api, it)
            }
            Spacer(Modifier.height(22.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                val resume = item.resumeMs > 0
                Pill(
                    stringResource(if (resume) R.string.resume else R.string.play), onClick = onPlay, icon = Ic.Play, primary = true,
                    modifier = Modifier.remembered(memory, "hero-play", default = true).onPreviewKeyEvent {
                        if (it.key == Key.DirectionLeft && it.type == KeyEventType.KeyDown) { step(-1); true } else false
                    },
                )
                Pill(
                    stringResource(R.string.more_info), onClick = onInfo, icon = Ic.Info,
                    modifier = Modifier.remembered(memory, "hero-info").onPreviewKeyEvent {
                        if (it.key == Key.DirectionRight && it.type == KeyEventType.KeyDown) { step(1); true } else false
                    },
                )
            }
            Spacer(Modifier.height(20.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                repeat(n) { i ->
                    val w by animateDpAsState(if (i == index) 18.dp else 6.dp, label = "dot")
                    Box(Modifier.width(w).height(6.dp).clip(CircleShape).background(if (i == index) C.label else C.label3))
                }
            }
        }
    }
}

@Composable
fun HeroText(api: Api, item: Item, overviewLines: Int = 3) {
    Column {
        val logo = remember(item.id) { Servers.forItem(item, api).logo(item) }
        var logoFailed by remember(item.id) { mutableStateOf(false) }
        if (logo != null && !logoFailed) {
            AsyncImage(
                logo, item.name, contentScale = ContentScale.Fit, alignment = Alignment.CenterStart,
                onError = { logoFailed = true },
                modifier = Modifier.heightIn(max = 96.dp).widthIn(max = 380.dp),
            )
        } else {
            Text(item.seriesName?.takeIf { item.isEpisode } ?: item.name, style = Type.hero, color = C.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(12.dp))
        Text(metaLine(item), style = Type.callout, color = C.label2, maxLines = 1)
        item.overview?.takeIf { it.isNotBlank() }?.let {
            Spacer(Modifier.height(10.dp))
            Text(it, style = Type.body, color = C.label2, maxLines = overviewLines, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** A library tab's screen: music rows, the photo timeline, or the grid. */
@Composable
fun LibraryTab(api: Api, v: Item, top: androidx.compose.ui.unit.Dp = 104.dp, onScrolled: (Boolean) -> Unit = {}) = when (v.collectionType) {
    "music" -> com.wika.wicaby.tv.music.MusicHome(api, v.id, v.name, top = top, onScrolled = onScrolled)
    // Photos (PH-06; decision O3: home videos open in the photo timeline too).
    in com.wika.wicaby.tv.ui.photos.PHOTO_COLLECTIONS -> com.wika.wicaby.tv.ui.photos.PhotosTab(api, v.id, v.name, top = top, onScrolled = onScrolled)
    else -> LibraryGrid(api, v.id, v.name, v.collectionType, top = top, onScrolled = onScrolled)
}

// ---------------------------------------------------------------------------
// Library grid (a tab, or a pushed folder).

// Sparse: the list is the library's full length once the first page is in, null where a page is not loaded yet,
// so an A–Z jump lands far ahead without loading what lies before it.
private class Paged {
    val items = mutableStateListOf<Item?>()
    var total by mutableIntStateOf(-1)
    val inFlight = HashSet<Int>()
    // The A–Z rail: each letter's first offset (LetterIndex), null until counted.
    var letters by mutableStateOf<IntArray?>(null)
}

private const val PAGE = 120

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun LibraryGrid(
    api: Api,
    parentId: String,
    title: String,
    collectionType: String?,
    top: androidx.compose.ui.unit.Dp,
    defaultFocus: Boolean = false,
    onScrolled: (Boolean) -> Unit = {},
    // A music library: the grid it opens on (MUSIC_*).
    initialMode: Int = MUSIC_ALBUMS,
) {
    val nav = LocalNav.current
    val context = LocalContext.current
    val memory = rememberFocusMemory()
    val ns = LocalCacheNs.current
    // A music library: albums, artists or songs (MUSIC_*).
    val music = collectionType == "music"
    var mode by rememberSaveable(parentId) { mutableIntStateOf(initialMode) }
    val artists = music && mode == MUSIC_ARTISTS
    val paged = remember(parentId, mode) { Cache.map.getOrPut(ns + "lib-$parentId" + if (music) "-$mode" else "") { Paged() } as Paged }
    val scope = rememberCoroutineScope()
    var failed by remember { mutableStateOf(false) }
    val types = when (collectionType) {
        "movies" -> "Movie"
        "tvshows" -> "Series"
        "boxsets" -> "BoxSet"
        "music" -> if (mode == MUSIC_SONGS) "Audio" else "MusicAlbum"
        else -> null
    }
    val filters = arrayOf<Pair<String, Any?>>("ParentId" to parentId, "IncludeItemTypes" to types, "Recursive" to (types != null))
    // Sorted by name, so the A–Z rail (not Live TV's channel list).
    val byName = collectionType != "livetv"

    // Live TV: the channel list rather than the view's folders.
    suspend fun page(start: Int): ItemsResult = if (collectionType == "livetv") {
        api.get<ItemsResult>(
            "/LiveTv/Channels", "UserId" to api.userId, "StartIndex" to start, "Limit" to PAGE,
            "EnableImageTypes" to "Primary,Thumb", "Fields" to "PrimaryImageAspectRatio",
        )
    } else if (artists) {
        api.albumArtists("ParentId" to parentId, "SortBy" to "SortName", "SortOrder" to "Ascending", "StartIndex" to start, "Limit" to PAGE)
    } else {
        api.items(*filters, "SortBy" to "SortName", "SortOrder" to "Ascending", "StartIndex" to start, "Limit" to PAGE)
    }

    // Page [n] into its slots; a new total (titles added or removed on the server) starts the list over.
    suspend fun load(n: Int) {
        if (!paged.inFlight.add(n)) return
        try {
            val r = page(n * PAGE)
            if (r.totalRecordCount != paged.total || paged.items.size != r.totalRecordCount) {
                paged.items.clear()
                paged.items.addAll(arrayOfNulls<Item>(r.totalRecordCount))
                paged.total = r.totalRecordCount
                paged.letters = null
            }
            r.items.forEachIndexed { k, it -> if (n * PAGE + k < paged.items.size) paged.items[n * PAGE + k] = it }
            failed = false
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            failed = paged.total < 0
        } finally {
            paged.inFlight.remove(n)
        }
    }
    fun loaded(n: Int) = paged.items.getOrNull(n * PAGE) != null

    // Always the first page on entering: a cached library notices a changed total.
    LaunchedEffect(parentId, mode) { load(0) }
    LaunchedEffect(parentId, mode, paged.total) {
        if (byName && paged.total > RAIL_MIN && paged.letters == null) paged.letters = runCatching {
            if (artists) LetterIndex.load { b -> api.albumArtists("ParentId" to parentId, *LetterIndex.countOnly(b)).totalRecordCount } else LetterIndex.load(api, *filters)
        }.getOrNull()
    }
    // Saveable: a pushed title disposes this route, and Back must land on the same row.
    val grid = rememberSaveable(mode, saver = androidx.compose.foundation.lazy.grid.LazyGridState.Saver) { androidx.compose.foundation.lazy.grid.LazyGridState() }
    LaunchedEffect(grid) { snapshotFlow { grid.firstVisibleItemIndex > 0 || grid.firstVisibleItemScrollOffset > 60 }.collect(onScrolled) }
    // The pages on screen, and the next one (grid index 0 is the header).
    LaunchedEffect(grid) {
        snapshotFlow { grid.layoutInfo.visibleItemsInfo.let { v -> (v.firstOrNull()?.index ?: 0) to (v.lastOrNull()?.index ?: 0) } }.collect { (a, b) ->
            if (paged.total <= 0) return@collect
            for (n in ((a - 1).coerceAtLeast(0) / PAGE)..((b + 28).coerceAtMost(paged.total - 1) / PAGE)) if (!loaded(n)) scope.launch { load(n) }
        }
    }
    val margin = with(LocalDensity.current) { 110.dp.toPx() }
    val spec = remember(margin) { EdgeSpec(margin) }

    // The rail: the grid item last focused (its letter is where the rail starts), the letter browsed (scrolled to,
    // debounced) and the item to focus once its page is in (OK / RIGHT / BACK).
    var current by remember { mutableIntStateOf(0) }
    var browse by remember { mutableIntStateOf(-1) }
    var target by remember { mutableIntStateOf(-1) }
    val targetReq = remember { FocusRequester() }
    val railFocus = remember { RailFocus() }
    val letters = paged.letters
    LaunchedEffect(browse) {
        val at = letters?.getOrNull(browse)?.takeIf { it >= 0 } ?: return@LaunchedEffect
        delay(120)
        grid.scrollToItem(at + 1)
        if (!loaded(at / PAGE)) load(at / PAGE)
    }
    LaunchedEffect(target, paged.items.getOrNull(target) != null) {
        if (target < 0) return@LaunchedEffect
        if (!loaded(target / PAGE)) return@LaunchedEffect load(target / PAGE)
        grid.scrollToItem(target + 1)
        delay(32)
        if (runCatching { targetReq.requestFocus() }.getOrDefault(false)) target = -1
    }
    val rail = byName && letters != null && letters.count { it >= 0 } > 1

    Box(Modifier.fillMaxSize()) {
        when {
            failed -> Centered { ErrorState { scope.launch { load(0) } } }
            paged.total < 0 -> Centered { Spinner() }
        }
        CompositionLocalProvider(LocalBringIntoViewSpec provides spec) {
            LazyVerticalGrid(
                columns = GridCells.Fixed(7),
                state = grid,
                // The rail is LEFT of the first column: LEFT goes to it (its onEnter picks the current letter).
                modifier = Modifier.fillMaxSize().dpadEdges(left = !rail).onPreviewKeyEvent { e ->
                    // LEFT from the first column: the rail, on the current title's letter (not the nearest one).
                    val l = letters
                    if (!rail || l == null || e.key != Key.DirectionLeft || current % 7 != 0) return@onPreviewKeyEvent false
                    if (e.type == KeyEventType.KeyDown) railFocus.enter(railLetter(l, LetterIndex.entry(l, current, paged.items.getOrNull(current)?.name)))
                    true
                },
                contentPadding = PaddingValues(start = 48.dp, end = 48.dp, top = top, bottom = 56.dp),
                horizontalArrangement = Arrangement.spacedBy(20.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                item("header", span = { GridItemSpan(maxLineSpan) }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f).padding(bottom = 4.dp)) {
                            Text(title, style = Type.largeTitle, color = C.label)
                            if (paged.total >= 0) Text(pluralStringResource(R.plurals.items_count, paged.total, paged.total), style = Type.footnote, color = C.label3)
                        }
                        // A music library: albums, artists or songs.
                        if (music) Row(Modifier.padding(end = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            listOf(MUSIC_ALBUMS to R.string.music_albums, MUSIC_ARTISTS to R.string.music_artists, MUSIC_SONGS to R.string.music_songs).forEach { (m, label) ->
                                Pill(stringResource(label), onClick = { mode = m }, primary = mode == m)
                            }
                        }
                        // An album (or any folder of tracks): all of it, in order.
                        if (paged.items.firstOrNull()?.isAudio == true) {
                            Pill(
                                stringResource(R.string.play), icon = Ic.Play, modifier = Modifier.padding(end = 10.dp),
                                onClick = { scope.launch { com.wika.wicaby.tv.playMusic(context, api, Item(parentId, type = "MusicAlbum")) } },
                            )
                        }
                        // TP-04, desktop's Library page: a library, collection or playlist in random order (not live TV or books).
                        if (paged.total > 0 && collectionType !in setOf("livetv", "books", "boxsets", "playlists")) {
                            Pill(
                                stringResource(com.wika.wicaby.core.R.string.shuffle), icon = Ic.Shuffle,
                                onClick = { scope.launch { com.wika.wicaby.tv.shuffle(context, api, parentId) } },
                            )
                        }
                    }
                }
                // Keyed by slot too: a title that moved between two pages (renamed, same total) can sit in two slots
                // for a while, and a repeated key would crash the grid.
                itemsIndexed(paged.items, key = { i, it -> "$i:${it?.id}" }, contentType = { _, it -> if (it == null) 0 else 1 }) { i, item ->
                    if (item == null) {
                        // Not loaded yet: the card's shape, not focusable (its page is on its way).
                        Box(Modifier.fillMaxWidth().aspectRatio(if (music) 1f else 2f / 3f).clip(RoundedCornerShape(Radius.md)).background(C.fill2))
                    } else {
                        PosterCard(
                            item, api, width = null, aspect = if (music || item.isMusic) 1f else 2f / 3f,
                            onClick = {
                                when {
                                    item.type == "TvChannel" -> play(context, item)
                                    // A track plays on through its album (play: the resume question, then the music session;
                                    // an audiobook in the player).
                                    item.isAudio -> play(context, item)
                                    else -> nav.push(item.route())
                                }
                            },
                            onFocus = { current = i },
                            focusModifier = Modifier.remembered(memory, item.id, default = defaultFocus && i == 0).then(if (i == target) Modifier.focusRequester(targetReq) else Modifier),
                        )
                    }
                }
            }
        }
        if (rail && letters != null) {
            AlphaRail(
                letters, railFocus,
                onBrowse = { browse = it },
                onPick = { target = letters[it] },
                onLeave = { target = current },
                modifier = Modifier.align(Alignment.CenterStart).padding(start = 12.dp, top = 16.dp, bottom = 16.dp),
            )
        }
    }
}

// Fewer titles than this: no A–Z rail (a screen or two of posters).
private const val RAIL_MIN = 28

const val MUSIC_ALBUMS = 0
const val MUSIC_ARTISTS = 1
const val MUSIC_SONGS = 2

private val Item.isMusic get() = isAudio || type == "MusicAlbum" || type == "MusicArtist"

@Composable
fun FolderScreen(id: String, name: String) {
    val api = LocalApi.current ?: return
    Box(Modifier.fillMaxSize().background(C.bg)) {
        LibraryGrid(api, id, name, null, top = 48.dp, defaultFocus = true)
    }
}

// ---------------------------------------------------------------------------
// Search.

@Composable
private fun SearchTab(api: Api, live: Boolean) {
    val nav = LocalNav.current
    val memory = rememberFocusMemory()
    // Desktop Search.svelte showServer={multi}.
    val multi = Servers.multi
    var query by rememberSaveable { mutableStateOf("") }
    val q = query.trim()
    val types = if (TvSettings.searchEpisodes.value) "Movie,Series,Episode" else "Movie,Series"
    val results by produceState<List<Item>?>(null, q, types) {
        if (q.length < 2) {
            value = null
            return@produceState
        }
        delay(350)
        value = runCatching {
            Servers.merged(api) { it.items("SearchTerm" to q, "IncludeItemTypes" to types, "Recursive" to true, "Limit" to 60).items }
        }.getOrDefault(emptyList())
    }
    // Voice search: the remote's microphone through the system recognizer; no mic without one.
    val context = LocalContext.current
    val voice = remember { VoiceSearch.available(context) }
    val listen = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        VoiceSearch.result(r.data)?.let { query = it }
    }
    val prompt = stringResource(if (live) R.string.search_voice_prompt_live else com.wika.wicaby.core.R.string.voice_search_prompt)
    val locale = uiLocale()
    // TP-12: Live TV channels and programmes match too (null while their search runs).
    val hits = com.wika.wicaby.tv.ui.livetv.liveHits(api, query, live)
    Column(Modifier.fillMaxSize().padding(top = 100.dp)) {
        Row(Modifier.align(Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            TvTextField(
                query, { query = it }, stringResource(R.string.search_hint),
                modifier = Modifier.width(560.dp).remembered(memory, "field", default = true),
                imeAction = ImeAction.Search,
            )
            if (voice) {
                val label = stringResource(com.wika.wicaby.core.R.string.voice_search)
                Pill(
                    null, icon = Ic.Mic, modifier = Modifier.remembered(memory, "voice").semantics { contentDescription = label },
                    onClick = { runCatching { listen.launch(VoiceSearch.intent(prompt, locale)) } },
                )
            }
        }
        Spacer(Modifier.height(18.dp))
        val list = results
        when {
            list == null -> Centered { Text(stringResource(R.string.search_prompt), style = Type.body, color = C.label3) }
            list.isEmpty() && live && hits == null -> Unit
            list.isEmpty() && hits?.empty != false -> Centered { Text(stringResource(R.string.search_empty), style = Type.title3, color = C.label2) }
            else -> LazyVerticalGrid(
                columns = GridCells.Fixed(7),
                modifier = Modifier.dpadEdges(),
                contentPadding = PaddingValues(start = 48.dp, end = 48.dp, top = 12.dp, bottom = 56.dp),
                horizontalArrangement = Arrangement.spacedBy(20.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                hits?.let { liveHitRows(it, memory) }
                itemsIndexed(list, key = { _, it -> Servers.key(it) }) { _, item ->
                    PosterCard(item, api, onClick = { nav.push(item.route()) }, width = null, focusModifier = Modifier.remembered(memory, Servers.key(item)), server = if (multi) serverName(item) else null)
                }
            }
        }
    }
}
