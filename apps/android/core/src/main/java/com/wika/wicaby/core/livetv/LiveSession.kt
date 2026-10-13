package com.wika.wicaby.core.livetv

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.wika.wicaby.core.BuildConfig
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.MediaSource
import com.wika.wicaby.core.data.MediaStream
import com.wika.wicaby.core.data.json
import com.wika.wicaby.core.data.Api
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.roundToInt

// Live TV session plumbing (spec §5.3, §8.1, §8.2, §8.8, §21.3), the Android twin of
// D/main/livetv/live-session.ts and live-player.ts: the tune ladder, LiveStreams Open and Close, the
// release ledger, the make-before-break / break-before-make policy, and (LiveTuner) the player side:
// first frame, stall and pause watch, recovery, track memory.
//
// Ledger rule: every LiveStreamId is released exactly once. An adopted stream (its first frame was
// shown) is released by its Stopped report; any other one (superseded, timed out, late, failed rung,
// swept) by POST /LiveStreams/Close with the ids in the query string. A stream that was never adopted
// never gets a Stopped report.

enum class ZapPolicy { MBB, BBM }

/** Setting `live.release` (§15). */
enum class ReleaseMode { AUTO, ALWAYS, NEVER }

enum class LiveFailure { BUSY, TIMEOUT, FAILED, NO_STREAM, SUPERSEDED, PLAY }

class LiveError(val kind: LiveFailure, message: String? = null) : Exception(message ?: kind.name)

/** An HTTP error answer, as LiveApi reports it. */
class LiveHttpException(val status: Int, message: String) : IOException(message)

enum class LiveNotice { TUNER_RELEASED, ZAP_FAILED, RECOVERING, PAUSED_RELEASED }

/** Timeouts (§8.1, §8.8); the tests shrink them. */
class LiveTiming(
    val tuneTimeoutMs: Long = 15_000,
    val firstFrameMs: Long = 12_000,
    val stallMs: Long = 8_000,
    val pauseReleaseMs: Long = 30_000,
    val closeRetryMs: Long = 2_000,
    val sweepMs: Long = 1_500,
)

const val POLICY_MEMORY_MS = 7 * 86_400_000L

/** The part of the server client the session uses (a fake in LiveSessionTest). */
interface LiveApi {
    val kind: ServerKind
    val userId: String?
    val deviceId: String

    /** The answer body; throws LiveHttpException on an HTTP error. */
    suspend fun request(r: Req): String

    /** A Req as a full player URL (static stream). */
    fun url(r: Req): String

    /** A server-relative URL (TranscodingUrl) as a full one. */
    fun resolve(u: String): String
}

/** LiveApi over the app's Api (auth headers come from Core.http's interceptor). */
class ServerLiveApi(private val api: Api) : LiveApi {
    override val kind = if (api.server.isEmby) ServerKind.EMBY else ServerKind.JELLYFIN
    override val userId get() = api.userId
    override val deviceId get() = api.deviceId

    private fun pairs(r: Req) = r.query.map { (k, v) -> k to v }.toTypedArray()

    override suspend fun request(r: Req): String = try {
        api.raw(r.method, r.path, r.body?.toString(), *pairs(r))
    } catch (e: ApiException) {
        throw LiveHttpException(e.status, e.message ?: "HTTP ${e.status}")
    }

    override fun url(r: Req) = api.url(r.path, *pairs(r))
    override fun resolve(u: String) = api.resolve(u)
}

// ---- Answers ----

/** A MediaSource with the live fields the app's MediaSource does not carry. */
class LiveSource(val ms: MediaSource, val liveStreamId: String?, val requiresOpening: Boolean, val openToken: String?) {
    val hasVideo get() = ms.mediaStreams.any { it.type == "Video" }
}

class LiveInfo(val sources: List<LiveSource>, val playSessionId: String?, val errorCode: String?)

private fun JsonObject.text(key: String) = this[key].jsString()?.takeIf { it.isNotEmpty() }

fun parseLiveSource(o: JsonObject) = LiveSource(
    json.decodeFromJsonElement(MediaSource.serializer(), o),
    o.text("LiveStreamId"),
    (o["RequiresOpening"] as? JsonPrimitive)?.booleanOrNull == true,
    o.text("OpenToken"),
)

