package com.wika.wicaby.tv

import android.Manifest
import android.content.Context
import android.content.Intent
import android.media.tv.TvContract
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.KeyboardShortcutGroup
import android.view.Menu
import android.view.Window
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.wika.wicaby.core.data.HomeRefresh
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Profiles
import com.wika.wicaby.core.data.SessionGate
import com.wika.wicaby.core.livetv.Reminders
import com.wika.wicaby.core.player.RemoteControl
import com.wika.wicaby.core.player.RemotePlay
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.drop
import com.wika.wicaby.core.livetv.liveLinkQuery
import com.wika.wicaby.core.livetv.resolveLiveLink
import com.wika.wicaby.tv.ui.livetv.LiveTv
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import com.wika.wicaby.tv.music.tracksOf
import androidx.annotation.RequiresApi
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.tv.ui.ServerScope
import com.wika.wicaby.core.data.SafeNames
import com.wika.wicaby.core.data.Snapshot
import com.wika.wicaby.tv.data.AppLanguage
import com.wika.wicaby.tv.data.HomeChannels
import com.wika.wicaby.tv.data.WatchNext
import com.wika.wicaby.tv.player.PlayerActivity
import com.wika.wicaby.tv.ui.Accents
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Cache
import com.wika.wicaby.tv.ui.DetailScreen
import com.wika.wicaby.tv.ui.FolderScreen
import com.wika.wicaby.tv.ui.LocalNetworkGate
import com.wika.wicaby.tv.ui.LoginScreen
import com.wika.wicaby.meshui.LogoLoader
import com.wika.wicaby.tv.ui.MainScreen
import com.wika.wicaby.tv.ui.ServerScreen
import com.wika.wicaby.tv.ui.WicabyTheme
import com.wika.wicaby.tv.ui.AlertAction
import com.wika.wicaby.tv.ui.Idle
import com.wika.wicaby.tv.ui.LocalOverlay
import com.wika.wicaby.tv.ui.OverlayHost
import com.wika.wicaby.tv.ui.OverlayLayer
import com.wika.wicaby.tv.ui.ScreensaverHost
import com.wika.wicaby.tv.ui.TvAlert
import com.wika.wicaby.tv.data.TvSettings
import com.wika.wicaby.core.data.clock
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.draw.blur
import com.wika.wicaby.core.livetv.FormFactor
import com.wika.wicaby.core.livetv.DeviceClassDetector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

