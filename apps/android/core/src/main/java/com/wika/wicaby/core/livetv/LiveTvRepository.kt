package com.wika.wicaby.core.livetv

import android.content.Context
import com.wika.wicaby.core.data.Api
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit

// Live TV repository (spec §4.1, §6.3, §7, §21.2 F8/F9, §21.4, §21.9): one per server and user.
// Channels (stale-while-revalidate from the disk cache, 10 min), the lens pipeline (off the main
// thread), DisplayPreferences (LivePrefs), the timer overlay (polled every 60 s while Live TV is
// visible, until X-06 brings server events), capabilities (clock skew, the HD probe, tuners), and
// the guide tiles: the pure planner, a queue with the device's concurrency that drops what scrolled
// away, one retry on connection errors and 5xx (never on a timeout), and the GuideCache.

const val TIMER_POLL_MS = 60_000L
const val RETRY_DELAY_MS = 2_000L

/**
 * One gate for every Live TV timer (F8): the Live TV screen is selected and the app is in the
 * foreground. Becoming visible again runs each periodic job once at once (the catch-up refresh).
 */
class VisibilityGate {
    @Volatile private var selected = false
    @Volatile private var foreground = true
    private val _visible = MutableStateFlow(false)
    val visible: StateFlow<Boolean> = _visible.asStateFlow()

    fun setSelected(on: Boolean) {
        selected = on
        _visible.value = selected && foreground
    }

    fun setForeground(on: Boolean) {
        foreground = on
        _visible.value = selected && foreground
    }

    /** Runs [block] now and every [periodMs] while visible; stops when hidden. */
    fun every(scope: CoroutineScope, periodMs: Long, block: suspend () -> Unit): Job = scope.launch {
        visible.collectLatest { on ->
            while (on) {
                try {
                    block()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                }
                delay(periodMs)
            }
        }
    }
}

enum class ChannelsLoad { IDLE, LOADING, READY, FAILED, NO_ACCESS }

