package com.wika.wicaby.core.cast

import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.SessionInfo
import com.wika.wicaby.core.data.SocketMessage
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.json
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// What the remote panel shows: the target's last known session (null: gone), its position moved forward locally.
data class SessionState(val session: SessionInfo?, val positionTicks: Long) {
    val itemId get() = session?.nowPlayingItem?.id
    val paused get() = session?.playState?.isPaused ?: true
}

// "Lire sur…" through the Sessions API (cast spec CA-03), on the server of [api] only: Android signs in to one
// server at a time and its items carry no server id, so the item's server is always [api]'s. Header auth (Api.raw).
// [messages] and [socketSend] are the session socket (X-06); without one the mirror simply keeps polling.
class RemoteTargets(
    private val api: Api,
    private val messages: Flow<SocketMessage> = Core.socketMessages,
    private val socketSend: (String, JsonElement?) -> Boolean = Core::socketSend,
    private val pollMs: Long = 2_000,
    private val pushGraceMs: Long = 3_000,
    private val tickMs: Long = 500,
) : CastRemote {
    // §2.2 section 1: what this user may drive, minus this device, sessions without remote control and those
    // that cannot play the item's media type. Server DLNA sessions (Client "DLNA") go to the DLNA section.
    suspend fun list(item: Item): List<CastTarget> {
        val type = item.mediaType ?: "Video"
        return api.get<List<SessionInfo>>("/Sessions", "ControllableByUserId" to api.userId, "ActiveWithinSeconds" to 960)
            .filter { s -> s.deviceId != api.deviceId && s.supportsRemoteControl && s.playableMediaTypes.any { it.equals(type, true) } }
            .map { s ->
                val dlna = s.client.equals("DLNA", true)
                CastTarget(
                    key = "s:${api.server.id}:${s.id}",
                    kind = if (dlna) CastTarget.Kind.Dlna else CastTarget.Kind.Session,
                    name = s.deviceName.ifBlank { s.client },
                    detail = if (dlna) api.server.name else s.client,
                    serverId = api.server.id,
                    sessionId = s.id,
                    deviceId = s.deviceId,
                    commands = s.supportedCommands.toSet(),
                    mediaTypes = s.playableMediaTypes.toSet(),
                )
            }
    }

    private fun path(target: CastTarget, rest: String = "") = "/Sessions/${target.sessionId ?: error("not a session target")}$rest"

    // Query only, empty body: the one form both servers read (Jellyfin ignores a body here).
    // A TvChannel goes with no position, version nor tracks: the receiver opens its own live stream (§1 Live TV).
    override suspend fun play(target: CastTarget, ids: List<String>, startIndex: Int, positionTicks: Long?, msid: String?, audio: Int?, sub: Int?, command: String) {
        api.raw(
            "POST", path(target, "/Playing"), null,
            "ItemIds" to ids.joinToString(","), "StartIndex" to startIndex.takeIf { it > 0 }, "PlayCommand" to command,
            "StartPositionTicks" to positionTicks, "MediaSourceId" to msid, "AudioStreamIndex" to audio, "SubtitleStreamIndex" to sub,
        )
    }

    // Stop, Pause, Unpause, PlayPause, NextTrack, PreviousTrack, Seek (with [seekTicks]). Never gated (§2.3).
    override suspend fun transport(target: CastTarget, cmd: String, seekTicks: Long?) {
        api.raw("POST", path(target, "/Playing/$cmd"), null, "SeekPositionTicks" to seekTicks)
    }

    // A general command, sent only when the session lists it. Argument values are strings on both servers.
    override suspend fun command(target: CastTarget, name: String, args: Map<String, String>): Boolean {
        if (!target.supports(name)) return false
        val body = buildJsonObject {
            put("Name", name)
            put("Arguments", buildJsonObject { args.forEach { (k, v) -> put(k, v) } })
        }
        api.raw("POST", path(target, "/Command"), body.toString())
        return true
    }

    suspend fun message(target: CastTarget, header: String, text: String, timeoutMs: Long = 5_000): Boolean {
        if (!target.supports("DisplayMessage")) return false
        val body = buildJsonObject {
            put("Header", header)
            put("Text", text.take(500))
            put("TimeoutMs", timeoutMs)
        }
        api.raw("POST", path(target, "/Message"), body.toString())
        return true
    }

    // Polls GET /Sessions?DeviceId= every [pollMs]; with a socket it also asks for Sessions pushes and pauses the
    // polling while pushes for this session arrive (a non-admin gets none for sessions it does not own, §3.8).
    override fun mirror(target: CastTarget): Flow<SessionState> = channelFlow {
        val id = target.sessionId ?: return@channelFlow
        var last: SessionInfo? = null
        var at = now()
        var pushAt = Long.MIN_VALUE / 2
        var pollAt = Long.MIN_VALUE / 2
        var started = false
        launch {
            messages.collect { m ->
                if (m.type != "Sessions") return@collect
                val all = runCatching { json.decodeFromJsonElement(ListSerializer(SessionInfo.serializer()), m.data ?: return@collect) }.getOrNull()
                val s = all?.firstOrNull { it.id == id } ?: return@collect
                last = s
                at = now()
                pushAt = at
            }
        }
        try {
            while (true) {
                val t = now()
                if (!started) started = socketSend("SessionsStart", JsonPrimitive("0,1500"))
                if (t - pushAt >= pushGraceMs && t - pollAt >= pollMs) {
                    pollAt = t
                    runCatching { api.get<List<SessionInfo>>("/Sessions", "DeviceId" to target.deviceId) }
                        .onSuccess { list ->
                            last = list.firstOrNull { it.id == id }
                            at = now()
                        }
                }
                send(state(last, at))
                delay(tickMs)
            }
        } finally {
            if (started) socketSend("SessionsStop", null)
        }
    }

    // Between reports the target keeps playing: its position moves on locally, up to the item's end.
    private fun state(s: SessionInfo?, at: Long): SessionState {
        val p = s?.playState ?: return SessionState(s, 0)
        val run = s.nowPlayingItem?.runTimeTicks ?: 0
        val moved = p.positionTicks + if (p.isPaused || s.nowPlayingItem == null) 0 else (now() - at) * TICKS_PER_MS
        return SessionState(s, if (run > 0) moved.coerceAtMost(run) else moved)
    }

    // §2.4 handoff: the 204 only says the server relayed Play. Success is the mirror showing [itemId] on the target.
    override suspend fun awaitPlaying(target: CastTarget, itemId: String, timeoutMs: Long): Boolean =
        withTimeoutOrNull(timeoutMs) { mirror(target).first { it.itemId == itemId } } != null

    private fun now() = System.nanoTime() / 1_000_000
}