class MainActivity : ComponentActivity() {
    // Android 13+: asked when the first Live TV reminder is set; refused, reminders stay in-app (banner).
    private val askNotify = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (!ok) Toast.makeText(this, com.wika.wicaby.core.R.string.player_live_reminder_permission, Toast.LENGTH_LONG).show()
    }

    // In-app language below API 33 (Réglages > Interface > Langue).
    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(newBase)
        AppLanguage.overrideConfiguration(newBase)?.let { applyOverrideConfiguration(it) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLanguage.applyToCore(this)
        // TP-09, debug builds: am start … --es trakt_url http://10.0.2.2:8260 (tools/mock-server/mock-trakt.mjs).
        if (BuildConfig.DEBUG) intent.getStringExtra("trakt_url")?.let { com.wika.wicaby.core.trakt.TraktService.shared.base = it }
        // Plex, debug builds: am start … --es plex_tv_url http://127.0.0.1:32401 (tools/mock-server/mock-plex.mjs through adb
        // reverse); PlexTv.base takes loopback only. Never plex.tv in a smoke test.
        if (BuildConfig.DEBUG) intent.getStringExtra("plex_tv_url")?.let { com.wika.wicaby.core.plex.PlexTv.devBase = it }
        goFullscreen()
        window.callback = IdleKeys(window.callback)
        setContent { TvCanvas { App() } }
        lifecycleScope.launch { Reminders.askPermission.collect { askNotify.launch(Manifest.permission.POST_NOTIFICATIONS) } }
        // "Play on Wicaby" from another app: the player comes to the front over whatever is showing
        // (reader, settings, another player), or a notification offers it in the background (RemotePlays); Playback
        // takes the position and tracks (RemoteControl.take).
        RemotePlays.install(this)
        if (savedInstanceState == null) acceptRemotePlay(intent)
        // B10: Home and every screen on show reload after a server change, on return, every 5 min (HomeRefresh).
        val auto = HomeRefresh()
        lifecycleScope.launch { repeatOnLifecycle(Lifecycle.State.STARTED) { auto.run(Core.socketMessages) { Cache.changed() } } }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    override fun onResume() {
        super.onResume()
        // Back from the player or another app: no screensaver left over from before.
        Idle.saver = false
        Idle.poke()
    }

    // Any key counts as activity; while the screensaver shows, a key only closes it.
    // Wraps the window callback (the activity itself) rather than overriding dispatchKeyEvent:
    // androidx.core's ComponentActivity.dispatchKeyEvent is @RestrictTo, so overriding it is not public API.
    // The decor view hands every key to window.callback first, so this sees exactly what the override did.
    private class IdleKeys(private val activity: Window.Callback) : Window.Callback by activity {
        private var swallowUp = -1

        override fun dispatchKeyEvent(event: KeyEvent): Boolean {
            Idle.poke()
            if (event.action == KeyEvent.ACTION_DOWN && Idle.saver) {
                Idle.saver = false
                swallowUp = event.keyCode
                return true
            }
            if (event.action == KeyEvent.ACTION_UP && event.keyCode == swallowUp) {
                swallowUp = -1
                return true
            }
            if (swallowUp == event.keyCode) return true
            return activity.dispatchKeyEvent(event)
        }

        // Java default methods: Kotlin's `by` does not forward them, so the activity would never see them.
        @RequiresApi(24)
        override fun onProvideKeyboardShortcuts(data: MutableList<KeyboardShortcutGroup>, menu: Menu?, deviceId: Int) =
            activity.onProvideKeyboardShortcuts(data, menu, deviceId)

        @RequiresApi(26)
        override fun onPointerCaptureChanged(hasCapture: Boolean) = activity.onPointerCaptureChanged(hasCapture)
    }

    // singleTask: the launcher's Watch Next row lands here when the app is already running.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        acceptRemotePlay(intent)
        openDeepLink(this)
    }

    // The remote Play notification tapped.
    private fun acceptRemotePlay(intent: Intent) {
        if (intent.action != RemotePlays.ACTION_PLAY) return
        intent.action = null
        RemotePlays.accept(this)
    }
}

// wicaby://play/<itemId> (Watch Next, the Next Up channel), wicaby://open/<itemId> (Recently Added);
// wicaby://live?channel=…&server=…[&start=beginning|live], from a reminder (§9.6).
fun openDeepLink(activity: ComponentActivity) {
    // TP-10: no session until "Who is watching?" opened one: the link waits (App() calls again once it is open).
    if (Core.api == null) return
    val data = activity.intent.data ?: return
    if (data.scheme != WatchNext.SCHEME) return
    if (data.host == "live") {
        activity.intent.data = null
        val (channel, server) = liveLinkQuery(data) ?: return
        activity.lifecycleScope.launch {
            resolveLiveLink(channel) { Core.api?.takeIf { server == null || it.server.id == server }?.let { LiveTv.repo(activity, it) } }
                // F2: start=beginning|live pre-answers the watch-from-start prompt.
                ?.let { (repo, row) -> LiveTv.tune(activity, repo, row.id, data.getQueryParameter("start")?.takeIf { it == "beginning" || it == "live" }) }
        }
        return
    }
    if (data.host !in setOf("play", "open")) return
    activity.intent.data = null
    // Exported activity: any app can send this link, so only a plain Emby item id gets through.
    val id = data.pathSegments.singleOrNull()?.takeIf(SafeNames::isValidId) ?: return
    if (data.host == "open") OpenItem.id = id
    else activity.startActivity(Intent(activity, PlayerActivity::class.java).putExtra(PlayerActivity.EXTRA_ID, id))
}

