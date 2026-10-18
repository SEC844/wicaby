package com.wika.wicaby.mobile.ui

import com.wika.wicaby.meshui.LogoLoader
import android.content.Context
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.add
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import androidx.window.core.layout.WindowSizeClass
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.data.Snapshot
import com.wika.wicaby.core.net.LocalNetwork
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.WicabyApp
import com.wika.wicaby.mobile.player.PlayerActivity
import com.wika.wicaby.mobile.ui.livetv.LiveScreen
import com.wika.wicaby.mobile.music.MiniPlayerSlot
import com.wika.wicaby.mobile.music.MusicItemScreen
import com.wika.wicaby.mobile.music.MusicOverlay
import com.wika.wicaby.mobile.music.MusicRoute
import com.wika.wicaby.mobile.music.MusicScreen
import com.wika.wicaby.mobile.music.opensMusicPage
import androidx.compose.foundation.layout.Column
import kotlinx.serialization.Serializable

val LocalSnapshot = staticCompositionLocalOf<Snapshot> { error("no prefs") }

// Settings asks for the server list; cleared once a server is picked.
object SetupRequest {
    var pickServer by mutableStateOf(false)
    // Onboarding: the first-run wizard is on screen (a fresh install, or "Relancer la configuration" with [rerun]).
    // Held here, not in the snapshot: signing in at step 4 must not end it.
    var wizard by mutableStateOf(false)
    var rerun by mutableStateOf(false)
    // TP-06: Réglages > Autres serveurs > Ajouter un serveur (an extra account; the primary one stays).
    var addServer by mutableStateOf(false)
    // A mesh peer's server (Accès à distance > Ajouter): sign in to it directly.
    var addTarget by mutableStateOf<com.wika.wicaby.core.data.Server?>(null)
    // Where the main shell opens next: Réglages after the wizard's rerun or an added server, and
    // the Remote access screen from the wizard's last step.
    var returnTo by mutableStateOf<Tab?>(null)
    var openRemote by mutableStateOf(false)
}

// The first-run rule (onboarding spec section 4): no server yet and never onboarded.
fun showsWizard(snap: Snapshot) = snap.server == null && !snap.onboarded

@Composable
fun WicabyRoot() {
    val first by produceState<Snapshot?>(null) { value = Core.prefs.current() }
    val start = first
    if (start == null) {
        // Cold start: the painted mark, only if reading the preferences takes a moment.
        Box(Modifier.fillMaxSize().background(G.bg), contentAlignment = Alignment.Center) { LogoLoader(G.label, stringResource(R.string.loading), size = 88.dp, delayMs = 150) }
        return
    }
    val snap by Core.prefs.data.collectAsState(start)
    // OB-X: read before anything paints G.bg.
    if (G.theme != snap.theme) G.theme = snap.theme
    G.systemDark = isSystemInDarkTheme()
    SystemBars(G.palette.light)
    remember { showsWizard(start).also { if (it) SetupRequest.wizard = true } }
    // Before Core.api: the first socket already posts the right SupportsMediaControl (no-op when unchanged).
    Core.remoteControl = snap.remoteControl
    val api = remember(snap.session) { snap.session?.let { Api.of(it.server, snap.deviceId, it.token, it.userId) }.also { Core.api = it } }
    LaunchedEffect(snap.maxMbps) { Core.maxMbps = snap.maxMbps }
    LaunchedEffect(api) { if (api != null) WicabyApp.syncPending() }
    // TP-06: the other signed-in servers, set before the screens below load their rows (none while signed out).
    // D-10: a hidden plex server stays signed in, out of the merged views (PlexUi.hidden: toggled in Réglages).
    remember(snap.extras, snap.deviceId, api == null, PlexUi.hidden) {
        (if (api == null) emptyList() else snap.extras.filterNot { plexHidden(it.server) }.map { Api.of(it.server, snap.deviceId, it.token, it.userId) }).also { Servers.extra = it }
    }
    // An account added or removed: the rows load again with the new set of servers.
    var extrasSeen by remember { mutableStateOf(snap.extras) }
    LaunchedEffect(snap.extras) {
        if (extrasSeen == snap.extras) return@LaunchedEffect
        extrasSeen = snap.extras
        Cache.map.clear()
    }
    // Android 17: the local network rationale comes before discovery and before the first call to a LAN server.
    val context = LocalContext.current
    val server = api?.server ?: snap.server
    val lanServer by produceState(false, server?.address) { value = server != null && LocalNetwork.blocks(context, server.address) }
    val picking = api == null && (server == null || SetupRequest.pickServer)

    WicabyTheme(accentOf(snap.accent)) {
        CompositionLocalProvider(LocalSnapshot provides snap) {
            Box(Modifier.fillMaxSize().background(G.bg)) {
                LocalNetworkGate(picking || lanServer) {
                    // Outside the AnimatedContent below: signing in mid-wizard keeps the wizard and its step.
                    if (SetupRequest.wizard) WelcomeFlow(snap, rerun = SetupRequest.rerun)
                    else AnimatedContent(
                        api,
                        contentKey = { it?.server?.id + "/" + it?.userId },
                        transitionSpec = { fadeIn(tween(320, 80)) togetherWith fadeOut(tween(160)) },
                        label = "root",
                    ) { a ->
                        if (a == null || SetupRequest.addServer) SetupFlow(snap) else MainShell(a)
                    }
                }
            }
        }
    }
}