class LiveTvRepository(
    val api: LiveTvApi,
    val cache: GuideCache,
    val prefs: LivePrefs,
    val tuning: PlatformTuning,
    private val scope: CoroutineScope,
) {
    companion object {
        /** One server and user: the cache under cacheDir, the DataStore mirror, its own IO scope. */
        fun create(context: Context, api: Api, tuning: PlatformTuning): LiveTvRepository {
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            val live = LiveTvApi(api)
            val cache = GuideCache(guideDir(context.cacheDir, live.serverId, live.userId), tuning, live::now, scope)
            val prefs = LivePrefs(live::displayPrefs, live::saveDisplayPrefs, scope, context.applicationContext.liveTvStore, "${live.serverId}.${live.userId}")
            return LiveTvRepository(live, cache, prefs, tuning, scope)
        }
    }

    val gate = VisibilityGate()

    private val _channels = MutableStateFlow<List<ChannelRow>>(emptyList())
    val channels: StateFlow<List<ChannelRow>> = _channels.asStateFlow()
    private val _channelsLoad = MutableStateFlow(ChannelsLoad.IDLE)
    val channelsLoad: StateFlow<ChannelsLoad> = _channelsLoad.asStateFlow()
    private val channelsMutex = Mutex()
    @Volatile private var channelsAt = Long.MIN_VALUE
    @Volatile private var channelsFromServer = false

    // IPTV records nothing (no server between the app and the streams).
    private val _caps = MutableStateFlow(defaultCaps(api.kind).let { if (api.api.server.kind == com.wika.wicaby.core.iptv.Iptv.KIND) it.copy(canRecord = false) else it })
    val caps: StateFlow<LiveCaps> = _caps.asStateFlow()

    private val _timers = MutableStateFlow<List<TimerLite>>(emptyList())
    val timers: StateFlow<List<TimerLite>> = _timers.asStateFlow()
    private val _overlay = MutableStateFlow<Map<String, TimerLite>>(emptyMap())

    /** programId → timer (marks in the guide). */
    val overlay: StateFlow<Map<String, TimerLite>> = _overlay.asStateFlow()

    /** Bumped when a tile lands or fails: the guide reads [programs] again. */
    private val _guideVersion = MutableStateFlow(0L)
    val guideVersion: StateFlow<Long> = _guideVersion.asStateFlow()

    /** The guide rows, the channel list, the mini-guide and the zap list: hidden out → lens → sort. */
    val rows: StateFlow<List<ChannelRow>> = combine(_channels, prefs.prefs) { ch, p ->
        applyLens(LensInput(ch, p.lens, LensPrefs(p.fav, p.hidden, p.groups, p.recents), p.sort, p.favFirst))
    }.flowOn(Dispatchers.Default).stateIn(scope, SharingStarted.Eagerly, emptyList())

    val lenses: StateFlow<List<LensRef>> = combine(_channels, prefs.prefs) { ch, p ->
        availableLenses(ch, p.groups, api.kind == ServerKind.EMBY)
    }.flowOn(Dispatchers.Default).stateIn(scope, SharingStarted.Eagerly, listOf(LensRef.All))

    /** Live TV time (client clock corrected by the server skew, §21.4). */
    fun now(): Long = api.now()

    private var started = false

    /** Live TV opened: prefs, channels (when older than 10 min), timers. Safe to call on every open. */
    fun open() {
        synchronized(this) {
            if (!started) {
                started = true
                scope.launch { cache.purge() }
                scope.launch { api.clockSkewMs.collect { s -> _caps.update { it.copy(clockSkewMs = s) } } }
                scope.launch { views.filterNotNull().collect { plan(it) } }
                gate.every(scope, TIMER_POLL_MS) { requestTimers(0) }
                scope.launch {
                    val n = try { api.tunerCount(api.info()) } catch (_: LiveApiException) { null }
                    if (n != null) _caps.update { it.copy(tunerCount = n) }
                }
            }
        }
        scope.launch { prefs.load() }
        scope.launch { loadChannels() }
        requestTimers()
    }

    /** Saves what is pending and stops every job of this repository. */
    suspend fun close() {
        cache.flush()
        prefs.flush()
        scope.cancel()
    }

    // ---- Channels ----

    private fun publish(fresh: List<ChannelRow>) {
        // An equal list keeps the current instances (StateFlow would drop it, and canon must match them).
        val list = _channels.value.takeIf { it == fresh } ?: fresh
        val ids = HashMap<String, String>(list.size * 2)
        for (r in list) ids.getOrPut(r.id) { r.id }
        cache.canon = { ids[it] ?: it }
        _channels.value = list
    }

    private suspend fun <T> withRetry(block: suspend () -> T): T = try {
        block()
    } catch (e: LiveApiException) {
        if (!e.retryable) throw e
        delay(RETRY_DELAY_MS)
        block()
    }

    suspend fun loadChannels(force: Boolean = false) = channelsMutex.withLock {
        if (_channels.value.isEmpty()) {
            cache.readChannels()?.let {
                publish(it.rows)
                channelsAt = it.fetchedAt
                _channelsLoad.value = ChannelsLoad.READY
            }
        }
        if (!force && channelsFromServer && api.now() - channelsAt < CHANNELS_FRESH_MS) return@withLock
        if (_channels.value.isEmpty()) _channelsLoad.value = ChannelsLoad.LOADING
        try {
            val list = fetchChannels()
            channelsAt = api.now()
            channelsFromServer = true
            publish(list)
            _channelsLoad.value = ChannelsLoad.READY
            cache.writeChannels(ChannelsSnapshot(channelsAt, list))
        } catch (e: LiveApiException) {
            when {
                e.fail == LiveApiException.Fail.HTTP && (e.status == 401 || e.status == 403) -> _channelsLoad.value = ChannelsLoad.NO_ACCESS
                _channels.value.isEmpty() -> _channelsLoad.value = ChannelsLoad.FAILED
                // else: the cached lineup stays (offline guide)
            }
        }
    }

    private suspend fun fetchChannels(): List<ChannelRow> {
        val size = tuning.channelPage
        val (first, total) = withRetry { api.channelsPage(0, size) }
        val all = ArrayList(first)
        if (total == null) { // no total: page until a short page
            var last = first
            while (last.size == size) {
                last = withRetry { api.channelsPage(all.size, size) }.first
                all += last
            }
            return all
        }
        for (group in (size until total step size).chunked(maxOf(1, tuning.channelPagesInFlight))) {
            all += coroutineScope { group.map { s -> async { withRetry { api.channelsPage(s, size) }.first } }.awaitAll() }.flatten()
        }
        return all
    }

    /** The whole lineup for number entry (hidden channels included, flagged). */
    fun lineup(): List<DigitChannel> {
        val hidden = prefs.prefs.value.hidden.toHashSet()
        return _channels.value.map { DigitChannel(it.id, it.number, it.id in hidden) }
    }

    /** Favourite toggle: optimistic, rolled back on failure; refused while favourites or prefs did not load. */
    suspend fun setFavorite(id: String, favorite: Boolean): Boolean {
        if (!prefs.canEditFavorites(channelsFromServer)) return false
        patchFavorite(id, favorite)
        return try {
            api.setFavorite(id, favorite)
            val p = prefs.prefs.value
            prefs.update(PrefField.FAV, p.copy(fav = if (favorite) p.fav - id + id else p.fav - id))
            true
        } catch (e: LiveApiException) {
            patchFavorite(id, !favorite)
            false
        }
    }

    private fun patchFavorite(id: String, on: Boolean) = _channels.update { list -> list.map { if (it.id == id) it.copy(favorite = on) else it } }

    /** A channel was adopted by the player: Récentes. */
    fun noteTuned(id: String) {
        val p = prefs.prefs.value
        prefs.update(PrefField.RECENTS, p.copy(recents = pushRecent(p.recents, id)))
    }

    // ---- Timers ----

    private var timersJob: Job? = null

    /** Refetch the overlay; calls within [delayMs] merge into one (timer events, writes, the poll). */
    fun requestTimers(delayMs: Long = 1_000) {
        synchronized(this) {
            if (timersJob?.isActive == true) return
            timersJob = scope.launch {
                delay(delayMs)
                refreshTimers()
            }
        }
    }

    suspend fun refreshTimers() {
        val list = try { api.timers() } catch (_: LiveApiException) { return }
        _timers.value = list
        _overlay.value = buildOverlay(list)
    }

    /** A DVR write failed: 403 downgrades canRecord (§9.7). */
    fun noteDvrError(err: DvrError) = _caps.update { it.copy(canRecord = canRecordAfter(it.canRecord, err)) }

    // ---- Guide tiles ----

    private data class View(val view: Viewport, val dir: Int, val idle: Boolean, val seq: Long)
    private class Pending(val req: TileRequest, val keys: List<String>) {
        @Volatile var dropped = false
    }

    private val views = MutableStateFlow<View?>(null)
    private var viewSeq = 0L
    private val tileLock = Any()
    private val inFlight = HashSet<String>()
    private val failed = HashSet<String>()
    private val queued = ArrayList<Pending>()
    private val tileSlots = Semaphore(maxOf(1, tuning.concurrency))
    private var hdTiles = 0

    /**
     * The guide's window changed (cheap, any thread). Planning runs in the background, conflated:
     * [dir] is the horizontal scroll direction; [idle] adds the P3 "now" prefetch (after 2 s without input).
     */
    fun setViewport(view: Viewport, dir: Int = 0, idle: Boolean = false) {
        views.value = View(view, dir, idle, synchronized(tileLock) { ++viewSeq })
    }

    private fun keysOf(r: TileRequest) = r.channelIds.flatMap { id -> r.slabs.map { coverageKey(id, it) } }

    private fun plan(vv: View) {
        val v = vv.view
        if (v.rows.isEmpty()) return
        val now = api.now()
        val last = v.rows.lastIndex
        val shown = HashSet<String>()
        for (r in v.firstRow.coerceIn(0, last)..v.lastRow.coerceIn(0, last)) for (k in slabRange(v.from, v.to)) shown.add(coverageKey(v.rows[r], k))
        cache.visible = shown
        val idleIds = if (vv.idle) idleSet(reconcileFavorites(_channels.value, prefs.prefs.value.fav).map { it.id }, v.rows, tuning) else emptyList()
        val before = cache.programCount
        val covered = HashSet<String>()
        synchronized(tileLock) {
            covered.addAll(inFlight)
            covered.addAll(failed)
        }
        fun check(id: String, k: Long) {
            val u = cache.unit(id, k) // warms memory from disk for the whole window
            if (u != null && cache.isFresh(u, now)) covered.add(coverageKey(id, k))
        }
        val w = planWindow(v)
        for (r in w.rowFrom..w.rowTo) for (k in w.slabFrom..w.slabTo) check(v.rows[r], k)
        for (id in idleIds) check(id, slabOf(now))
        val reqs = planTiles(PlanInput(v, vv.dir, covered, vv.idle, now, idleIds))
        val start = ArrayList<Pending>()
        synchronized(tileLock) {
            val dropped = dropStale(queued.map { it.req }, v).dropped.toHashSet()
            queued.removeAll { p ->
                (p.req in dropped).also { if (it) { p.dropped = true; inFlight.removeAll(p.keys.toSet()) } }
            }
            for (r in reqs) {
                val p = Pending(r, keysOf(r))
                inFlight.addAll(p.keys)
                queued.add(p)
                start.add(p)
            }
        }
        if (start.isNotEmpty() || cache.programCount != before) _guideVersion.update { it + 1 } // the disk warm-up may have filled rows
        for (p in start) {
            scope.launch {
                tileSlots.withPermit {
                    if (p.dropped) return@withPermit
                    synchronized(tileLock) { queued.remove(p) }
                    fetchTile(p)
                }
            }
        }
    }

    private suspend fun fetchTile(p: Pending) {
        val req = p.req
        val ok = try {
            val genres = _caps.value.categorySource == CategorySource.GENRES
            val ans = withRetry { api.programsTile(req.channelIds, req.from, req.to, genres, cache.canon) }
            val at = api.now()
            for ((id, list) in ingestTile(req, ans.programs).byChannel) cache.put(id, req.slabs, list, at)
            probeHd(ans.sawHdKey)
            true
        } catch (e: LiveApiException) {
            false
        }
        synchronized(tileLock) {
            inFlight.removeAll(p.keys.toSet())
            if (!ok) failed.addAll(p.keys)
        }
        _guideVersion.update { it + 1 }
    }

    /** V16: no IsHD key in the first 3 tiles → the server has no HD flag (Emby 4.1.1 DTO). */
    private fun probeHd(saw: Boolean) = synchronized(tileLock) {
        if (_caps.value.hdFlag != Tri.UNKNOWN) return@synchronized
        if (saw) _caps.update { it.copy(hdFlag = Tri.TRUE) } else if (++hdTiles >= 3) _caps.update { it.copy(hdFlag = Tri.FALSE) }
    }

    /** Cached programmes of a channel in [from, to) (memory only: safe on the main thread). */
    fun programs(channelId: String, from: Long, to: Long): List<ProgramLite> = cache.programs(channelId, from, to, disk = false)

    /** The row shows the "Réessayer" filler. */
    fun rowFailed(channelId: String, from: Long, to: Long): Boolean = synchronized(tileLock) {
        slabRange(from, to).any { coverageKey(channelId, it) in failed }
    }

    fun retryRow(channelId: String) {
        synchronized(tileLock) { failed.removeAll { it.startsWith("$channelId|") } }
        views.value?.let { setViewport(it.view, it.dir, it.idle) }
    }

    /** Guide refresh (or the server's guide task ended): everything revalidates lazily. */
    fun markGuideStale() {
        cache.markAllStale()
        synchronized(tileLock) { failed.clear() }
        views.value?.let { setViewport(it.view, it.dir, it.idle) }
    }

    /** From Application/Activity.onTrimMemory (§21.9). */
    fun onTrimMemory(level: Int) = cache.onTrimMemory(level)
}