fun parseLiveInfo(body: String): LiveInfo {
    if (body.isBlank()) return LiveInfo(emptyList(), null, null)
    val o = json.parseToJsonElement(body).jsonObject
    val sources = (o["MediaSources"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.let(::parseLiveSource) }
    return LiveInfo(sources, o.text("PlaySessionId"), o.text("ErrorCode"))
}

/** The LiveStreams/Open answer: {MediaSource}. */
fun parseOpened(body: String): LiveSource? =
    if (body.isBlank()) null else (json.parseToJsonElement(body).jsonObject["MediaSource"] as? JsonObject)?.let(::parseLiveSource)

// ---- Tuner-busy classification (§8.2) ----

// Broad on purpose (its only effect is "release the old stream and retry once"), but a plain tuner
// error ("Error opening the tuner stream") is a failed rung, not a busy pool.
private val BUSY_TEXT = Regex(
    """\bno\b.*\b(available|free)\b|\b(available|free)\b.*\btuners?\b|\btuners?\b.*\b(busy|in use|unavailable|available|limit)|conflict|limit|maximum""",
    RegexOption.IGNORE_CASE,
)
private val BUSY_CODES = setOf("NoCompatibleStream", "RateLimitExceeded")

enum class AnswerClass { OK, BUSY, REFUSED, EMPTY }

/** A PlaybackInfo answer on a live channel. [otherAdopted]: another live stream of ours is open. */
fun classifyAnswer(info: LiveInfo, otherAdopted: Boolean): AnswerClass = when {
    info.errorCode != null -> if (info.errorCode in BUSY_CODES) AnswerClass.BUSY else AnswerClass.REFUSED
    info.sources.isEmpty() -> if (otherAdopted) AnswerClass.BUSY else AnswerClass.EMPTY
    else -> AnswerClass.OK
}

/** An HTTP error from PlaybackInfo or LiveStreams/Open. */
fun isBusyHttp(status: Int, text: String) = (status == 409 || status == 500 || status == 503) && BUSY_TEXT.containsMatchIn(text)

/** The stream URL answering 503 or 429 right after the load. */
fun isBusyStream(status: Int, msSinceLoad: Long) = msSinceLoad <= 3_000 && (status == 503 || status == 429)

// ---- Display mode for live (§21.5, DM-1), the twin of live-session.ts ----

/** Frames whose timestamps give a channel's cadence. */
const val CADENCE_FRAMES = 12

/** A measured cadence's family (24, 50 or 60) and the display rate it wants: 25i/50p → 50 Hz, 29.97i/59.94p → 59.94 Hz. */
class CadenceTarget(val family: Int, val hz: Float)

fun cadenceTarget(fps: Float?): CadenceTarget? {
    if (fps == null || !(fps >= 10f)) return null
    for ((base, family) in listOf(24 to 24, 25 to 50, 30 to 60)) {
        for (k in intArrayOf(1, 2, 4)) {
            val r = fps / (base * k)
            if (abs(r - 1) < 0.015f) return CadenceTarget(family, (family * r * 1000).roundToInt() / 1000f)
        }
    }
    return null
}

/**
 * Frames per second from the first decoded frames' presentation times (µs): the mean of the intervals near the
 * median, so a zap's gap does not count and 90 kHz jitter (1500/1504 ticks at 59.94) does not read as 60.
 */
fun cadenceOf(ptsUs: List<Long>): Float? {
    val d = ptsUs.zipWithNext { a, b -> b - a }.filter { it in 1..200_000 }.sorted()
    if (d.isEmpty()) return null
    val median = d[d.size / 2]
    return (1_000_000.0 / d.filter { abs(it - median) <= median / 4 }.average()).toFloat()
}

/** A mode switch blanks HDMI for 1–3 s: switch only when the family changes, never inside one. */
class CadenceGate {
    var family: Int? = null
        private set

    /** The display rate to switch to, or null to keep the mode. */
    fun next(fps: Float?): Float? {
        val c = cadenceTarget(fps) ?: return null
        if (c.family == family) return null
        family = c.family
        return c.hz
    }
}

// ---- What to play (§8.1 pick) ----

class LiveOpen(
    val serverId: String,
    val channelId: String,
    val rung: Int,
    val playSessionId: String,
    val source: LiveSource,
    /** Static URL (direct play, or a DirectStream-only tuner); null for a transcode. */
    val static: Req?,
    val transcodingUrl: String?,
    val playMethod: Dialect.PlayMethod,
    val isHls: Boolean,
) {
    val liveStreamId get() = source.liveStreamId
    val transcoding get() = static == null
}

private val CONTAINER = Regex("^[a-z0-9]{1,10}$")

fun pickPlay(ps: LiveSource, kind: ServerKind, serverId: String, channelId: String, rung: Int, deviceId: String, playSessionId: String, staticOk: Boolean): LiveOpen? {
    val ms = ps.ms
    val container = ms.container.orEmpty().split(',')[0].trim().lowercase()
    fun open(static: Req?, url: String?, method: Dialect.PlayMethod, hls: Boolean) =
        LiveOpen(serverId, channelId, rung, playSessionId, ps, static, url, method, hls)
    fun stat() = Dialect.staticStream(kind, channelId, if (CONTAINER.matches(container)) container else "ts", ms.id, ps.liveStreamId, deviceId, playSessionId)
    val tu = ms.transcodingUrl
    return when {
        rung == 0 && ms.supportsDirectPlay -> open(stat(), null, Dialect.PlayMethod.DirectPlay, false)
        tu != null -> open(
            null, tu,
            if (tu.contains("videocodec=copy", true)) Dialect.PlayMethod.DirectStream else Dialect.PlayMethod.Transcode,
            ms.transcodingSubProtocol.equals("hls", true) || tu.contains(".m3u8", true),
        )
        // DirectStream-only sources (HDHomeRun, tvheadend): the same static URL. This was noPlayMethod.
        staticOk && ms.supportsDirectStream -> open(stat(), null, Dialect.PlayMethod.DirectStream, false)
        staticOk && ms.supportsDirectPlay -> open(stat(), null, Dialect.PlayMethod.DirectPlay, false)
        else -> null
    }
}

// ---- Ledger ----

enum class Released { STOP, CLOSE }

class LedgerEntry(
    val id: String,
    val serverId: String,
    val channelId: String,
    val playSessionId: String,
    /** The LiveTuner that recorded it (0: a previous process); its stop() sweeps only its own. */
    val owner: Int = 0,
    var adopted: Boolean = false,
    var released: Released? = null,
    var transcoding: Boolean,
    val openedAt: Long,
    /** Why it was closed without being adopted: superseded, late, failed, busy, sweep. */
    var note: String? = null,
) {
    override fun toString() = "$id($channelId ${if (adopted) "adopted" else "-"} ${released ?: "open"}${note?.let { " $it" } ?: ""})"
}

data class LedgerSnapshot(
    val at: Long,
    val open: List<String>,
    val recent: List<String>,
    val counters: Map<String, Int>,
    val killEncodesOff: Set<String>,
    val policy: Map<String, ZapPolicy>,
)

/** Learned break-before-make per server (epoch ms until which it holds). */
interface ReleaseFirstStore {
    fun until(serverId: String): Long
    fun set(serverId: String, until: Long)
    fun clear()
}

/** The unreleased streams, one line each, kept so that the next process closes what a dead one left open. */
interface OpenStreamStore {
    fun load(): List<String>
    fun save(lines: List<String>)
}

class MemoryOpenStreams : OpenStreamStore {
    var lines: List<String> = emptyList()
    override fun load() = lines
    override fun save(lines: List<String>) { this.lines = lines }
}

class PrefsOpenStreams(private val sp: SharedPreferences) : OpenStreamStore {
    override fun load() = sp.getString("openStreams", null)?.split('\n')?.filter { it.isNotEmpty() }.orEmpty()
    override fun save(lines: List<String>) = sp.edit().putString("openStreams", lines.joinToString("\n")).apply()
}

class MemoryReleaseFirst : ReleaseFirstStore {
    private val map = HashMap<String, Long>()
    @Synchronized override fun until(serverId: String) = map[serverId] ?: 0L
    @Synchronized override fun set(serverId: String, until: Long) { map[serverId] = until }
    @Synchronized override fun clear() = map.clear()
}

class PrefsReleaseFirst(private val sp: SharedPreferences) : ReleaseFirstStore {
    override fun until(serverId: String) = sp.getLong("releaseFirst.$serverId", 0L)
    override fun set(serverId: String, until: Long) = sp.edit().putLong("releaseFirst.$serverId", until).apply()
    override fun clear() {
        val ed = sp.edit()
        sp.all.keys.filter { it.startsWith("releaseFirst.") }.forEach { ed.remove(it) }
        ed.apply()
    }
}

class TuneRequest(
    val api: LiveApi,
    val serverId: String,
    val channelId: String,
    val maxBitrate: Long,
    val deviceProfile: (Int) -> JsonElement?,
    val startRung: Int? = null,
    /** False for a player that cannot play a raw TS stream. */
    val staticOk: Boolean = true,
    /** A newer tune (or a stop) superseded this one. */
    val stale: () -> Boolean,
    /** The LiveTuner tuning (ledger ownership, for its sweep). */
    val owner: Int = 0,
)

interface TuneHooks {
    /** An adopted live stream of ours is still open (the channel being left). */
    fun hasCurrent(): Boolean

    /** Release it now (its Stopped report): break-before-make, or a busy tuner. */
    suspend fun releaseCurrent()

    /** Load the answer and return on its first frame; throw a LiveError otherwise. */
    suspend fun play(open: LiveOpen)

    fun notice(n: LiveNotice)
}

/**
 * One per process ([shared]): the ledger, the learned policy and the per-channel rung outlive a player
 * screen. [scope] outlives the screens too: closes, reports and late answers run in it.
 */
class LiveSession(
    private val scope: CoroutineScope,
    private val releaseFirst: ReleaseFirstStore = MemoryReleaseFirst(),
    val timing: LiveTiming = LiveTiming(),
    private val now: () -> Long = System::currentTimeMillis,
    private val devExport: ((LedgerSnapshot) -> Unit)? = null,
    private val openStore: OpenStreamStore = MemoryOpenStreams(),
) {
    private val lock = Any()
    private val ledger = LinkedHashMap<String, LedgerEntry>()
    private val apis = HashMap<String, LiveApi>()
    private val inflight = HashSet<Job>()
    private val killEncodesOff = HashSet<String>()
    // The rung that last played each channel (server/channel), for the session (§8.1).
    private val rungs = HashMap<String, Int>()
    // Left open by a dead process (serverId, id, playSessionId, transcoding): closed on the next tune to that server.
    private val orphans = openStore.load().mapNotNull { l -> l.split('\t').takeIf { it.size == 4 } }.toMutableList()
    private var saved: List<String>? = null
    private val counters = linkedMapOf(
        "tunes" to 0, "opened" to 0, "adopted" to 0, "stops" to 0, "closes" to 0, "closeErrors" to 0, "late" to 0,
        "superseded" to 0, "busy" to 0, "timeouts" to 0, "failedRungs" to 0, "killEncodes" to 0, "doubleReleaseAttempts" to 0, "orphans" to 0,
    )

    /** `live.release`; the settings screens set it. Picking Auto again forgets what was learned. */
    @Volatile
    var release: ReleaseMode = ReleaseMode.AUTO
        set(v) {
            if (v == ReleaseMode.AUTO && field != ReleaseMode.AUTO) releaseFirst.clear()
            field = v
        }

    private fun count(key: String) = synchronized(lock) { counters[key] = (counters[key] ?: 0) + 1 }

    // ---- Zap policy (§8.1): Auto learns break-before-make per server for 7 days ----

    fun policy(serverId: String): ZapPolicy = when (release) {
        ReleaseMode.ALWAYS -> ZapPolicy.BBM
        ReleaseMode.NEVER -> ZapPolicy.MBB
        ReleaseMode.AUTO -> if (releaseFirst.until(serverId) > now()) ZapPolicy.BBM else ZapPolicy.MBB
    }

    // True on the first learn (the caller shows the notice once).
    private fun learnBbm(serverId: String): Boolean {
        if (release != ReleaseMode.AUTO) return false
        val first = policy(serverId) == ZapPolicy.MBB
        releaseFirst.set(serverId, now() + POLICY_MEMORY_MS)
        return first
    }

    // ---- Tune: policy, negotiation, ladder (§8.1) ----

    /**
     * Returns the adopted stream, or null when superseded. Throws a LiveError once every rung failed;
     * the caller then restores the previous channel (make-before-break) or shows the error.
     */
    suspend fun tune(t: TuneRequest, hooks: TuneHooks): LiveOpen? {
        count("tunes")
        synchronized(lock) { apis[t.serverId] = t.api }
        closeOrphans(t.serverId)
        if (policy(t.serverId) == ZapPolicy.BBM && hooks.hasCurrent()) hooks.releaseCurrent()
        var rung = t.startRung ?: synchronized(lock) { rungs["${t.serverId}/${t.channelId}"] } ?: 0
        var retried = false
        // One release-and-retry per tune when the pool is full (§8.2).
        suspend fun busyRetry(): Boolean {
            if (retried || !hooks.hasCurrent() || release == ReleaseMode.NEVER) return false
            retried = true
            log("no free tuner on ${t.serverId}: releasing the current channel and retrying")
            if (learnBbm(t.serverId)) hooks.notice(LiveNotice.TUNER_RELEASED)
            hooks.releaseCurrent()
            return true
        }
        while (true) {
            if (t.stale()) return null
            val open = try {
                negotiate(t, rung, hooks.hasCurrent())
            } catch (e: LiveError) {
                if (e.kind == LiveFailure.SUPERSEDED || t.stale()) return null
                if (e.kind == LiveFailure.BUSY) {
                    if (busyRetry()) continue
                    throw e
                }
                // A tune that timed out is abandoned (its late answer is closed on arrival).
                if (e.kind == LiveFailure.TIMEOUT) throw e
                count("failedRungs")
                if (rung >= 2) throw e
                rung++
                continue
            }
            try {
                hooks.play(open)
            } catch (e: CancellationException) {
                closeUnadopted(open, "superseded")
                throw e
            } catch (e: Exception) {
                val le = e as? LiveError ?: LiveError(LiveFailure.PLAY, e.message)
                closeUnadopted(open, if (le.kind == LiveFailure.SUPERSEDED) "superseded" else "failed")?.join()
                if (le.kind == LiveFailure.SUPERSEDED || t.stale()) return null
                if (le.kind == LiveFailure.BUSY && busyRetry()) continue
                count("failedRungs")
                log("live rung $rung failed for ${t.channelId}: ${le.message}")
                if (rung >= 2) throw le
                rung++
                continue
            }
            if (t.stale()) {
                closeUnadopted(open, "superseded")
                return null
            }
            adopt(open)
            return open
        }
    }

    // Before the first tune to a server: its tuner may still hold them (one-tuner pools).
    private suspend fun closeOrphans(serverId: String) {
        val mine = synchronized(lock) { orphans.filter { it[0] == serverId }.also { orphans.removeAll(it) } }
        if (mine.isEmpty()) return
        val jobs = mine.mapNotNull { (srv, id, psid, tc) ->
            synchronized(lock) {
                if (ledger.containsKey(id)) return@mapNotNull null
                counters["orphans"] = (counters["orphans"] ?: 0) + 1
                ledger[id] = LedgerEntry(id, srv, "", psid, transcoding = tc == "1", openedAt = now())
            }
            log("live stream $id was left open by a previous process: closing it")
            closeId(id, "orphan")
        }
        jobs.joinAll()
    }

    // PlaybackInfo (AutoOpenLiveStream), then Open when the source requires it, then the URL pick.
    // Every LiveStreamId is recorded as soon as it arrives, before any suspension, so a cancelled
    // tune still leaves it to the sweep.
    private suspend fun negotiate(t: TuneRequest, rung: Int, otherAdopted: Boolean): LiveOpen {
        val api = t.api
        val userId = api.userId.orEmpty()
        val profile = t.deviceProfile(rung)
        val pbi = Dialect.tune(api.kind, userId, t.channelId, t.maxBitrate, rung, profile)
        val info = answer(api, pbi, ::parseLiveInfo) { late -> closeAnswer(t, late.sources, late.playSessionId, "late") }
        val psid = info.playSessionId.orEmpty()
        for (s in info.sources) record(t, s, psid)
        if (t.stale()) {
            closeAnswer(t, info.sources, psid, "superseded")
            throw LiveError(LiveFailure.SUPERSEDED)
        }
        val cls = classifyAnswer(info, otherAdopted)
        if (cls != AnswerClass.OK) {
            closeAnswer(t, info.sources, psid, if (cls == AnswerClass.BUSY) "busy" else "failed")
            if (cls == AnswerClass.BUSY) {
                count("busy")
                throw LiveError(LiveFailure.BUSY, info.errorCode)
            }
            throw LiveError(if (cls == AnswerClass.EMPTY) LiveFailure.NO_STREAM else LiveFailure.FAILED, info.errorCode)
        }
        var ps = info.sources[0]
        // Only the first source is played; any other one the server opened is closed now.
        closeAnswer(t, info.sources.drop(1), psid, "failed")
        if (ps.requiresOpening && ps.liveStreamId == null) {
            val o = Dialect.open(api.kind, userId, t.channelId, psid, t.maxBitrate, ps.openToken.orEmpty(), profile)
            val opened = answer(api, o, ::parseOpened) { late -> if (late != null) closeAnswer(t, listOf(late), psid, "late") }
            opened?.let { record(t, it, psid) }
            if (t.stale()) {
                if (opened != null) closeAnswer(t, listOf(opened), psid, "superseded")
                throw LiveError(LiveFailure.SUPERSEDED)
            }
            if (opened == null) {
                if (otherAdopted) {
                    count("busy")
                    throw LiveError(LiveFailure.BUSY)
                }
                throw LiveError(LiveFailure.FAILED)
            }
            ps = opened
        }
        val open = pickPlay(ps, api.kind, t.serverId, t.channelId, rung, api.deviceId, psid, t.staticOk)
        if (open == null) {
            closeAnswer(t, listOf(ps), psid, "failed")
            throw LiveError(LiveFailure.NO_STREAM)
        }
        // The transcode flag decides killEncodes for an abandoned stream.
        ps.liveStreamId?.let { id -> synchronized(lock) { ledger[id]?.transcoding = open.transcoding } }
        return open
    }

    /**
     * A request with the tune deadline. After it (or when the tune is cancelled) the tune is
     * abandoned, but the request keeps going in [scope] so that a late answer can still be closed.
     */
    private suspend fun <T> answer(api: LiveApi, r: Req, parse: (String) -> T, onLate: suspend (T) -> Unit): T {
        val result = CompletableDeferred<T>()
        track(
            scope.launch {
                val v = try {
                    parse(api.request(r))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    result.completeExceptionally(asLiveError(e))
                    return@launch
                }
                if (!result.complete(v)) {
                    count("late")
                    log("late ${r.path} answer: closing it")
                    onLate(v)
                }
            },
        )
        try {
            return withTimeout(timing.tuneTimeoutMs) { result.await() }
        } catch (e: TimeoutCancellationException) {
            if (result.completeExceptionally(LiveError(LiveFailure.TIMEOUT))) {
                count("timeouts")
                throw LiveError(LiveFailure.TIMEOUT)
            }
            return result.await() // it arrived at the deadline
        } catch (e: CancellationException) {
            // The tune was cancelled (screen closed): an answer that already arrived is closed now.
            if (!result.completeExceptionally(e)) scope.launch { runCatching { onLate(result.await()) } }
            throw e
        }
    }

    private fun asLiveError(e: Throwable): LiveError = when {
        e is LiveError -> e
        e is LiveHttpException && isBusyHttp(e.status, e.message.orEmpty()) -> LiveError(LiveFailure.BUSY, e.message).also { count("busy") }
        else -> LiveError(LiveFailure.FAILED, e.message)
    }

    private fun track(job: Job) {
        synchronized(lock) { inflight.add(job) }
        job.invokeOnCompletion { synchronized(lock) { inflight.remove(job) } }
    }

    private fun record(t: TuneRequest, ps: LiveSource, playSessionId: String) {
        val id = ps.liveStreamId ?: return
        synchronized(lock) {
            if (ledger.containsKey(id)) return
            counters["opened"] = (counters["opened"] ?: 0) + 1
            ledger[id] = LedgerEntry(id, t.serverId, t.channelId, playSessionId, t.owner, transcoding = ps.ms.transcodingUrl != null, openedAt = now())
        }
        changed()
    }

    // Every stream in an answer that will not be played.
    private suspend fun closeAnswer(t: TuneRequest, sources: List<LiveSource>, playSessionId: String?, note: String) {
        val jobs = sources.mapNotNull { ps ->
            record(t, ps, playSessionId.orEmpty())
            ps.liveStreamId?.let { closeId(it, note) }
        }
        jobs.joinAll()
    }

    private fun adopt(o: LiveOpen) {
        synchronized(lock) {
            counters["adopted"] = (counters["adopted"] ?: 0) + 1
            rungs["${o.serverId}/${o.channelId}"] = o.rung
            o.liveStreamId?.let { ledger[it]?.adopted = true }
        }
        changed()
    }

    // ---- Release ----

    /**
     * Before a Stopped report: true when this report releases the stream (adopted, not yet released),
     * and the ledger then counts it as released by 'stop'. False: send no Stopped report.
     */
    fun stopping(liveStreamId: String?, adopted: Boolean): Boolean {
        if (liveStreamId == null) return adopted
        synchronized(lock) {
            val e = ledger[liveStreamId]
            if (e == null || !e.adopted) return false
            if (e.released != null) {
                counters["doubleReleaseAttempts"] = (counters["doubleReleaseAttempts"] ?: 0) + 1
                return false
            }
            e.released = Released.STOP
            counters["stops"] = (counters["stops"] ?: 0) + 1
        }
        changed()
        return true
    }

    /** The Stopped report of an adopted stream, through the ledger; then killEncodes for a transcode. Null: nothing sent. */
    fun stop(api: LiveApi, open: LiveOpen, report: Req): Job? {
        if (!stopping(open.liveStreamId, true)) return null
        return scope.launch {
            runCatching { api.request(report) }.onFailure { logWarn("Stopped report for ${open.liveStreamId} failed", it) }
            if (open.transcoding) killEncodes(open.serverId, open.playSessionId)
        }.also(::track)
    }

    /** A report that releases nothing (Playing). */
    fun send(api: LiveApi, r: Req): Job = scope.launch { runCatching { api.request(r) } }.also(::track)

    /** A stream that was never adopted (or one whose Stopped report is no longer possible). */
    fun closeUnadopted(o: LiveOpen, note: String = "failed"): Job? = o.liveStreamId?.let { closeId(it, note) }

    private fun closeId(id: String, note: String): Job? {
        val e = synchronized(lock) {
            val e = ledger[id] ?: return null
            if (e.released != null) {
                if (e.released == Released.STOP && e.adopted) counters["doubleReleaseAttempts"] = (counters["doubleReleaseAttempts"] ?: 0) + 1
                return null
            }
            e.released = Released.CLOSE
            e.note = note
            if (note == "superseded") counters["superseded"] = (counters["superseded"] ?: 0) + 1
            e
        }
        changed()
        return scope.launch { sendClose(e) }.also(::track)
    }

    // Query string only (a body gives 400); 404 means it is gone already; other errors: one retry after 2 s.
    private suspend fun sendClose(e: LedgerEntry) {
        val api = synchronized(lock) { apis[e.serverId] }
        if (api == null) {
            logWarn("live stream ${e.id}: no client for ${e.serverId}, cannot close it", null)
            return
        }
        val r = Dialect.close(api.kind, e.id, e.playSessionId)
        for (attempt in 0 until 2) {
            try {
                api.request(r)
                count("closes")
                break
            } catch (err: CancellationException) {
                throw err
            } catch (err: Exception) {
                if ((err as? LiveHttpException)?.status == 404) break
                count("closeErrors")
                logWarn("LiveStreams/Close ${e.id} failed (attempt ${attempt + 1})", err)
                if (attempt == 0) delay(timing.closeRetryMs)
            }
        }
        if (e.transcoding) killEncodes(e.serverId, e.playSessionId)
        changed()
    }

    /**
     * Best effort, and off for a server after one 404/405 (Jellyfin 12.2 dropped the route; its Close
     * and Stopped already end the transcode).
     */
    suspend fun killEncodes(serverId: String, playSessionId: String) {
        if (playSessionId.isEmpty()) return
        val api = synchronized(lock) { if (serverId in killEncodesOff) null else apis[serverId] } ?: return
        try {
            api.request(Dialect.killEncodes(api.kind, api.deviceId, playSessionId))
            count("killEncodes")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val status = (e as? LiveHttpException)?.status
            if (status == 404 || status == 405) {
                synchronized(lock) { killEncodesOff.add(serverId) }
                log("DELETE /Videos/ActiveEncodings answered $status on $serverId: not called again this session")
            }
        }
    }

    /**
     * Player gone (stop, crash, background): close every stream of [owner] (null: every one) not yet
     * released, then wait (bounded) for the requests still in flight, whose answers close themselves
     * on arrival. Another tuner's streams are left alone: a new screen may already be tuning.
     */
    suspend fun sweep(owner: Int? = null, deadlineMs: Long = timing.sweepMs) {
        val open = synchronized(lock) { ledger.values.filter { it.released == null && (owner == null || it.owner == owner) }.map { it.id } }
        for (id in open) closeId(id, "sweep")
        withTimeoutOrNull(deadlineMs) {
            while (true) {
                val jobs = synchronized(lock) { inflight.toList() }
                if (jobs.isEmpty()) break
                jobs.joinAll()
            }
        }
        export()
    }

    fun isOpen(liveStreamId: String?): Boolean = synchronized(lock) { ledger[liveStreamId]?.let { it.released == null } == true }

    /** [sweep] once [after] (the Stopped report of the screen that went) is done, in the session scope. */
    fun sweepAfter(after: Job?, owner: Int? = null): Job = scope.launch {
        after?.join()
        sweep(owner)
    }

    fun snapshot(): LedgerSnapshot = synchronized(lock) {
        val all = ledger.values.toList()
        LedgerSnapshot(
            at = now(),
            open = all.filter { it.released == null }.map { it.toString() },
            recent = all.filter { it.released != null }.takeLast(20).map { it.toString() },
            counters = counters + ("inflight" to inflight.size),
            killEncodesOff = killEncodesOff.toSet(),
            policy = all.map { it.serverId }.toSet().associateWith { policy(it) },
        )
    }

    private fun changed() {
        // Released entries are kept a while (double-release protection, dev export), then pruned.
        synchronized(lock) {
            if (ledger.size > 300) {
                val it = ledger.values.iterator()
                while (ledger.size > 200 && it.hasNext()) if (it.next().released != null) it.remove()
            }
        }
        persist()
        export()
    }

    private fun persist() {
        val lines = synchronized(lock) {
            val l = ledger.values.filter { it.released == null }.map { "${it.serverId}\t${it.id}\t${it.playSessionId}\t${if (it.transcoding) 1 else 0}" } +
                orphans.map { it.joinToString("\t") }
            if (l == saved) return
            saved = l
            l
        }
        runCatching { openStore.save(lines) }
    }

    private fun export() {
        val f = devExport ?: return
        runCatching { f(snapshot()) }
    }

    private fun log(msg: String) {
        if (BuildConfig.DEBUG) runCatching { Log.i("WicabyLive", msg) }
    }

    private fun logWarn(msg: String, e: Throwable?) {
        runCatching { Log.w("WicabyLive", msg, e) }
    }

    companion object {
        /** The process-wide session: Core.scope, the learned policy in SharedPreferences, the ledger in the debug log. */
        val shared: LiveSession by lazy {
            val sp = Core.app.getSharedPreferences("wicaby_livetv", Context.MODE_PRIVATE)
            LiveSession(
                Core.scope,
                PrefsReleaseFirst(sp),
                devExport = if (BuildConfig.DEBUG) { s -> Log.d("WicabyLive", "ledger $s") } else null,
                openStore = PrefsOpenStreams(sp),
            )
        }
    }
}

// ---- The player side ----

/** The player as LiveTuner sees it (ExoLivePort in C/player/LiveLoadControl.kt; a fake in the tests). */
interface LivePort {
    /** Events go to [t] (null detaches). */
    fun attach(t: LiveTuner?)

    /** Replace the current media and play it; the same player instance across zaps. */
    fun load(url: String, hls: Boolean, title: String)

    fun stop()
    val playWhenReady: Boolean
    val buffering: Boolean
}

private val owners = AtomicInteger()

/**
 * The stream on the next channel that matches a pick (LT-22): the same language, the same codec first
 * (an in-band CEA-608/708 caption over a DVB one); a pick without a language matches by codec only,
 * as in-band captions often carry none.
 */
fun carryOver(streams: List<MediaStream>, pick: MediaStream): MediaStream? {
    fun lang(s: MediaStream) = s.language?.takeUnless { it.isBlank() || it.equals("und", true) }?.lowercase()
    val same = streams.filter { it.type == pick.type && !it.isExternal && lang(it) == lang(pick) }
    return same.firstOrNull { it.codec.equals(pick.codec, true) } ?: same.firstOrNull().takeIf { lang(pick) != null }
}

/** What LiveTuner needs from Playback. */
interface LiveHost {
    /** The answer being loaded: its streams, and the track picks (subtitle -1 = off). */
    fun loading(open: LiveOpen, audio: Int?, subtitle: Int?)

    /** The progress reports now go to this stream (null: none, it was released). */
    fun reporting(open: LiveOpen?, channel: ZapEntry)

    /** [cause]: the tune's error, if any (TP-11 tells a refusal of the parental hours from it). */
    fun failed(message: String, cause: Throwable? = null)
    fun state(s: LiveState?)

    // The current picks, carried over to the next channel (LT-22).
    val streams: List<MediaStream>
    val audioIndex: Int?
    val subtitleIndex: Int?
}

/**
 * One player screen's live channel: tunes through [session], loads the answers into [port], adopts
 * on the first frame, releases the channel being left, watches stalls (8 s → next rung, at most two
 * steps per tune) and pauses (30 s → released, play re-tunes). Main thread only, like the player.
 */
class LiveTuner(
    private val session: LiveSession,
    private val api: LiveApi,
    private val serverId: String,
    private val port: LivePort,
    private val host: LiveHost,
    private val scope: CoroutineScope,
    // X-02: the player's Quality sheet sets it, then re-tunes.
    var maxBitrate: Long,
    private val deviceProfile: (Int) -> JsonElement?,
    private val str: (Int, String?) -> String = { id, arg -> if (arg == null) Core.str(id) else Core.str(id, arg) },
    private val now: () -> Long = System::currentTimeMillis,
) {
    private class Cur(val open: LiveOpen, val channel: ZapEntry, val steps: Int)

    private val owner = owners.incrementAndGet()

    private val timing = session.timing
    // Adopted and not yet released.
    private var current: Cur? = null
    private var seq = 0
    private var tuning = 0
    private var wait: CompletableDeferred<Unit>? = null
    private var loadedAt = 0L
    private var target: ZapEntry? = null
    private var lastChannelId: String? = null
    private var pausedReleased = false
    private var stall: Job? = null
    private var pauseJob: Job? = null
    private var state: LiveState? = null
    // Track memory for the session (LT-22): the streams picked, or subtitles off.
    private var audioPick: MediaStream? = null
    private var subtitlePick: MediaStream? = null
    private var subtitleOff = false

    init {
        port.attach(this)
    }

    val adopted: LiveOpen? get() = current?.open

    /** Tune [channel]; a newer tune or stop() supersedes it. */
    fun tune(channel: ZapEntry, startRung: Int? = null, steps: Int = 0): Job = scope.launch { run(channel, startRung, steps) }

    private suspend fun run(ch: ZapEntry, startRung: Int?, steps: Int) {
        val my = ++seq
        wait?.completeExceptionally(LiveError(LiveFailure.SUPERSEDED))
        clearTimers()
        pausedReleased = false
        val leaving = current?.channel
        current?.let { remember() }
        target = ch
        publish { (it ?: LiveState(ch, serverId)).copy(pending = ch, tuning = true, pausedReleased = false, policy = session.policy(serverId)) }
        val hooks = object : TuneHooks {
            override fun hasCurrent() = current != null
            override suspend fun releaseCurrent() {
                releaseNow()?.join()
            }
            override suspend fun play(open: LiveOpen) = load(my, ch, open)
            override fun notice(n: LiveNotice) = this@LiveTuner.notice(n, null)
        }
        tuning++
        val open = try {
            session.tune(TuneRequest(api, serverId, ch.id, maxBitrate, deviceProfile, startRung, stale = { my != seq }, owner = owner), hooks)
        } catch (e: LiveError) {
            if (my != seq) return
            if (BuildConfig.DEBUG) runCatching { Log.w("WicabyLive", "tune ${ch.name} failed: ${e.kind} ${e.message}") }
            val cur = current
            if (cur != null) {
                // Make-before-break: back to the channel that is still open.
                startLoad(cur.open, cur.channel)
                publish { it?.copy(channel = cur.channel, pending = null, tuning = false) }
                notice(LiveNotice.ZAP_FAILED, ch.name)
            } else {
                // Break-before-make released the channel being left: "Chaîne précédente" goes back to it.
                if (leaving != null && leaving.id != ch.id) lastChannelId = leaving.id
                port.stop()
                publish { it?.copy(pending = null, tuning = false, lastChannelId = lastChannelId) }
                host.failed(str(errorText(e.kind), null), e)
            }
            return
        } finally {
            tuning--
        }
        if (open == null || my != seq) return
        val prev = current
        current = Cur(open, ch, steps)
        host.reporting(open, ch)
        session.send(api, Dialect.reportPlaying(api.kind, ch.id, open.source.ms.id, open.playSessionId, open.liveStreamId, open.playMethod, !port.playWhenReady))
        if (prev != null) {
            release(prev)
            if (prev.channel.id != ch.id) lastChannelId = prev.channel.id
        }
        publish {
            (it ?: LiveState(ch, serverId)).copy(
                channel = ch, serverId = serverId, pending = null, tuning = false, lastChannelId = lastChannelId,
                policy = session.policy(serverId), radio = !open.source.hasVideo,
            )
        }
        onStateChanged()
    }

    private fun errorText(kind: LiveFailure) = when (kind) {
        LiveFailure.BUSY -> R.string.errors_livetv_tuner_busy
        LiveFailure.TIMEOUT -> R.string.errors_livetv_tune_timeout
        else -> R.string.errors_livetv_no_stream
    }

    private suspend fun load(my: Int, ch: ZapEntry, open: LiveOpen) {
        if (my != seq) throw LiveError(LiveFailure.SUPERSEDED)
        val w = CompletableDeferred<Unit>()
        wait?.completeExceptionally(LiveError(LiveFailure.SUPERSEDED))
        wait = w
        try {
            startLoad(open, ch)
            withTimeoutOrNull(timing.firstFrameMs) { w.await() } ?: throw LiveError(LiveFailure.PLAY, "no first frame")
        } finally {
            if (wait === w) wait = null
        }
    }

    private fun startLoad(open: LiveOpen, ch: ZapEntry) {
        val streams = open.source.ms.mediaStreams
        val audio = audioPick?.let { carryOver(streams, it) }?.index ?: open.source.ms.defaultAudioStreamIndex
        val subtitle = if (subtitleOff) -1 else subtitlePick?.let { carryOver(streams, it) }?.index ?: open.source.ms.defaultSubtitleStreamIndex
        host.loading(open, audio, subtitle)
        loadedAt = now()
        port.load(open.static?.let { api.url(it) } ?: api.resolve(open.transcodingUrl.orEmpty()), open.isHls, ch.name)
    }

    private fun remember() {
        val streams = host.streams
        streams.firstOrNull { it.type == "Audio" && it.index == host.audioIndex }?.let { audioPick = it }
        val si = host.subtitleIndex
        subtitleOff = si == null || si < 0
        if (!subtitleOff) streams.firstOrNull { it.type == "Subtitle" && it.index == si }?.let { subtitlePick = it }
    }

    // ---- Port events ----

    fun onFirstFrame() {
        wait?.complete(Unit)
    }

    /** [httpStatus]: the stream URL's answer when the error carries one, else 0. */
    fun onError(message: String, httpStatus: Int) {
        val w = wait
        if (w != null) {
            w.completeExceptionally(LiveError(if (isBusyStream(httpStatus, now() - loadedAt)) LiveFailure.BUSY else LiveFailure.PLAY, message))
        } else if (current != null) {
            scope.launch { recover(message) }
        }
    }

    fun onEnded() {
        val w = wait
        if (w != null) w.completeExceptionally(LiveError(LiveFailure.PLAY, "ended")) else if (current != null) scope.launch { recover("eof") }
    }

    /** Play/pause or buffering changed. */
    fun onStateChanged() {
        val playing = port.playWhenReady
        if (pausedReleased) {
            // "Reprendre le direct": the paused stream was released, play tunes the channel again.
            if (playing) target?.let {
                pausedReleased = false
                tune(it)
            }
            return
        }
        if (current == null || wait != null || tuning > 0) {
            clearTimers()
            return
        }
        val stalled = port.buffering && playing
        if (stalled && stall == null) {
            stall = scope.launch {
                delay(timing.stallMs)
                stall = null
                recover("stall")
            }
        } else if (!stalled) {
            stall?.cancel()
            stall = null
        }
        if (!playing && pauseJob == null) {
            pauseJob = scope.launch {
                delay(timing.pauseReleaseMs)
                pauseJob = null
                releasePaused()
            }
        } else if (playing) {
            pauseJob?.cancel()
            pauseJob = null
        }
    }

    private fun releasePaused() {
        if (current == null || port.playWhenReady || tuning > 0) return
        clearTimers()
        releaseNow()
        port.stop()
        pausedReleased = true
        publish { it?.copy(pausedReleased = true) }
        notice(LiveNotice.PAUSED_RELEASED, null)
    }

    // Stall, player error or end of an adopted stream: release it and tune the channel again a rung
    // lower, at most two steps per tune.
    private fun recover(reason: String) {
        val c = current ?: return
        if (tuning > 0) return
        clearTimers()
        val steps = c.steps + 1
        if (BuildConfig.DEBUG) runCatching { Log.w("WicabyLive", "live stream lost ($reason) on ${c.channel.name}, recovery step $steps") }
        releaseNow()
        if (steps > 2) {
            port.stop()
            host.failed(str(R.string.errors_livetv_no_stream, null))
            return
        }
        notice(LiveNotice.RECOVERING, null)
        tune(c.channel, startRung = minOf(2, c.open.rung + 1), steps = steps)
    }

    // ---- Release ----

    private fun releaseNow(): Job? {
        val c = current ?: return null
        current = null
        host.reporting(null, c.channel)
        return release(c)
    }

    private fun release(c: Cur): Job? = session.stop(
        api, c.open,
        Dialect.reportStopped(api.kind, c.channel.id, c.open.source.ms.id, c.open.playSessionId, c.open.liveStreamId, c.open.playMethod, !port.playWhenReady),
    )

    /** The screen goes: the tuned stream is released, pending tunes are dropped and the ledger swept. */
    fun stop() {
        seq++
        wait?.completeExceptionally(LiveError(LiveFailure.SUPERSEDED))
        clearTimers()
        port.attach(null)
        val job = releaseNow()
        pausedReleased = false
        publish { null }
        // Not in the screen's scope: it is going away. The Stopped report goes first.
        session.sweepAfter(job, owner)
    }

    private fun clearTimers() {
        stall?.cancel()
        pauseJob?.cancel()
        stall = null
        pauseJob = null
    }

    private fun notice(n: LiveNotice, arg: String?) {
        val id = when (n) {
            LiveNotice.TUNER_RELEASED -> R.string.player_live_tuner_released
            LiveNotice.ZAP_FAILED -> R.string.player_live_zap_failed
            LiveNotice.RECOVERING -> R.string.player_live_recovering
            LiveNotice.PAUSED_RELEASED -> R.string.player_live_paused_released
        }
        val text = str(id, arg)
        publish { it?.copy(notice = text, noticeAt = now()) }
    }

    private inline fun publish(f: (LiveState?) -> LiveState?) {
        state = f(state)
        host.state(state)
    }
}