@Composable
private fun SetupFlow(snap: Snapshot) {
    if (SetupRequest.addServer) return AddServerFlow(snap)
    val server = snap.server
    AnimatedContent(server == null || SetupRequest.pickServer, transitionSpec = { fadeIn(tween(260)) togetherWith fadeOut(tween(160)) }, label = "setup") { pick ->
        if (pick || server == null) ServerScreen(snap) else LoginScreen(server, snap.deviceId)
    }
}

// ---------------------------------------------------------------------------
// Signed in: five tabs, each with its own back stack.

@Serializable object HomeRoute
@Serializable object LibrariesRoute
@Serializable object SearchRoute
@Serializable object DownloadsRoute
@Serializable object SettingsRoute
// serverId: TP-06, an item of an extra server (null = the primary one).
@Serializable data class DetailRoute(val id: String, val serverId: String? = null)
@Serializable data class GridRoute(val title: String, val parentId: String? = null, val collectionType: String? = null, val personId: String? = null, val serverId: String? = null)
@Serializable object RemoteRoute
// Photos (PH-05): one Photo opened from outside its library (search, home rows).
@Serializable data class PhotoRoute(val id: String, val serverId: String? = null)

enum class Tab(val root: Any, val label: Int, val icon: ImageVector, val navLabel: Int = label) {
    Home(HomeRoute, R.string.tab_home, Ic.Home),
    Libraries(LibrariesRoute, R.string.tab_libraries, Ic.Library, R.string.nav_libraries),
    Search(SearchRoute, R.string.tab_search, Ic.Search),
    Downloads(DownloadsRoute, R.string.tab_downloads, Ic.Download, R.string.nav_downloads),
    Settings(SettingsRoute, R.string.tab_settings, Ic.Settings),
}

fun play(context: Context, item: Item, fromStart: Boolean = false) = PlayerActivity.start(context, item.id, fromStart, server = Servers.extraOf(item.serverId)?.server?.id)

fun NavController.open(item: Item) {
    val sid = Servers.extraOf(item.serverId)?.server?.id
    // Photos (PH-05): a still opens the viewer, an album its timeline.
    if (item.type == "Photo") return navigate(PhotoRoute(item.id, sid))
    if (item.type == "PhotoAlbum") return navigate(GridRoute(item.name, parentId = item.id, collectionType = com.wika.wicaby.mobile.ui.photos.PHOTO_ALBUM, serverId = sid))
    // Music (MU-08): albums, artists, genres and audio playlists have their own page.
    if (item.opensMusicPage()) return navigate(MusicRoute(item.id, item.type, item.name, sid))
    if (item.isFolder && !item.isSeries && item.type != "Season") navigate(GridRoute(item.name, parentId = item.id, collectionType = item.collectionType, serverId = sid))
    else navigate(DetailRoute(item.seriesId?.takeIf { item.type == "Season" } ?: item.id, sid))
}

