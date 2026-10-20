package com.wika.wicaby.core.syncplay

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.media3.common.Player
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.SocketMessage
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.clock
import com.wika.wicaby.core.data.isoUtc
import com.wika.wicaby.core.livetv.parseServerDate
import com.wika.wicaby.core.player.MessageBanner
import com.wika.wicaby.core.player.Playback
import com.wika.wicaby.core.player.RemoteControl
import com.wika.wicaby.core.player.RemotePlay
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

// Jellyfin SyncPlay ("Regarder ensemble"), as jellyfin-web's plugin: the server holds the group's queue and
// state; this device asks (Pause, Unpause, Seek), reports Ready/Buffering, and applies the server's commands at
// their When (server clock, TimeSync). Updates and commands come on the session socket (Core.socketMessages).
// The player on screen joins the group while it plays the group's item; leaving it leaves the group.
// Main thread, except the HTTP calls.
object SyncPlay {
    var group by mutableStateOf<SyncGroup?>(null)
        private set

    private var api: Api? = null
    private var sync = TimeSync()
    private var queue: SyncQueue? = null
    private var pb: Playback? = null
    // The player on screen, bound or not.
    private var current: Playback? = null
    private var jobs = emptyList<Job>()
    private val main by lazy { Handler(Looper.getMainLooper()) }
    private var scheduled: Runnable? = null
    // Our own pause/play/seek calls: the listener must not send them back as requests.
    private var applying = false
    // Waiting for the group (new item, Seek command, buffering): Ready goes out once the player is ready.
    private var readyPending = false
    // What this device asked last: its echo from the server gets no banner.
    private var asked: Pair<String, Long>? = null

    // Only the signed-in session: its socket (Core.socketMessages) is the one that carries the group's messages.
    fun available(api: Api) = api.server.kind == "jellyfin" && Core.api.let { it != null && it.server.id == api.server.id && it.userId == api.userId }

    suspend fun groups(api: Api): List<SyncGroup> = api.get<JsonArray>("/SyncPlay/List").mapNotNull { SyncGroup.parse(it) }

    /** A new group named [name]; with [itemId], its queue starts on that item at [startMs] (the detail page). */
    suspend fun create(api: Api, name: String, itemId: String?, startMs: Long = 0) = begin(api) {
        api.raw("POST", "/SyncPlay/New", buildJsonObject { put("GroupName", name) }.toString())
        if (itemId != null) {
            api.raw(
                "POST", "/SyncPlay/SetNewQueue",
                buildJsonObject {
                    putJsonArray("PlayingQueue") { add(itemId) }
                    put("PlayingItemPosition", 0)
                    put("StartPositionTicks", startMs * TICKS_PER_MS)
                }.toString(),
            )
        }
    }

    suspend fun join(api: Api, groupId: String) = begin(api) {
        api.raw("POST", "/SyncPlay/Join", buildJsonObject { put("GroupId", groupId) }.toString())
    }

    fun leave() {
        val a = api ?: return
        end()
        Core.scope.launch { runCatching { a.raw("POST", "/SyncPlay/Leave") } }
    }

    private suspend fun begin(api: Api, call: suspend () -> Unit) {
        withContext(Dispatchers.Main) {
            // The server moves a session already in a group: no Leave of our own to race the next call.
            end()
            this@SyncPlay.api = api
            sync = TimeSync()
            jobs = listOf(
                // Subscribed before the request goes: GroupJoined may come back fast.
                Core.scope.launch(Dispatchers.Main, start = CoroutineStart.UNDISPATCHED) { Core.socketMessages.collect(::onMessage) },
                Core.scope.launch { timeSync(api) },
            )
        }
        try {
            call()
        } catch (e: Exception) {
            withContext(Dispatchers.Main) { if (this@SyncPlay.api === api) end() }
            throw e
        }
    }

