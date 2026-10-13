package com.wika.wicaby.tv.ui.livetv

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.SystemClock
import android.util.Log
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.tv.material3.Text
import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.disk.DiskCache
import coil3.disk.directory
import coil3.request.crossfade
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.livetv.ChannelsLoad
import com.wika.wicaby.core.livetv.DeviceClassDetector
import com.wika.wicaby.core.livetv.FormFactor
import com.wika.wicaby.core.livetv.LensInput
import com.wika.wicaby.core.livetv.LensPrefs
import com.wika.wicaby.core.livetv.LensRef
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.applyLens
import com.wika.wicaby.core.livetv.conflictCount
import com.wika.wicaby.core.livetv.PendingJump
import com.wika.wicaby.core.livetv.PrefsLoad
import com.wika.wicaby.core.livetv.Reminder
import com.wika.wicaby.core.livetv.Reminders
import com.wika.wicaby.core.livetv.Viewport
import com.wika.wicaby.core.livetv.slabOf
import com.wika.wicaby.tv.BuildConfig
import com.wika.wicaby.tv.LocalApi
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.data.TvSettings
import com.wika.wicaby.tv.player.PlayerActivity
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Centered
import com.wika.wicaby.tv.ui.EdgeSpec
import com.wika.wicaby.tv.ui.ErrorState
import com.wika.wicaby.tv.ui.Ic
import com.wika.wicaby.tv.ui.LastFocus
import com.wika.wicaby.tv.ui.LocalOverlay
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.Spinner
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.rememberFocusMemory
import com.wika.wicaby.tv.ui.tvFocus
import com.wika.wicaby.tv.ui.remembered
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

// The TV Live TV screen (spec §3.1, TV-1): one per server and user, opened from the `livetv` view.
// Tabs En direct · Guide · Programmés · Enregistrements (TV-2 the grid, GuideGrid.kt; TV-4 the DVR tabs, ScheduledTab.kt
// and RecordingsTab.kt, and "Gérer les chaînes", ChannelManager.kt); En direct is
// NowTab.kt, the compact list ChannelList.kt. Also the in-app reminder banner (§21.3: TV is in-app first).

private const val MINUTE = 60_000L

/** Process-wide Live TV state for the TV app: the repository of the signed-in server and user, logos. */
object LiveTv {
    private var key: String? = null
    private var current: LiveTvRepository? = null

    /** The rails of En direct, kept across visits so a warm open paints at once. */
    var rails: NowRails? = null
        private set

    /** F1 plate verdict per "channelId|logoTag" (main thread only). */
    val plates = HashMap<String, Boolean>()

    private var logos: ImageLoader? = null
    private var trimHooked = false

    /** Set once per process when `live.startTab = last` tuned at the first open. */
    var autoTuned = false

    fun repo(context: Context, api: Api): LiveTvRepository {
        val k = "${api.server.id}|${api.userId}"
        current?.takeIf { key == k }?.let { return it }
        current?.let { old -> Core.scope.launch { runCatching { old.close() } } }
        val repo = LiveTvRepository.create(context.applicationContext, api, DeviceClassDetector.tuning(context, FormFactor.TV))
        key = k
        current = repo
        rails = NowRails(repo)
        hookTrim(context.applicationContext)
        return repo
    }

    /** §21.9: RUNNING_LOW halves the programme LRU; RUNNING_CRITICAL or the background keeps the visible set and drops decoded images. */
    private fun hookTrim(app: Context) {
        if (trimHooked) return
        trimHooked = true
        app.registerComponentCallbacks(object : ComponentCallbacks2 {
            override fun onTrimMemory(level: Int) {
                current?.onTrimMemory(level)
                @Suppress("DEPRECATION")
                if (level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL || level >= ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN) {
                    SingletonImageLoader.get(app).memoryCache?.clear()
                }
            }

            override fun onConfigurationChanged(newConfig: Configuration) = Unit

            @Deprecated("Deprecated in Java")
            override fun onLowMemory() = Unit
        })
    }

    /** Logos: the app's loader (shared memory cache, OkHttp) with its own 32 MB disk cache and no crossfade (§2.2, §21.9). */
    fun logoLoader(context: Context): ImageLoader = logos ?: SingletonImageLoader.get(context).newBuilder()
        .diskCache { DiskCache.Builder().directory(context.applicationContext.cacheDir.resolve("livetv_logos")).maxSizeBytes(32L shl 20).build() }
        .crossfade(false)
        .build()
        .also { logos = it }