@Composable
private fun MainShell(api: Api) {
    var tab by rememberSaveable { mutableStateOf(SetupRequest.returnTo ?: Tab.Home) }
    LaunchedEffect(Unit) { SetupRequest.returnTo = null }
    var reselect by remember { mutableIntStateOf(0) }
    val holder = rememberSaveableStateHolder()
    // Phones in portrait get the bottom bar; anything at least "medium" wide gets the rail.
    val wide = currentWindowAdaptiveInfo().windowSizeClass.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_MEDIUM_LOWER_BOUND)
    val barColors = NavigationBarItemDefaults.colors(
        selectedIconColor = G.label, selectedTextColor = G.label, indicatorColor = G.fill3,
        unselectedIconColor = G.label2, unselectedTextColor = G.label2,
    )
    val railColors = NavigationRailItemDefaults.colors(
        selectedIconColor = G.label, selectedTextColor = G.label, indicatorColor = G.fill3,
        unselectedIconColor = G.label2, unselectedTextColor = G.label2,
    )
    val itemColors = NavigationSuiteDefaults.itemColors(navigationBarItemColors = barColors, navigationRailItemColors = railColors)
    NavigationSuiteScaffold(
        navigationSuiteItems = {
            Tab.entries.forEach { t ->
                item(
                    selected = t == tab,
                    onClick = { if (t == tab) reselect++ else tab = t },
                    icon = { Icon(t.icon, contentDescription = null) },
                    label = { Text(stringResource(t.navLabel), style = Type.caption.copy(fontSize = 11.sp, fontWeight = FontWeight.Medium), maxLines = 1, softWrap = false) },
                    colors = itemColors,
                )
            }
        },
        layoutType = if (wide) NavigationSuiteType.NavigationRail else NavigationSuiteType.NavigationBar,
        navigationSuiteColors = NavigationSuiteDefaults.colors(
            navigationBarContainerColor = G.elevated,
            navigationBarContentColor = G.label2,
            navigationRailContainerColor = G.bg,
            navigationRailContentColor = G.label2,
        ),
        containerColor = G.bg,
        contentColor = G.label,
    ) {
        // With the rail, nothing else keeps content clear of the gesture bar and the cutout.
        // With the bottom bar, the content already ends above it (80 dp + the gesture bar): marked
        // consumed so a screen's imePadding() only lifts it by the part the keyboard really covers.
        val insets = if (wide) Modifier.windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.displayCutout).only(WindowInsetsSides.End + WindowInsetsSides.Bottom))
        else Modifier.consumeWindowInsets(WindowInsets.navigationBars.add(WindowInsets(bottom = 80.dp)))
        Column(Modifier.fillMaxSize().then(insets)) {
            Box(Modifier.weight(1f)) {
                // Back on another tab's root returns to Accueil, like the platform's own apps.
                BackHandler(enabled = tab != Tab.Home) { tab = Tab.Home }
                holder.SaveableStateProvider(tab.name) {
                    TabHost(tab, api, reselect, openTab = { tab = it })
                }
            }
            // Music (MU-08): the mini player above the navigation bar while music plays.
            MiniPlayerSlot()
        }
    }
    MusicOverlay()
}