    private fun end() {
        jobs.forEach { it.cancel() }
        jobs = emptyList()
        unbind()
        api = null
        group = null
        queue = null
    }

    // Eight samples a second apart, then one a minute; each sends the ping the server spaces its commands by.
    private suspend fun timeSync(a: Api) {
        var n = 0
        while (currentCoroutineContext().isActive) {
            val sent = System.currentTimeMillis()
            val r = runCatching { a.get<JsonObject>("/GetUtcTime") }.getOrNull()
            val received = System.currentTimeMillis()
            val inAt = parseServerDate(r?.get("RequestReceptionTime"))
            val outAt = parseServerDate(r?.get("ResponseTransmissionTime"))
            if (inAt != null && outAt != null) {
                sync.add(sent, inAt, outAt, received)
                runCatching { a.raw("POST", "/SyncPlay/Ping", buildJsonObject { put("Ping", sync.pingMs) }.toString()) }
            }
            delay(if (++n < 8) 1_000 else 60_000)
        }
    }

    private fun onMessage(m: SocketMessage) {
        // The socket now belongs to another session (server or user switch): not this group's messages.
        if (api?.let(::available) != true) return
        when (m.type) {
            "SyncPlayGroupUpdate" -> (m.data as? JsonObject)?.let(::onUpdate)
            "SyncPlayCommand" -> SyncCommand.parse(m.data)?.let(::onCommand)
        }
    }

    private fun onUpdate(u: JsonObject) {
        val d = u["Data"]
        val name = (d as? JsonPrimitive)?.content.orEmpty()
        when (u.str("Type")) {
            "GroupJoined" -> SyncGroup.parse(d)?.let {
                group = it
                banner(Core.str(R.string.syncplay_joined, it.name))
            }
            "UserJoined" -> group?.let {
                group = it.copy(participants = it.participants + name)
                banner(Core.str(R.string.syncplay_user_joined, name))
            }
            "UserLeft" -> group?.let {
                group = it.copy(participants = it.participants.toMutableList().apply { remove(name) })
                banner(Core.str(R.string.syncplay_user_left, name))
            }
            // GroupLeft of the group a create or join just moved us out of: not this one.
            "GroupLeft" -> if (group != null && u.str("GroupId") == group?.id) {
                end()
                banner(Core.str(R.string.syncplay_left))
            }
            "NotInGroup", "GroupDoesNotExist", "LibraryAccessDenied" -> {
                if (group != null) banner(Core.str(R.string.syncplay_left))
                end()
            }
            "PlayQueue" -> SyncQueue.parse(d)?.let(::onQueue)
        }
    }

    private fun onQueue(q: SyncQueue) {
        val prev = queue
        queue = q
        if (!q.reloads(prev)) return
        val p = pb ?: current
        // Created from the player: the item playing is the group's.
        if (p != null && p.itemId == q.itemId) return if (pb == null) attach(p) else waitForGroup(q.startMs)
        // The old player lets go now (its stop is not a leave); the new one binds in attach() once it starts.
        unbind()
        RemoteControl.play(RemotePlay(q.itemId, q.startMs, null, null, null))
    }

    private fun onCommand(c: SyncCommand) {
        val q = queue
        if (pb == null || (q != null && c.playlistItemId != null && c.playlistItemId != q.playlistItemId)) return
        scheduled?.let(main::removeCallbacks)
        val run = Runnable { execute(c) }
        scheduled = run
        main.postDelayed(run, SyncPlan.delayMs(c, System.currentTimeMillis(), sync))
        val mine = asked?.let { it.first == c.command && System.currentTimeMillis() - it.second < 5_000 } == true
        if (!mine) when (c.command) {
            "Pause" -> banner(Core.str(R.string.syncplay_paused))
            "Unpause" -> banner(Core.str(R.string.syncplay_resumed))
            "Seek" -> banner(Core.str(R.string.syncplay_seeked, clock(c.positionMs)))
        }
    }