    /** Tunes [channelId] in the player (which runs LiveSession); [start] = F2's deep-link answer, "beginning" or "live". */
    fun tune(context: Context, repo: LiveTvRepository, channelId: String, start: String? = null) {
        // shortcut: Récentes is noted at the tune request, not at adoption; TV-3 moves it to the player's adopted event.
        repo.noteTuned(channelId)
        context.startActivity(Intent(context, PlayerActivity::class.java).putExtra(PlayerActivity.EXTRA_ID, channelId).putExtra(PlayerActivity.EXTRA_LIVE_START, start))
    }

    /** TV-3: GUIDE (or Back, [viaBack]) in the player asks for the Guide tab focused on [channelId]; TP-12: the search, on a programme ([jump]). */
    class GuideAsk(val channelId: String, val viaBack: Boolean, val jump: PendingJump? = null)

    /** Set by the player as it closes; Main switches to the Live TV tab, LiveTvScreen opens the Guide and clears it. */
    val guideFor = MutableStateFlow<GuideAsk?>(null)
}

private enum class LiveTab(val label: Int) {
    NOW(R.string.livetv_tabs_now), GUIDE(R.string.livetv_tabs_guide), SCHEDULED(R.string.livetv_tabs_scheduled), RECORDINGS(R.string.livetv_tabs_recordings),
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun LiveTvScreen(api: Api, top: Dp, onScrolled: (Boolean) -> Unit) {
    val context = LocalContext.current
    val repo = remember(api) { LiveTv.repo(context, api) }
    val rails = remember(repo) { LiveTv.rails!! }
    val openedAt = remember { SystemClock.elapsedRealtime() }
    var tab by rememberSaveable { mutableStateOf(if (TvSettings.liveStartTab.value == TvSettings.LIVE_START_GUIDE) LiveTab.GUIDE else LiveTab.NOW) }

    // F8: Live TV timers run while this screen is shown and the app is in the foreground.
    LaunchedEffect(repo) { repo.open() }
    DisposableEffect(repo) {
        repo.gate.setSelected(true)
        onDispose { repo.gate.setSelected(false) }
    }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner, repo) {
        val obs = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_START -> repo.gate.setForeground(true)
                Lifecycle.Event.ON_STOP -> repo.gate.setForeground(false)
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }
    val now by produceState(repo.now(), repo) {
        repo.gate.visible.collectLatest { on ->
            while (on) {
                value = repo.now()
                delay(30_000)
            }
        }
    }
    LaunchedEffect(rails) { repo.gate.every(this, 5 * MINUTE) { rails.load(api) } }

    // live.startTab = last: tune the last channel once per process, as soon as the synced recents are known.
    LaunchedEffect(repo) {
        if (TvSettings.liveStartTab.value != TvSettings.LIVE_START_LAST || LiveTv.autoTuned) return@LaunchedEffect
        LiveTv.autoTuned = true
        withTimeoutOrNull(3_000) { repo.prefs.load.first { it != PrefsLoad.PENDING } }
        repo.prefs.prefs.value.recents.firstOrNull()?.let { LiveTv.tune(context, repo, it) }
    }

    val load by repo.channelsLoad.collectAsState()
    val channels by repo.channels.collectAsState()
    val prefs by repo.prefs.prefs.collectAsState()
    // "Toutes les chaînes" is every visible channel: the synced lens (desktop chip) is ignored here until TV-2 shows it.
    val rows = remember(channels, prefs) {
        applyLens(LensInput(channels, LensRef.All, LensPrefs(prefs.fav, prefs.hidden, prefs.groups, prefs.recents), prefs.sort, prefs.favFirst))
    }
    val version by repo.guideVersion.collectAsState()
    val tick = Tick(now, version)
    val model = remember(channels, prefs) { NowModel.of(channels, prefs) }

    // TV-4: Programmés is hidden without record rights and timers (§9.7); its badge counts the timers that will not record.
    val timers by repo.timers.collectAsState()
    val caps by repo.caps.collectAsState()
    val conflicts = conflictCount(timers)
    val dvr = remember(repo) { dvrOf(repo) }
    val overlay = LocalOverlay.current