@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
private fun TabHost(tab: Tab, api: Api, reselect: Int, openTab: (Tab) -> Unit) {
    val nav = rememberNavController()
    var seen by remember { mutableIntStateOf(reselect) }
    LaunchedEffect(reselect) {
        if (reselect != seen) {
            seen = reselect
            nav.popBackStack(nav.graph.startDestinationId, inclusive = false)
        }
    }
    SharedTransitionLayout {
        CompositionLocalProvider(LocalSharedScope provides this) {
            NavHost(
                nav,
                startDestination = tab.root,
                enterTransition = { slideInHorizontally(tween(320)) { it / 4 } + fadeIn(tween(240)) },
                exitTransition = { slideOutHorizontally(tween(320)) { -it / 10 } + fadeOut(tween(200)) },
                popEnterTransition = { slideInHorizontally(tween(320)) { -it / 10 } + fadeIn(tween(240)) },
                popExitTransition = { slideOutHorizontally(tween(320)) { it / 4 } + fadeOut(tween(200)) },
            ) {
                composable<HomeRoute> { Scoped { HomeScreen(api, nav, openTab) } }
                composable<LibrariesRoute> { Scoped { LibrariesScreen(api, nav) } }
                composable<SearchRoute> { Scoped { SearchScreen(api, nav) } }
                composable<DownloadsRoute> { Scoped { DownloadsScreen(api) } }
                composable<SettingsRoute> { Scoped { SettingsScreen(api, onRemote = { nav.navigate(RemoteRoute) }) } }
                composable<RemoteRoute> { Scoped { RemoteAccessScreen(onBack = { nav.popBackStack() }) } }
                contentDestinations(api, nav)
            }
            // Home and detail pages draw their own (artwork runs under the status bar there).
            val dest = nav.currentBackStackEntryAsState().value?.destination
            if (dest != null && !dest.hasRoute<HomeRoute>() && !dest.hasRoute<DetailRoute>()) StatusBarScrim()
        }
    }
}

internal fun NavGraphBuilder.contentDestinations(api: Api, nav: NavController) {
    composable<MusicRoute> { entry ->
        val r = entry.toRoute<MusicRoute>()
        Scoped { MusicItemScreen(Servers.of(r.serverId) ?: api, r, nav) }
    }
    composable<DetailRoute> { entry ->
        val r = entry.toRoute<DetailRoute>()
        Scoped { DetailScreen(Servers.of(r.serverId) ?: api, r.id, nav) }
    }
    // File sources (FS-10): one folder of a source.
    composable<FilesRoute> { entry -> Scoped { FilesScreen(entry.toRoute<FilesRoute>(), nav) } }
    composable<PhotoRoute> { entry ->
        val r = entry.toRoute<PhotoRoute>()
        Scoped { com.wika.wicaby.mobile.ui.photos.PhotoScreen(Servers.of(r.serverId) ?: api, r.id, nav) }
    }
    composable<GridRoute> { entry ->
        val r = entry.toRoute<GridRoute>()
        // The Live TV view opens the Live TV screen (M-1), not a folder grid.
        val a = Servers.of(r.serverId) ?: api
        Scoped {
            when (r.collectionType) {
                "livetv" -> LiveScreen(a, r.title, onBack = { nav.popBackStack() })
                LIVE_SETUP -> com.wika.wicaby.mobile.ui.livetv.LiveSetupScreen(r.title, onBack = { nav.popBackStack() }, onIptv = { nav.navigate(GridRoute(Core.str(com.wika.wicaby.core.R.string.iptv_title), collectionType = IPTV)) })
                IPTV -> com.wika.wicaby.mobile.ui.livetv.IptvScreen(r.title, onBack = { nav.popBackStack() })
                "music" -> MusicScreen(a, r, nav)
                // Photos (PH-05; decision O3: home videos open in the photo timeline too).
                in com.wika.wicaby.mobile.ui.photos.PHOTO_COLLECTIONS -> com.wika.wicaby.mobile.ui.photos.PhotosScreen(a, r, nav)
                else -> GridScreen(a, r, nav)
            }
        }
    }
}

@Composable
private fun androidx.compose.animation.AnimatedContentScope.Scoped(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalNavScope provides this, content = content)
}

// Status and navigation bar icons follow the canvas: dark icons on the light theme, light ones otherwise.
@Composable
private fun SystemBars(light: Boolean) {
    val activity = LocalActivity.current as? ComponentActivity ?: return
    LaunchedEffect(light) {
        val clear = android.graphics.Color.TRANSPARENT
        val style = if (light) SystemBarStyle.light(clear, clear) else SystemBarStyle.dark(clear)
        activity.enableEdgeToEdge(style, style)
    }
}