// "Play on Wicaby" from another app (the server socket): only with a session open (TP-10: none while locked).
fun playRemote(context: Context, r: RemotePlay): Boolean {
    val api = Core.api ?: return false
    Core.scope.launch(kotlinx.coroutines.Dispatchers.Main) {
        // A music track (with the rest of the queue's tracks) plays in the music session (MU-09); anything else, or a
        // failed look-up, in the player as before.
        val item = runCatching { api.item(r.itemId) }.getOrNull()
        if (item != null && item.playsAsMusic) {
            val tracks = runCatching { api.tracksOf(r.queue.ifEmpty { listOf(r.itemId) }) }.getOrNull()?.filter { it.isAudio }.orEmpty().ifEmpty { listOf(item) }
            RemoteControl.take(r.itemId)
            com.wika.wicaby.tv.music.Music.play(context, api, tracks, tracks.indexOfFirst { it.id == r.itemId }.coerceAtLeast(0), r.startMs ?: 0)
            return@launch
        }
        if (RemotePlays.canStart()) return@launch RemotePlays.start(context, r)
        // In the background (Android 10+): a notification offers it, from the sender's user when the server names it.
        val who = r.controller?.let { id -> runCatching { api.get<JsonObject>("/Users/$id")["Name"]?.jsonPrimitive?.contentOrNull }.getOrNull() }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) RemotePlays.notify(context, r, who ?: api.server.name, item?.name)
    }
    return true
}

// A music track goes to the music session; an audiobook (Jellyfin's AudioBook, mediaType Audio) stays in the player.
// Emby may type a book's chapter "Audio" too (unverified): the music session then resumes it at its position anyway.
val Item.playsAsMusic get() = type == "Audio"

// A detail page asked for by the launcher; App() pushes it.
object OpenItem {
    var id by mutableStateOf<String?>(null)
}

sealed interface Route {
    data object Servers : Route
    // add: TP-06, Réglages > Comptes > Ajouter un serveur (an extra account; the primary one stays).
    data class Login(val server: Server, val add: Boolean = false) : Route
    data object AddServer : Route
    data object Main : Route
    // serverId: TP-06, an extra server's title or folder (null: the primary server).
    data class Detail(val id: String, val serverId: String? = null) : Route
    data class Folder(val id: String, val name: String, val serverId: String? = null) : Route
    data object History : Route
    // Photos (PH-06): the viewer over a timeline loaded in Cache (key), and a photo album's timeline.
    data class PhotoView(val key: String, val index: Int, val serverId: String? = null) : Route
    // kind: an Immich album or person (photos spec PH-13), null for a server album.
    data class PhotoAlbum(val id: String, val name: String, val serverId: String? = null, val kind: String? = null) : Route
    // File sources (FS-10): one folder of a source; id is the folder's reversible path id (core files.pure.Ids).
    data class Files(val sourceId: String, val id: String, val name: String) : Route
    // Music (MU-09): an album or audio playlist page, and a music library's full grid (albums, artists or songs).
    data class MusicAlbum(val id: String, val name: String, val serverId: String? = null) : Route
    data class MusicArtist(val id: String, val name: String, val serverId: String? = null) : Route
    data class MusicLibrary(val id: String, val name: String, val mode: Int, val serverId: String? = null) : Route
    // Onboarding (OB-T1): the first-run wizard; rerun: Réglages > Interface > Relancer la configuration.
    data class Welcome(val rerun: Boolean = false) : Route
    // Plex (plex-spec §5.1): link with a code, then the server choice; add: an extra server (the primary one stays).
    data class PlexLink(val add: Boolean = false) : Route
}

// Where the app opens, and where Skip Setup lands (the wizard writes onboarded first). Main also needs
// SessionGate.unlock(session), done by the caller.
fun startRoute(snap: Snapshot): Route {
    val session = snap.session
    return when {
        // TP-10: "Who is watching?" first, unless this TV has one account without a PIN (and the setting skips it).
        session != null -> if (Profiles.skipPicker(snap) && !com.wika.wicaby.tv.ui.plexProtected(session)) Route.Main else Route.Login(session.server)
        snap.server != null -> Route.Login(snap.server!!)
        snap.onboarded -> Route.Servers
        else -> Route.Welcome()
    }
}

// TP-10: "Who is watching?" (a Login that is not an extra account) closes the session and is left alone on the
// stack, so Back cannot return to the account it came from.
val Route.picker get() = this is Route.Login && !add

