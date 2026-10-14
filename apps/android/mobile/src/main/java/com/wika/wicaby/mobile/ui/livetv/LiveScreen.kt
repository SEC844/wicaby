package com.wika.wicaby.mobile.ui.livetv

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.text.format.DateFormat
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.livetv.ChannelsLoad
import com.wika.wicaby.core.livetv.DeviceClassDetector
import com.wika.wicaby.core.livetv.FormFactor
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.conflictCount
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.player.PlayerActivity
import com.wika.wicaby.mobile.ui.Centered
import com.wika.wicaby.mobile.ui.Chip
import com.wika.wicaby.mobile.ui.ErrorState
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Spinner
import com.wika.wicaby.mobile.ui.TopBar
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.uiLocale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Date
import com.wika.wicaby.core.R as CoreR

// Mobile Live TV (spec §3.1, §3.2, work package M-1): the "livetv" view opens here. Phones get two
// tabs: En direct (rails, then every channel) and Guide (the channel list with now/next, a lens
// bar and the time chip). Tapping a row opens the channel's agenda; the row's play glyph tunes.

/** One repository per server and user, kept while the process lives (the guide cache stays warm). */
object LiveRepos {
    private var key: String? = null
    private var repo: LiveTvRepository? = null

    // §21.9: the guide LRU trims with the process (registered once, on the application context).
    private val trim = object : ComponentCallbacks2 {
        override fun onTrimMemory(level: Int) {
            synchronized(LiveRepos) { repo }?.onTrimMemory(level)
        }

        override fun onConfigurationChanged(newConfig: Configuration) = Unit

        @Deprecated("Deprecated in Java")
        override fun onLowMemory() = Unit // onTrimMemory covers it
    }

    fun of(context: Context, api: Api): LiveTvRepository = synchronized(this) {
        if (repo == null) context.applicationContext.registerComponentCallbacks(trim)
        val k = "${api.server.id}/${api.userId}"
        repo?.takeIf { key == k } ?: run {
            repo?.let { old -> CoroutineScope(Dispatchers.IO).launch { old.close() } }
            val tuning = DeviceClassDetector.tuning(context, FormFactor.MOBILE)
            LiveTvRepository.create(context.applicationContext, api, tuning).also {
                repo = it
                key = k
            }
        }
    }
}

/** Tunes a channel: the player takes the TvChannel path (LiveTuner), and Récentes learns it. */
fun tune(context: Context, repo: LiveTvRepository, channelId: String) {
    repo.noteTuned(channelId)
    PlayerActivity.start(context, channelId, fromStart = false, server = Servers.extraOf(repo.api.serverId)?.server?.id)
}

/** Times follow the system 12/24 h switch (§21.8), never a hard-coded pattern. */
@Composable
fun rememberTimeFormat(): (Long) -> String {
    val context = LocalContext.current
    val locale = uiLocale()
    return remember(context, locale) { DateFormat.getTimeFormat(context).let { f -> { t: Long -> f.format(Date(t)) } } }
}

/** Live TV time (server-skew corrected), ticking every 30 s for progress bars and the airing row. */
@Composable
fun rememberNow(repo: LiveTvRepository): State<Long> = produceState(repo.now(), repo) {
    while (true) {
        delay(30_000)
        value = repo.now()
    }
}

// [manage]: IPTV's sources (a chip after the tabs); IPTV has no recordings.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LiveScreen(api: Api, title: String, onBack: () -> Unit, manage: (() -> Unit)? = null) {
    val iptv = api.server.kind == com.wika.wicaby.core.iptv.Iptv.KIND
    val context = LocalContext.current
    val repo = remember(api) { LiveRepos.of(context, api) }
    LaunchedEffect(repo) { repo.open() }
    // F8: the repository's timers run only while this screen is shown and the app is in the foreground.
    DisposableEffect(repo) {
        repo.gate.setSelected(true)
        onDispose { repo.gate.setSelected(false) }
    }
    LifecycleStartEffect(repo) {
        repo.gate.setForeground(true)
        onStopOrDispose { repo.gate.setForeground(false) }
    }

    var tab by rememberSaveable { mutableIntStateOf(0) }
    var agenda by rememberSaveable { mutableStateOf<String?>(null) }
    val load by repo.channelsLoad.collectAsState()
    val channels by repo.channels.collectAsState()
    val caps by repo.caps.collectAsState()
    val timers by repo.timers.collectAsState()

    val agendaRow = agenda?.let { id -> channels.firstOrNull { it.id == id } }
    if (agendaRow != null) BackHandler { agenda = null }

    var nonce by remember { mutableIntStateOf(0) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val pull = rememberPullToRefreshState()
    Column(Modifier.fillMaxSize()) {
        if (agendaRow == null) {
            TopBar(title, onBack)
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Chip(stringResource(R.string.livetv_tabs_now), selected = tab == 0) { tab = 0 }
                Chip(stringResource(R.string.livetv_tabs_guide), selected = tab == 1) { tab = 1 }
                // M-3: Enregistrements, and Programmés with its conflict count (hidden when read-only and empty, §9.7).
                if (!iptv) Chip(stringResource(R.string.livetv_tabs_recordings), selected = tab == 2) { tab = 2 }
                if (caps.canRecord || timers.isNotEmpty()) {
                    val wont = conflictCount(timers)
                    Chip(stringResource(R.string.livetv_tabs_scheduled) + if (wont > 0) "  $wont" else "", selected = tab == 3) { tab = 3 }
                }
                if (manage != null) {
                    Chip(stringResource(CoreR.string.iptv_sources), selected = false, onClick = manage)
                }
            }
        }
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                // Channels and now/next: the lineup refetches, every cached slab revalidates, the rails reload.
                refreshing = true
                nonce++
                repo.markGuideStale()
                scope.launch {
                    try {
                        // IPTV: the playlists and guides themselves, from their sources.
                        if (iptv) com.wika.wicaby.core.iptv.Iptv.refreshAll()
                        repo.loadChannels(force = true)
                    } finally {
                        refreshing = false
                    }
                }
            },
            state = pull,
            modifier = Modifier.fillMaxSize(),
            indicator = {
                PullToRefreshDefaults.Indicator(
                    state = pull, isRefreshing = refreshing, containerColor = G.elevated2, color = G.label,
                    modifier = Modifier.align(Alignment.TopCenter),
                )
            },
        ) {
            when {
                agendaRow != null -> ChannelAgenda(repo, agendaRow, onBack = { agenda = null })
                load == ChannelsLoad.NO_ACCESS -> Centered {
                    Text(stringResource(CoreR.string.livetv_guide_no_access), style = Type.body, color = G.label2, textAlign = TextAlign.Center, modifier = Modifier.padding(32.dp))
                }
                channels.isEmpty() && load == ChannelsLoad.FAILED -> Centered { ErrorState({ scope.launch { repo.loadChannels(force = true) } }) }
                channels.isEmpty() && load != ChannelsLoad.READY -> Centered { Spinner() }
                tab == 2 -> Recordings(repo, nonce)
                tab == 3 -> Scheduled(repo, nonce)
                tab == 0 -> NowList(repo, nonce, onAgenda = { agenda = it })
                else -> Box(Modifier.fillMaxSize()) { ListGuide(repo, onAgenda = { agenda = it }) }
            }
        }
    }
}