    private fun execute(c: SyncCommand) {
        val player = pb?.player ?: return
        val seek = SyncPlan.seekTo(c, System.currentTimeMillis(), sync, player.currentPosition)
        apply {
            when (c.command) {
                "Unpause" -> {
                    seek?.let(player::seekTo)
                    player.play()
                }
                "Pause", "Stop" -> {
                    player.pause()
                    seek?.let(player::seekTo)
                }
                "Seek" -> {
                    player.pause()
                    player.seekTo(seek ?: c.positionMs)
                    readyPending = true
                }
            }
        }
    }

    // Paused at the group's position until its Unpause; Ready once loaded (the server checks the position).
    private fun waitForGroup(startMs: Long) {
        val player = pb?.player ?: return
        readyPending = true
        apply {
            player.pause()
            player.seekTo(startMs)
        }
    }

    private inline fun apply(block: () -> Unit) {
        applying = true
        try { block() } finally { applying = false }
    }

    /** From Playback.start: the player of the group's item joins it (also later, once a queue names it). */
    fun attach(p: Playback) {
        if (p.preview || p.trailer) return
        current = p
        val q = queue ?: return
        if (group == null || p.itemId != q.itemId || api?.server?.id != p.api.server.id) return
        unbind()
        pb = p
        p.player.addListener(listener)
        waitForGroup(q.startMs)
    }

    /** From Playback.stop: leaving the group's player leaves the group. */
    fun detach(p: Playback) {
        if (current === p) current = null
        if (pb !== p) return
        leave()
    }

    private fun unbind() {
        scheduled?.let(main::removeCallbacks)
        scheduled = null
        pb?.player?.removeListener(listener)
        pb = null
        readyPending = false
    }

    // The player moved on by itself (next episode): no longer the group's item.
    private fun stale(): Boolean {
        val q = queue
        val p = pb ?: return false
        val stale = q != null && p.itemId != q.itemId
        if (stale) leave()
        return stale
    }

    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            val player = pb?.player ?: return
            if (stale()) return
            if (state == Player.STATE_READY && readyPending) {
                readyPending = false
                report("Ready", player.playWhenReady)
            } else if (state == Player.STATE_BUFFERING && !readyPending && !applying && player.playWhenReady) {
                readyPending = true
                report("Buffering", true)
            }
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            if (applying || reason != Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST || stale()) return
            // The player's own start while the group waits: the group's Unpause starts it.
            if (readyPending) {
                if (playWhenReady) apply { pb?.player?.pause() }
                return
            }
            request(if (playWhenReady) "Unpause" else "Pause")
        }

        override fun onPositionDiscontinuity(old: Player.PositionInfo, new: Player.PositionInfo, reason: Int) {
            if (applying || readyPending || reason != Player.DISCONTINUITY_REASON_SEEK || stale()) return
            request("Seek", buildJsonObject { put("PositionTicks", new.positionMs * TICKS_PER_MS) }.toString())
        }
    }

    private fun request(command: String, body: String? = null) {
        val a = api ?: return
        asked = command to System.currentTimeMillis()
        Core.scope.launch { runCatching { a.raw("POST", "/SyncPlay/$command", body) } }
    }

    private fun report(path: String, playing: Boolean) {
        val a = api ?: return
        val q = queue ?: return
        val pos = pb?.player?.currentPosition ?: return
        val body = buildJsonObject {
            put("When", isoUtc(sync.toServer(System.currentTimeMillis())))
            put("PositionTicks", pos * TICKS_PER_MS)
            put("IsPlaying", playing)
            put("PlaylistItemId", q.playlistItemId)
        }.toString()
        Core.scope.launch { runCatching { a.raw("POST", "/SyncPlay/$path", body) } }
    }

    private fun banner(text: String) = MessageBanner.show(Core.str(R.string.syncplay_title), text, shownMs = 3_000)
}
