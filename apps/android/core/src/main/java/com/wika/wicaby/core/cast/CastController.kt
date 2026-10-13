package com.wika.wicaby.core.cast

import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ItemsResult
import com.wika.wicaby.core.data.PlayState
import com.wika.wicaby.core.data.PlaybackInfo
import com.wika.wicaby.core.data.SessionInfo
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.net.LocalNetwork
import com.wika.wicaby.core.net.origin
import com.wika.wicaby.core.player.SessionReporter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.atomic.AtomicInteger

// The server cannot be reached on the LAN (mesh, internet, https): the renderer could not fetch the stream (§2.6.4).
class LanOnlyException : IOException("the server is not on the local network")

// A direct cast (cast spec CA-08, the Kotlin port of CA-07 without the relay; CA-10 for a Google Cast Default Media
// Receiver): one item on [device], which fetches the server's stream itself with the token in the URL (§2.6.3), while
// this device reports progress as its own session (§2.5). One controller per cast; the mobile Casting object holds the
// live one, PlaybackService keeps it in a foreground service.
class CastController(
    private val api: Api,
    val device: CastDevice,
    private val scope: CoroutineScope = Core.scope,
    // The server origin the renderer must fetch (an IP literal on the LAN), or null when there is none.
    private val lanBase: suspend () -> HttpUrl? = { lanBase(api) },
    private val fastPollMs: Long = 1_000,
    private val slowPollMs: Long = 5_000,
    private val reportMs: Long = 10_000,
    private val pingMs: Long = 30_000,
    private val startWaitMs: Long = 5_000,
    // Ends this device's local playback once the renderer plays, before the cast's Playing report: both report as
    // this DeviceId and must never overlap (§8.4). SessionReporter keeps the order.
    private val beforePlaying: suspend () -> Unit = {},
    // CA-11: a disposable Jellyfin token for the renderer's URLs instead of the user's (null: always the user's).
    private val tokens: EphemeralTokens? = EphemeralTokens.shared,
) : CastRemote {
    data class Cast(
        val item: Item,
        val url: String,
        val playSessionId: String?,
        val msid: String?,
        val audio: Int?,
        val sub: Int?,
        val method: String,
        // A transcode starts at startTicks and the renderer counts from there (§2.5).
        val startTicks: Long,
        val positionTicks: Long,
        val paused: Boolean = false,
        val volume: Int? = null,
        val muted: Boolean = false,
    ) {
        val transcoding get() = method != "DirectPlay"
    }

    enum class End { Finished, Lost, Stopped }

    private val _state = MutableStateFlow<Cast?>(null)
    val state: StateFlow<Cast?> = _state
    // Why the cast ended, once it has.
    private val _ended = MutableStateFlow<End?>(null)
    val ended: StateFlow<End?> = _ended
    // The end's Stopped report, completed once the server answered it (set before [ended]).
    @Volatile var stopReport: Deferred<Boolean>? = null
        private set

    private val reporter = SessionReporter(api)
    private val watchers = AtomicInteger()
    private var loop: Job? = null
    // The cast's disposable token, minted once on the first start; revoked when the cast ends (CA-11 rule 6).
    @Volatile private var disposable: Disposable? = null
    private var minted = false

    override suspend fun play(target: CastTarget, ids: List<String>, startIndex: Int, positionTicks: Long?, msid: String?, audio: Int?, sub: Int?, command: String) {
        // One item: no queue on a direct renderer (§1).
        val id = ids.getOrNull(startIndex) ?: ids.first()
        try {
            start(api.item(id), positionTicks ?: 0, msid, audio, sub)
        } catch (e: Exception) {
            release()
            throw e
        }
    }

    // The token the renderer's URLs carry: the disposable one when Jellyfin can make one, else the user's (§2.6.3).
    private suspend fun urlToken(): String? {
        if (!minted) {
            minted = true
            disposable = tokens?.mint(api, device.name, EphemeralTokens.SENDER)
        }
        return disposable?.token ?: api.token
    }

    private fun release() {
        val d = disposable ?: return
        disposable = null
        scope.launch { tokens?.revoke(d, api) }
    }

    private suspend fun start(item: Item, ticks: Long, msid: String?, audio: Int?, sub: Int?) {
        val base = lanBase() ?: throw LanOnlyException()
        val token = urlToken()
        val isAudio = item.mediaType.equals("Audio", true)
        val profile = device.profile()
        val body = buildJsonObject {
            put("DeviceProfile", profile)
            put("UserId", api.userId)
            put("MaxStreamingBitrate", device.bitrate)
            put("StartTimeTicks", ticks)
            put("IsPlayback", true)
            put("AutoOpenLiveStream", true)
            msid?.let { put("MediaSourceId", it) }
            audio?.let { put("AudioStreamIndex", it) }
            sub?.let { put("SubtitleStreamIndex", it) }
            put("EnableDirectPlay", true)
            put("EnableDirectStream", true)
            put("EnableTranscoding", true)
        }
        val info: PlaybackInfo = api.post(
            "/Items/${item.id}/PlaybackInfo", body.toString(),
            "UserId" to api.userId, "StartTimeTicks" to ticks, "IsPlayback" to true, "AutoOpenLiveStream" to true,
            "MaxStreamingBitrate" to device.bitrate, "AudioStreamIndex" to audio, "SubtitleStreamIndex" to sub, "MediaSourceId" to msid,
        )
        if (info.errorCode != null) throw IOException("PlaybackInfo: ${info.errorCode}")
        val ps = info.mediaSources.firstOrNull { it.id == msid } ?: info.mediaSources.firstOrNull() ?: throw IOException("no media source")
        val direct = ps.supportsDirectPlay || ps.transcodingUrl == null
        val container = device.container(direct, ps.container.orEmpty().split(',').map { it.trim().lowercase() }.filter(String::isNotEmpty), isAudio)
        val url = if (direct) {
            lan(base, token, api.url(
                "/${if (isAudio) "Audio" else "Videos"}/${item.id}/stream.$container", "Static" to true, "MediaSourceId" to ps.id,
                "PlaySessionId" to info.playSessionId, "DeviceId" to api.deviceId,
            ))
        } else {
            lan(base, token, api.resolve(ps.transcodingUrl)).let { u ->
                val h = u.toHttpUrl()
                if (ticks > 0 && h.queryParameterNames.none { it.equals("StartTimeTicks", true) }) h.newBuilder().addQueryParameter("StartTimeTicks", ticks.toString()).build().toString() else u
            }
        }
        // The server converted these to the device's External format (srt for DLNA, vtt for Cast).
        val subs = ps.mediaStreams.filter { it.type == "Subtitle" && it.deliveryMethod == "External" }
            .mapNotNull { s -> s.deliveryUrl?.let { CastSubtitle(s.index, lan(base, token, api.resolve(it)), s.language, s.displayTitle ?: s.title) } }
        val durationMs = (ps.runTimeTicks ?: item.runTimeTicks)?.div(TICKS_PER_MS)
        device.load(CastStream(item, url, container, direct, durationMs, subs, sub ?: ps.defaultSubtitleStreamIndex))
        // §2.4 success: Play answered and the renderer reports PLAYING or TRANSITIONING.
        val t0 = System.currentTimeMillis()
        var st: String
        while (true) {
            st = runCatching { device.state() }.getOrDefault("")
            if (st == "PLAYING" || st == "TRANSITIONING") break
            if (System.currentTimeMillis() - t0 >= startWaitMs) throw IOException("${device.name} did not start ($st)")
            delay(250)
        }
        // A static stream starts at 0 on the renderer: seek it to the handoff position.
        if (direct && ticks > 0) runCatching { device.seek(ticks / TICKS_PER_MS) }
        val vol = runCatching { device.volume() }.getOrNull()
        val c = Cast(
            item, url, info.playSessionId, ps.id, audio ?: ps.defaultAudioStreamIndex, sub ?: ps.defaultSubtitleStreamIndex,
            if (direct) "DirectPlay" else "Transcode", if (direct) 0 else ticks, ticks, volume = vol?.first, muted = vol?.second == true,
        )
        beforePlaying()
        _ended.value = null
        _state.value = c
        reporter.report("/Sessions/Playing", body(c, null))
        loop?.cancel()
        loop = run(seenPlaying = st == "PLAYING")
    }

    // [u] (an absolute server URL) on the LAN origin, its token parameters replaced by the one this server reads:
    // Jellyfin ApiKey (12.x ignores api_key), Emby api_key.
    private fun lan(base: HttpUrl, token: String?, u: String): String {
        val b = u.toHttpUrl().newBuilder().scheme(base.scheme).host(base.host).port(base.port)
        listOf("api_key", "ApiKey", "apikey", "X-Emby-Token").forEach { b.removeAllQueryParameters(it) }
        token?.let { b.addQueryParameter(if (api.server.isEmby) "api_key" else "ApiKey", it) }
        return b.build().toString()
    }

    private fun body(c: Cast, event: String?) = reporter.body(
        SessionReporter.State(
            c.item.id, c.msid, c.playSessionId, c.positionTicks, c.paused, c.muted, c.volume, c.method, canSeek = true,
            audio = c.audio, subtitle = c.sub ?: -1, queueable = false,
        ),
        event,
    )

    private fun report(event: String) = _state.value?.let { reporter.report("/Sessions/Playing/Progress", body(it, event)) }

    // §2.5: state + position (DLNA GetTransportInfo + GetPositionInfo) every second while someone watches (the remote panel), else every 5 s.
    // Progress every 10 s and on pause/unpause, Ping every 30 s while transcoding; STOPPED after PLAYING, or another
    // TrackURI, ends it; three failed polls in a row lose it.
    private fun run(seenPlaying: Boolean): Job = scope.launch {
        var reportAt = now()
        var pingAt = now()
        var fails = 0
        var seenPlaying = seenPlaying
        while (isActive) {
            delay(if (watchers.get() > 0) fastPollMs else slowPollMs)
            val cur = _state.value ?: break
            try {
                val st = device.state()
                val (rel, uri) = device.position()
                fails = 0
                if (st == "PLAYING") seenPlaying = true
                if ((seenPlaying && (st == "STOPPED" || st == "NO_MEDIA_PRESENT")) || (uri.isNotEmpty() && uri != cur.url)) {
                    finish(End.Finished)
                    break
                }
                val paused = st == "PAUSED_PLAYBACK"
                _state.update { c -> c?.copy(positionTicks = rel?.let { c.startTicks + it * TICKS_PER_MS } ?: c.positionTicks, paused = paused) }
                if (paused != cur.paused) {
                    report(if (paused) "Pause" else "Unpause")
                    reportAt = now()
                } else if (now() - reportAt >= reportMs) {
                    report("TimeUpdate")
                    reportAt = now()
                }
                if (cur.transcoding && now() - pingAt >= pingMs) {
                    cur.playSessionId?.let(reporter::ping)
                    pingAt = now()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                if (++fails >= 3) {
                    finish(End.Lost)
                    break
                }
            }
        }
    }

    // Stopped with the last known position, once (the poll loop and stop() may race); false when already ended.
    private fun finish(end: End): Boolean {
        val c = _state.getAndUpdate { null } ?: return false
        stopReport = reporter.stopped(body(c, null))
        _ended.value = end
        release()
        return true
    }

    // Stopped is queued before anything suspends (local playback started right after reports behind it, §8.4), then
    // the renderer is told, only while this cast still owns it: once ended, another cast may be playing there.
    suspend fun stop() {
        loop?.cancel()
        if (finish(End.Stopped)) runCatching { device.stop() }
    }

    // A new stream at [ticks] (transcode seek, track switch): the old play session is closed first.
    private suspend fun restart(ticks: Long, audio: Int?, sub: Int?) {
        val c = _state.value ?: return
        loop?.cancel()
        _state.value = null
        reporter.stopped(body(c.copy(positionTicks = ticks), null))
        try {
            start(c.item, ticks, c.msid, audio, sub)
        } catch (e: Exception) {
            _ended.value = End.Lost
            release()
            throw e
        }
    }

    private suspend fun seek(ticks: Long) {
        val c = _state.value ?: return
        if (c.transcoding) return restart(ticks, c.audio, c.sub)
        device.seek(ticks / TICKS_PER_MS)
        _state.update { it?.copy(positionTicks = ticks) }
        report("TimeUpdate")
    }

    private suspend fun setPaused(paused: Boolean) {
        if (paused) device.pause() else device.play()
        _state.update { it?.copy(paused = paused) }
        report(if (paused) "Pause" else "Unpause")
    }

    override suspend fun transport(target: CastTarget, cmd: String, seekTicks: Long?) {
        when (cmd.lowercase()) {
            "pause" -> setPaused(true)
            "unpause" -> setPaused(false)
            "playpause" -> setPaused(_state.value?.paused == false)
            "stop" -> stop()
            "seek" -> seekTicks?.let { seek(it.coerceAtLeast(0)) }
        }
    }

    override suspend fun command(target: CastTarget, name: String, args: Map<String, String>): Boolean {
        if (!target.supports(name)) return false
        val c = _state.value ?: return false
        when (name.lowercase()) {
            "setvolume" -> {
                val v = args["Volume"]?.toDoubleOrNull()?.toInt()?.coerceIn(0, 100) ?: return false
                device.setVolume(v)
                _state.update { it?.copy(volume = v) }
            }
            "mute", "unmute", "togglemute" -> {
                val on = when (name.lowercase()) { "mute" -> true; "unmute" -> false; else -> !c.muted }
                device.setMute(on)
                _state.update { it?.copy(muted = on) }
            }
            "setaudiostreamindex" -> return args["Index"]?.toIntOrNull()?.let { restart(c.positionTicks, it, c.sub); true } ?: false
            "setsubtitlestreamindex" -> return args["Index"]?.toIntOrNull()?.let { restart(c.positionTicks, c.audio, it); true } ?: false
            else -> return false
        }
        report("VolumeChange")
        return true
    }

    // The panel's view of the renderer, in the Sessions-API shape it already draws.
    override fun mirror(target: CastTarget): Flow<SessionState> = _state
        .map { c -> SessionState(c?.let(::session), c?.positionTicks ?: 0) }
        .onStart { watchers.incrementAndGet() }
        .onCompletion { watchers.decrementAndGet() }

    private fun session(c: Cast) = SessionInfo(
        id = device.target.key, deviceId = device.id, deviceName = device.name, client = device.client, supportsRemoteControl = true,
        nowPlayingItem = c.item, playState = PlayState(c.positionTicks, c.paused, c.muted, c.volume, c.msid, c.audio, c.sub),
    )

    override suspend fun awaitPlaying(target: CastTarget, itemId: String, timeoutMs: Long): Boolean = _state.value?.item?.id == itemId

    private fun now() = System.nanoTime() / 1_000_000

    companion object {
        // §8.4: what a direct renderer may get. Not a channel nor a programme (it cannot tune), nor a recording still
        // being written. Unknown (no Live TV on the server, an error) counts as not recording.
        suspend fun directAllowed(api: Api, item: Item): Boolean = item.type != "TvChannel" && item.type != "Program" && runCatching {
            api.get<ItemsResult>("/LiveTv/Recordings", "UserId" to api.userId, "IsInProgress" to true).items.none { it.id == item.id }
        }.getOrDefault(true)

        // The server's origin with its LAN IP: plain http, not through the mesh forwarder, a LAN address or a name
        // that resolves to one (some TVs cannot resolve names). null otherwise.
        suspend fun lanBase(api: Api): HttpUrl? = withContext(Dispatchers.IO) {
            val u = api.server.address.toHttpUrlOrNull() ?: return@withContext null
            if (u.scheme != "http" || Core.transport.forward(origin(u)) != null) return@withContext null
            val ip = if (LocalNetwork.isLanAddress(u.host)) u.host
            else runCatching { InetAddress.getAllByName(u.host).mapNotNull { it.hostAddress }.firstOrNull(LocalNetwork::isLanAddress) }.getOrNull()
            ip?.let { HttpUrl.Builder().scheme("http").host(it).port(u.port).build() }
        }
    }
}