// [gone]: a route that left the stack, whichever way (Back, a screen's own pop, a reset), so its saved state
// goes too: pushed again later (Run Setup Again), it starts afresh.
class Nav(private val stack: SnapshotStateList<Route>, private val gone: (Route) -> Unit = {}) {
    val top get() = stack.last()
    val depth get() = stack.size
    fun push(r: Route) {
        if (r.picker) reset(r) else stack.add(r)
    }
    fun pop() {
        if (stack.size > 1) forget(listOf(stack.removeAt(stack.lastIndex)))
    }
    fun reset(r: Route) {
        if (r.picker) {
            SessionGate.lock()
            // TP-10: the account's music ends with it (no more reports with its token, no remote control, no screensaver).
            com.wika.wicaby.tv.music.Music.release()
        }
        val old = stack.toList()
        stack.clear()
        stack.add(r)
        forget(old)
    }
    private fun forget(routes: List<Route>) = routes.distinct().filter { it !in stack }.forEach(gone)
}

val LocalNav = staticCompositionLocalOf<Nav> { error("no nav") }
val LocalApi = staticCompositionLocalOf<Api?> { null }
val LocalSnapshot = staticCompositionLocalOf<Snapshot> { error("no prefs") }

// Asks "Reprendre ?" when the Réglages say so; App() shows the alert.
object ResumePrompt {
    var item by mutableStateOf<Item?>(null)
}

// `ask = false` when the user already chose (Detail's Reprendre / Depuis le début pair).
fun play(context: Context, item: Item, fromStart: Boolean = false, ask: Boolean = true) {
    if (!fromStart && ask && item.resumeMs > 0) {
        when (TvSettings.resume.value) {
            TvSettings.RESUME_ASK -> {
                ResumePrompt.item = item
                return
            }
            TvSettings.RESUME_START -> return startPlayer(context, item, true)
        }
    }
    startPlayer(context, item, fromStart)
}

// TP-04: plays [ids] as a queue (shuffle), from [start] (the first one by default) at its resume point,
// or every entry from 0 with [fromStart].
fun playQueue(context: Context, ids: List<String>, server: String? = null, start: String = ids.firstOrNull().orEmpty(), fromStart: Boolean = false) {
    if (ids.isEmpty()) return
    context.startActivity(
        Intent(context, PlayerActivity::class.java)
            .putExtra(PlayerActivity.EXTRA_ID, start)
            .putExtra(PlayerActivity.EXTRA_FROM_START, fromStart)
            .putExtra(PlayerActivity.EXTRA_SERVER, server)
            .putStringArrayListExtra(PlayerActivity.EXTRA_QUEUE, ArrayList(ids)),
    )
}