    val listState = rememberLazyListState()
    LaunchedEffect(listState) { snapshotFlow { listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > 80 }.collect(onScrolled) }
    // The planner fetches the "now" slab of what is on screen: the rail channels and the visible list rows.
    val railIds by rememberUpdatedState(if (tab == LiveTab.NOW) model.railIds else emptyList())
    LaunchedEffect(listState, repo) {
        snapshotFlow {
            val visible = listState.layoutInfo.visibleItemsInfo.mapNotNull { (it.key as? String)?.takeIf { k -> k.startsWith(ROW_KEY) }?.substring(ROW_KEY.length) }
            Triple(railIds, visible, slabOf(now))
        }.distinctUntilChanged().collect { (rail, visible, _) ->
            val ids = (rail + visible).distinct()
            if (ids.isNotEmpty()) {
                val t = repo.now()
                repo.setViewport(Viewport(ids, 0, ids.lastIndex, t, t + 30 * MINUTE, repo.tuning))
            }
        }
    }
    // §16.3: first paint of En direct (the card and the rails), for the "1 s warm" budget.
    var painted by remember { mutableStateOf(false) }
    if (!painted && BuildConfig.DEBUG && model.railIds.isNotEmpty()) {
        painted = true
        Log.d(LIVE_TAG, "en direct first paint ${SystemClock.elapsedRealtime() - openedAt} ms (resume=${model.last != null}, rails=${model.railIds.size}, guideVersion=$version)")
    }

    val memory = rememberFocusMemory()
    val margin = with(LocalDensity.current) { 110.dp.toPx() }
    val spec = remember(margin) { EdgeSpec(margin) }
    val tune: (String) -> Unit = { LiveTv.tune(context, repo, it) }

    // TV-3: the player's GUIDE / Back opens the Guide tab on its channel (shortcut until picture-in-guide, TV-5).
    var guideJump by remember { mutableStateOf<String?>(null) }
    var programJump by remember { mutableStateOf<PendingJump?>(null) }
    val pills = remember { LiveTab.entries.associateWith { FocusRequester() } }
    val backs = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    LaunchedEffect(repo) {
        LiveTv.guideFor.filterNotNull().collect { a ->
            LiveTv.guideFor.value = null
            val from = tab
            tab = LiveTab.GUIDE
            guideJump = a.channelId
            programJump = a.jump
            if (!a.viaBack || from == LiveTab.GUIDE || backs == null) return@collect
            // §8.7: a second Back within 2 s exits the guide to where the player was opened from. Registered two
            // frames after the switch, so after the grid's own Back handler, and it wins for those 2 s.
            withFrameNanos { }
            withFrameNanos { }
            val cb = object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    remove()
                    // Focus moves first: if the focused grid just vanished, the view would refocus the Accueil tab.
                    runCatching { pills.getValue(from).requestFocus() }
                    tab = from
                }
            }
            backs.addCallback(cb)
            try {
                delay(2_000)
            } finally {
                cb.remove()
            }
        }
    }
    // First focus of En direct: Reprendre, else the first rail card (NowTab attaches it). Down from the top bar enters here too.
    val entry = remember { FocusRequester() }
    var arrived by rememberSaveable { mutableStateOf(false) }

    Box(Modifier.fillMaxSize()) {
        when {
            load == ChannelsLoad.NO_ACCESS -> Centered { Text(stringResource(com.wika.wicaby.core.R.string.livetv_guide_no_access), style = Type.title3, color = C.label2) }
            load == ChannelsLoad.FAILED -> Centered { ErrorState { Core.scope.launch { repo.loadChannels(force = true) } } }
            channels.isEmpty() && load == ChannelsLoad.READY -> Centered { Text(stringResource(R.string.livetv_now_empty), style = Type.body, color = C.label3) }
            channels.isEmpty() -> Centered { Spinner() }
        }
        if (channels.isEmpty()) return@Box
        CompositionLocalProvider(LocalBringIntoViewSpec provides spec) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize()
                    // Compose does not run a nested onEnter for Down from the top bar, so the first arrival is redirected here.
                    .onFocusChanged {
                        if (it.hasFocus && !arrived) {
                            arrived = true
                            if (tab == LiveTab.NOW && memory.key.let { k -> k == null || k.startsWith("tab-") }) runCatching { entry.requestFocus() }
                        }
                    }
                    .focusGroup(),
                contentPadding = PaddingValues(top = top, bottom = 56.dp)) {
                item("tabs") {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(start = 48.dp, bottom = 18.dp)) {
                        LiveTab.entries.forEach { t ->
                            if (t == LiveTab.SCHEDULED && !caps.canRecord && timers.isEmpty()) return@forEach
                            val label = stringResource(t.label)
                            val badge = if (t == LiveTab.SCHEDULED && conflicts > 0) pluralStringResource(R.plurals.livetv_scheduled_badge_aria, conflicts, conflicts) else null
                            TabPill(
                                if (badge != null) "$label · $conflicts" else label, selected = tab == t, onClick = { tab = t },
                                modifier = Modifier.remembered(memory, "tab-${t.name}", default = t == tab && tab == LiveTab.GUIDE).focusRequester(pills.getValue(t)).semantics { if (badge != null) contentDescription = "$label, $badge" },
                            )
                        }
                        TabPill(stringResource(R.string.livetv_manage_title), selected = false, onClick = { showChannelManager(overlay, api, repo) })
                    }
                }
                when (tab) {
                    LiveTab.NOW -> nowItems(api, repo, model, rails, tick, memory, entry, tune, onGuide = { tab = LiveTab.GUIDE })
                    LiveTab.SCHEDULED -> item("scheduled") { ScheduledTab(repo, now, memory) }
                    LiveTab.RECORDINGS -> item("recordings") { RecordingsTab(api, repo, memory) }
                    // TV-2: the guide grid, one item under the tabs (the focused tab pill survives the switch); entering it lifts it under the safe area.
                    LiveTab.GUIDE -> item("guide") {
                        val scope = rememberCoroutineScope()
                        val d = LocalDensity.current
                        val lift = with(d) { (top - 27.dp).roundToPx() }
                        val h = with(d) { listState.layoutInfo.viewportSize.height.toDp() } - 27.dp // the whole screen under the safe area
                        GuideGrid(api, repo, onEnter = { scope.launch { listState.scrollToItem(1, lift) } }, Modifier.height(h), jumpTo = guideJump, jumpAt = programJump, onJumped = { guideJump = null; programJump = null })
                    }
                }
                if (tab == LiveTab.NOW) items(rows, key = { ROW_KEY + it.id }) { row ->
                    ChannelListRow(
                        api, repo, row, tick, onTune = { tune(row.id) },
                        modifier = Modifier.padding(start = 48.dp, end = 48.dp, bottom = 6.dp).remembered(memory, "row-${row.id}")
                            .recordKeys(dvr) { nowNext(repo, row.id, repo.now()).first },
                    )
                }
            }
        }
    }
}

