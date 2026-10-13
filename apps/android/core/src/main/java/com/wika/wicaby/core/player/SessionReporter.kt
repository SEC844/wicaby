package com.wika.wicaby.core.player

import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// The /Sessions/Playing* trio (cast spec §2.5, §2.7.6), shared by Playback (this device's player) and
// cast/CastController (a DLNA renderer this device drives and reports for, as its own session).
class SessionReporter(private val api: Api) {
    class State(
        val itemId: String,
        val mediaSourceId: String?,
        val playSessionId: String?,
        val positionTicks: Long,
        val paused: Boolean,
        val muted: Boolean,
        val volume: Int?,
        val playMethod: String,
        val canSeek: Boolean,
        val liveStreamId: String? = null,
        val audio: Int? = null,
        val subtitle: Int = -1,
        val rate: Float? = null,
        // A cast plays one item: QueueableMediaTypes is sent empty (§2.5).
        val queueable: Boolean = true,
    )

    fun body(s: State, event: String?): JsonObject = buildJsonObject {
        put("ItemId", s.itemId)
        put("MediaSourceId", s.mediaSourceId)
        put("PlaySessionId", s.playSessionId)
        put("PositionTicks", s.positionTicks)
        put("IsPaused", s.paused)
        put("IsMuted", s.muted)
        s.volume?.let { put("VolumeLevel", it) }
        put("PlayMethod", s.playMethod)
        put("CanSeek", s.canSeek)
        s.liveStreamId?.let { put("LiveStreamId", it) }
        put("RepeatMode", "RepeatNone")
        s.audio?.let { put("AudioStreamIndex", it) }
        put("SubtitleStreamIndex", s.subtitle)
        s.rate?.let { put("PlaybackRate", it) }
        if (!s.queueable) put("QueueableMediaTypes", JsonArray(emptyList()))
        event?.let { put("EventName", it) }
    }

    // Fire and forget: a report that fails is not retried (the next one carries the same state).
    fun report(path: String, body: JsonObject) {
        val payload = body.toString()
        val job: suspend () -> Unit = { runCatching { api.raw("POST", path, payload) } }
        if (path.endsWith("/Progress")) latest(path, job) else send(job)
    }

    fun ping(playSessionId: String) {
        latest("/Sessions/Playing/Ping") { runCatching { api.raw("POST", "/Sessions/Playing/Ping", null, "PlaySessionId" to playSessionId) } }
    }

    // Holds every report queued after this until [wait] returns: a report sent outside this queue (Live TV's Stopped).
    fun after(wait: suspend () -> Unit) = send(wait)

    // Queued now, in order with every other report; the result once the server answered.
    fun stopped(body: JsonObject): Deferred<Boolean> {
        val payload = body.toString()
        val done = CompletableDeferred<Boolean>()
        send { done.complete(runCatching { api.raw("POST", "/Sessions/Playing/Stopped", payload) }.isSuccess) }
        return done
    }

    companion object {
        // One queue for the process: Playback and a direct cast (CastController) report as the same DeviceId, so
        // the server must get their reports in the order they were made, a Stopped before the next Playing (§8.4).
        private val queue = Channel<suspend () -> Unit>(Channel.UNLIMITED).also { q ->
            Core.scope.launch { for (job in q) runCatching { job() } }
        }

        private class Slot(@Volatile var job: suspend () -> Unit)

        private val lock = Any()

        // Progress and Ping still waiting in the queue, by path. They only describe the present, so while one waits
        // (a slow or hung server) a newer one replaces it instead of piling up: the queue stays bounded. Anything
        // else queued clears this, so a replacement never jumps ahead of a Stopped or a Playing.
        private val waiting = HashMap<String, Slot>()

        private fun send(job: suspend () -> Unit) {
            synchronized(lock) {
                waiting.clear()
                queue.trySend(job)
            }
        }

        private fun latest(key: String, job: suspend () -> Unit) {
            synchronized(lock) {
                waiting[key]?.let {
                    it.job = job
                    return
                }
                val slot = Slot(job)
                waiting[key] = slot
                queue.trySend {
                    synchronized(lock) { if (waiting[key] === slot) waiting.remove(key) }
                    slot.job()
                }
            }
        }
    }
}