// Shuffle on a series, season, collection, playlist or library: everything under [parentId] in random order.
suspend fun shuffle(context: Context, api: com.wika.wicaby.core.data.Api, parentId: String) {
    val ids = try {
        com.wika.wicaby.core.player.PlayQueue.shuffle(api, parentId)
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (e: Exception) {
        return android.widget.Toast.makeText(context, R.string.load_error, android.widget.Toast.LENGTH_SHORT).show()
    }
    if (ids.isEmpty()) android.widget.Toast.makeText(context, com.wika.wicaby.core.R.string.nothing_to_play, android.widget.Toast.LENGTH_SHORT).show()
    else playQueue(context, ids, Servers.extraOf(api.server.id)?.server?.id, fromStart = true)
}

// Music (music spec MU-09): an album, artist, playlist or track plays all its tracks in the TV's music session
// (PlayQueue.tracks, music/MusicService.kt), a track from itself; the now-playing screen opens over the page.
suspend fun playMusic(context: Context, api: Api, item: Item, startMs: Long = 0) {
    val tracks = try {
        // A file source answers no Ids look-up: its track plays alone.
        if (api is com.wika.wicaby.core.files.FilesApi) listOf(item)
        else api.tracksOf(com.wika.wicaby.core.player.PlayQueue.tracks(api, item))
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (e: Exception) {
        return Toast.makeText(context, R.string.load_error, Toast.LENGTH_SHORT).show()
    }
    // The session and its player live on the main thread, whichever dispatcher the caller resumed on.
    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main.immediate) {
        if (tracks.isEmpty()) Toast.makeText(context, com.wika.wicaby.core.R.string.nothing_to_play, Toast.LENGTH_SHORT).show()
        else com.wika.wicaby.tv.music.Music.play(context, api, tracks, tracks.indexOfFirst { it.id == item.id }.coerceAtLeast(0), startMs.takeIf { tracks.any { t -> t.id == item.id } } ?: 0)
    }
}

private fun startPlayer(context: Context, item: Item, fromStart: Boolean) {
    // A music track (MU-09) plays in the music session, after the resume question like any title: at its position, or
    // from the start.
    val musicApi = if (item.playsAsMusic) Core.api?.let { Servers.forItem(item, it) } else null
    if (musicApi != null) {
        Core.scope.launch(kotlinx.coroutines.Dispatchers.Main) { playMusic(context, musicApi, item, if (fromStart) 0 else item.resumeMs) }
        return
    }
    context.startActivity(
        Intent(context, PlayerActivity::class.java)
            .putExtra(PlayerActivity.EXTRA_ID, item.id)
            .putExtra(PlayerActivity.EXTRA_SERVER, Servers.extraOf(item.serverId)?.server?.id)
            .putExtra(PlayerActivity.EXTRA_FROM_START, fromStart),
    )
}

@Composable
private fun App() {
    val app = Wicaby.app
    val first by produceState<Snapshot?>(null) { value = app.prefs.current() }
    val start = first
    if (start == null) {
        // Cold start: the painted mark, only if reading the preferences takes a moment.
        Box(Modifier.fillMaxSize().background(C.bg), contentAlignment = Alignment.Center) { LogoLoader(C.label, stringResource(R.string.loading), size = 88.dp, delayMs = 150) }
        return
    }
    val snap by app.prefs.data.collectAsState(start)
    // A rerun wizard open when a language change recreated the activity: it comes back on top.
    var rerunOpen by rememberSaveable { mutableStateOf(false) }
    val stack = remember {
        val first = startRoute(start)
        if (first == Route.Main) SessionGate.unlock(start.session!!)
        if (first.picker) { SessionGate.lock(); com.wika.wicaby.tv.music.Music.release() }
        mutableStateListOf(first).apply { if (rerunOpen && first == Route.Main) add(Route.Welcome(rerun = true)) }
    }
    LaunchedEffect(stack.last()) { rerunOpen = (stack.last() as? Route.Welcome)?.rerun == true }
    // TP-10: the stored session only once the picker opened it; until then no Core.api, so no socket either.
    val active = SessionGate.active(snap.session)
    val api = remember(active, snap.deviceId) {
        active?.let { Api.of(it.server, snap.deviceId, it.token, it.userId) }.also { app.api = it }
    }
    // TP-06: the other signed-in servers, set before the screens below load their rows (none while locked).
    remember(snap.extras, snap.deviceId, api == null) {
        (if (api == null) emptyList() else snap.extras.map { Api.of(it.server, snap.deviceId, it.token, it.userId) }).also { Servers.extra = it }
    }
    // An account added or removed: every row on show reloads with the new set of servers.
    var extrasSeen by remember { mutableStateOf(snap.extras) }
    LaunchedEffect(snap.extras) {
        if (extrasSeen == snap.extras) return@LaunchedEffect
        extrasSeen = snap.extras
        Cache.map.clear()
        Cache.changed()
    }
    // TP-06: an extra server that was offline answers again: the rows on show reload with it.
    LaunchedEffect(Unit) { Servers.back.drop(1).collect { Cache.changed() } }
    // Debug builds: `am start ... --es previewPlayer <itemId>` opens the player OSD without loading media.
    val activity = LocalActivity.current as ComponentActivity
    val askBrowsable = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {}
    LaunchedEffect(api, snap.session == null) {
        if (api != null) openDeepLink(activity)
        if (api != null) WatchNext.follow(activity, "${api.server.id}|${api.userId}")
        // The launcher rows follow the session: this user's channels, or nothing once signed out (kept while locked;
        // their links wait for the picker, see openDeepLink).
        // A new channel past the first needs the viewer's yes (system dialog); asked once, when it is created.
        if (api != null) HomeChannels.sync(activity, api).forEach { id ->
            runCatching { askBrowsable.launch(Intent(TvContract.ACTION_REQUEST_CHANNEL_BROWSABLE).putExtra(TvContract.EXTRA_CHANNEL_ID, id)) }
        } else if (snap.session == null) {
            HomeChannels.clear(activity)
            WatchNext.clear(activity)
        }
        val id = activity.intent.getStringExtra("previewPlayer")?.takeIf(SafeNames::isValidId)
        if (BuildConfig.DEBUG && api != null && id != null) {
            activity.intent.removeExtra("previewPlayer")
            activity.startActivity(
                Intent(activity, PlayerActivity::class.java).putExtra(PlayerActivity.EXTRA_ID, id).putExtra(PlayerActivity.EXTRA_PREVIEW, true),
            )
        }
        // Debug builds: `--es debugReminder <channelId>` stores a reminder due in 3 s, to show the in-app banner (TV-1).
        val ch = activity.intent.getStringExtra("debugReminder")?.takeIf(SafeNames::isValidId)
        if (BuildConfig.DEBUG && api != null && ch != null) {
            activity.intent.removeExtra("debugReminder")
            val now = System.currentTimeMillis()
            com.wika.wicaby.core.livetv.Reminders.add(
                activity,
                com.wika.wicaby.core.livetv.Reminder(api.server.id, api.userId.orEmpty(), "debug-$now", ch, now + 123_000, "Journal de 20 h", ch, at = now + 3_000),
            )
        }
    }
    LaunchedEffect(snap.maxMbps, snap.accent, snap.displayMode) {
        app.maxMbps = snap.maxMbps
        app.accent = snap.accent
        app.displayMode = snap.displayMode
    }

    val holder = rememberSaveableStateHolder()
    val nav = remember { Nav(stack) { holder.removeState(it.toString()) } }
    val openId = OpenItem.id
    // A launcher row's page: only with a session open (TP-10: it waits behind "Who is watching?").
    LaunchedEffect(openId, api) {
        if (openId == null || api == null) return@LaunchedEffect
        OpenItem.id = null
        nav.push(Route.Detail(openId))
    }

    val overlay = remember { OverlayHost() }
    // The resume question, asked over whatever screen launched playback.
    val resumeItem = ResumePrompt.item
    val resumeTitle = stringResource(R.string.resume_title)
    val resumeAt = resumeItem?.let { stringResource(R.string.resume_at, clock(it.resumeMs)) }
    val fromStartLabel = stringResource(R.string.from_start)
    LaunchedEffect(resumeItem) {
        val it = resumeItem ?: return@LaunchedEffect
        ResumePrompt.item = null
        overlay.show {
            TvAlert(
                resumeTitle, it.seriesName?.takeIf { _ -> it.isEpisode }?.let { s -> "$s · ${it.name}" } ?: it.name,
                listOf(
                    AlertAction(resumeAt.orEmpty()) { overlay.close(); startPlayer(activity, it, false) },
                    AlertAction(fromStartLabel) { overlay.close(); startPlayer(activity, it, true) },
                ),
                focusIndex = 0, onDismiss = overlay::close,
            )
        }
    }
    // Sideloaded updates: checked at start (at most every 6 h); a newer version opens the card,
    // as does a manual check from Réglages > À propos.
    val update by com.wika.wicaby.core.update.Updater.state.collectAsState()
    var updateShown by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { com.wika.wicaby.core.update.Updater.checkAtStart() }
    // Also re-run when an overlay closes: an update found while one was open shows then.
    LaunchedEffect(update, overlay.open) {
        if (update is com.wika.wicaby.core.update.UpdateState.Available && !updateShown && !overlay.open) {
            updateShown = true
            overlay.show {
                com.wika.wicaby.tv.ui.UpdateDialog(onClose = {
                    updateShown = false
                    overlay.close()
                })
            }
        }
    }
    // Android 17: the local network rationale comes during setup and before the first call to a LAN server.
    val server = api?.server ?: snap.server
    val lanServer by produceState(false, server?.address) { value = server != null && com.wika.wicaby.core.net.LocalNetwork.blocks(activity, server.address) }
    // Snapped, not animated (the overlay's own fade covers the change): a full-screen blur rebuilt every frame is
    // among the costliest things a TV GPU can do, so tv-low devices go without.
    val blurOk = remember { Build.VERSION.SDK_INT >= 31 && !DeviceClassDetector.detect(activity, FormFactor.TV).isLow }
    val blur = if (overlay.open && blurOk) 18.dp else 0.dp

    WicabyTheme(Accents[snap.accent.coerceIn(Accents.indices)]) {
        CompositionLocalProvider(LocalNav provides nav, LocalApi provides api, LocalSnapshot provides snap, LocalOverlay provides overlay) {
            BackHandler(enabled = stack.size > 1) { nav.pop() }
            // Lift the screen above the keyboard (adjustResize): TV keyboards cover the lower half,
            // text fields then scroll themselves into what is left (TvTextField).
            ScreensaverHost(api.takeIf { stack.last() == Route.Main }, TvSettings.screensaverMin.value) {
            Box(Modifier.fillMaxSize().background(C.bg).imePadding()) {
                LocalNetworkGate(stack.last() == Route.Servers || stack.last() == Route.AddServer || lanServer) {
                    AnimatedContent(
                        modifier = Modifier.fillMaxSize().blur(blur),
                        targetState = stack.last(),
                        transitionSpec = {
                            (fadeIn(tween(260, delayMillis = 60)) + scaleIn(tween(320), initialScale = 0.985f)) togetherWith fadeOut(tween(160))
                        },
                        label = "nav",
                    ) { route ->
                        holder.SaveableStateProvider(route.toString()) {
                            when (route) {
                                Route.Servers -> ServerScreen()
                                Route.AddServer -> ServerScreen(add = true)
                                is Route.Login -> LoginScreen(route.server, route.add)
                                Route.Main -> {
                                    val locked = snap.session
                                    when {
                                        api != null -> MainScreen()
                                        locked == null -> LaunchedEffect(Unit) { nav.reset(Route.Servers) }
                                        // TP-10: just opened, the new session is still on its way from the preferences.
                                        else -> LaunchedEffect(Unit) { delay(3_000); nav.reset(Route.Login(locked.server)) }
                                    }
                                }
                                is Route.Detail -> if (api != null) ServerScope(route.serverId) { DetailScreen(route.id) }
                                is Route.Folder -> if (api != null) ServerScope(route.serverId) { FolderScreen(route.id, route.name) }
                                Route.History -> if (api != null) com.wika.wicaby.tv.ui.HistoryScreen()
                                is Route.PhotoView -> if (api != null) ServerScope(route.serverId) { com.wika.wicaby.tv.ui.photos.PhotoViewerScreen(route.key, route.index) }
                                is Route.PhotoAlbum -> if (api != null) ServerScope(route.serverId) {
                                    LocalApi.current?.let { com.wika.wicaby.tv.ui.photos.PhotoAlbumScreen(it, route.id, route.name, route.kind) }
                                }
                                is Route.Welcome -> com.wika.wicaby.tv.ui.WelcomeScreen(route.rerun)
                                is Route.PlexLink -> com.wika.wicaby.tv.ui.PlexLinkScreen(route.add)
                                is Route.Files -> if (api != null) com.wika.wicaby.tv.ui.FilesFolderScreen(route.sourceId, route.id, route.name)
                                is Route.MusicAlbum -> if (api != null) ServerScope(route.serverId) {
                                    LocalApi.current?.let { com.wika.wicaby.tv.music.AlbumScreen(it, route.id, route.name) }
                                }
                                is Route.MusicArtist -> if (api != null) ServerScope(route.serverId) {
                                    LocalApi.current?.let { com.wika.wicaby.tv.music.ArtistScreen(it, route.id, route.name) }
                                }
                                is Route.MusicLibrary -> if (api != null) ServerScope(route.serverId) {
                                    com.wika.wicaby.tv.music.MusicLibraryScreen(route.id, route.name, route.mode)
                                }
                            }
                        }
                    }
                }
                OverlayLayer(overlay)
                // TP-10: shows nothing while locked (no LocalApi): its Watch button would play that account's Live TV.
                com.wika.wicaby.tv.ui.livetv.ReminderBannerHost()
            }
            }
        }
    }
}

fun signOutCleanup() {
    Cache.map.clear()
    com.wika.wicaby.tv.music.Music.release() // no playback keeps a signed-out account's token alive
}

// "Bande-annonce" with a local trailer: the normal player, in trailer mode (nothing reported).
fun playTrailer(context: Context, trailerId: String, server: String? = null) {
    context.startActivity(
        Intent(context, PlayerActivity::class.java)
            .putExtra(PlayerActivity.EXTRA_ID, trailerId)
            .putExtra(PlayerActivity.EXTRA_SERVER, server)
            .putExtra(PlayerActivity.EXTRA_FROM_START, true)
            .putExtra(PlayerActivity.EXTRA_TRAILER, true),
    )
}