internal const val ROW_KEY = "ch:"

/** A Live TV tab: the selected one is filled and full white, the other unfilled and dimmed (no accent, §11); focus is the house white pill. */
@Composable
private fun TabPill(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    var focused by remember { mutableStateOf(false) }
    Text(
        text, style = Type.headline, maxLines = 1,
        color = when {
            focused -> Color.Black
            selected -> C.label
            else -> C.label3
        },
        modifier = modifier
            .tvFocus(RoundedCornerShape(50), focusedScale = 1.08f, onFocusChange = { focused = it }, onClick = onClick)
            .background(if (focused) Color.White else if (selected) C.fill4 else Color.Transparent)
            .padding(horizontal = 22.dp, vertical = 11.dp),
    )
}

// ---------------------------------------------------------------------------
// In-app reminder banner (§9.6, §21.3): over any screen of the app, "Regarder" tunes.

@Composable
fun ReminderBannerHost() {
    val api = LocalApi.current ?: return
    val context = LocalContext.current
    var shown by remember { mutableStateOf<Reminder?>(null) }
    LaunchedEffect(api) {
        Reminders.fired.collect { r -> if (r.serverId == api.server.id && r.userId == api.userId) shown = r }
    }
    val r = shown ?: return
    val focus = remember { FocusRequester() }
    val back = remember(r) { LastFocus.requester }
    fun close() {
        shown = null
        runCatching { back?.requestFocus() }
    }
    LaunchedEffect(r) {
        delay(60)
        runCatching { focus.requestFocus() }
        delay(15_000)
        close()
    }
    BackHandler { close() }
    Box(Modifier.fillMaxSize().padding(top = 32.dp, end = 32.dp), contentAlignment = Alignment.TopEnd) {
        Column(
            Modifier.width(420.dp)
                .background(C.elevated.copy(alpha = 0.92f), RoundedCornerShape(Radius.lg)) // opaque, no blur on TV (§11)
                .padding(20.dp),
        ) {
            Text(stringResource(com.wika.wicaby.core.R.string.livetv_reminder_title, r.title), style = Type.title3, color = C.label, maxLines = 2)
            Text(
                stringResource(com.wika.wicaby.core.R.string.livetv_reminder_body, r.channelName, timeText(r.start)),
                style = Type.footnote, color = C.label2, maxLines = 1, modifier = Modifier.padding(top = 4.dp, bottom = 14.dp),
            )
            Pill(
                stringResource(com.wika.wicaby.core.R.string.livetv_reminder_watch), icon = Ic.Play, primary = true,
                onClick = {
                    shown = null
                    LiveTv.tune(context, LiveTv.repo(context, api), r.channelId)
                },
                modifier = Modifier.focusRequester(focus),
            )
        }
    }
}
