package com.wika.wicaby.core.player

import android.content.Context
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.SafeNames
import com.wika.wicaby.core.data.SocketMessage
import com.wika.wicaby.core.data.TICKS_PER_MS
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

// A "Play on Wicaby" request from another Emby/Jellyfin app; controller = the sender's ControllingUserId.
// queue: every id sent, when there are several (itemId is the one at StartIndex), played as a PlayQueue.
data class RemotePlay(
    val itemId: String, val startMs: Long?, val mediaSourceId: String?, val audio: Int?, val subtitle: Int?, val controller: String? = null,
    val queue: List<String> = emptyList(),
)

// The player on screen, as remote commands see it (Playback registers itself while it plays).
interface RemoteTarget {
    fun pause()
    fun unpause()
    fun playPause()
    fun stop()
    fun seek(ms: Long)
    fun next()
    fun previous()
    fun audio(index: Int)
    fun subtitle(index: Int)
    /** PlayNext / PlayLast: false when this player cannot queue (live, trailer), so the ids play now (desktop). */
    fun enqueue(ids: List<String>, next: Boolean): Boolean = false
}

// The device side: starting a player, the volume, messages.
interface RemoteHost {
    fun play(request: RemotePlay)
    fun volume(command: String, level: Int?)
    fun message(header: String?, text: String)
}

sealed interface RemoteCommand {
    data class Play(val request: RemotePlay) : RemoteCommand
    data class Queue(val ids: List<String>, val next: Boolean) : RemoteCommand
    data class State(val command: String, val seekMs: Long?) : RemoteCommand
    data class General(val name: String, val args: Map<String, String>) : RemoteCommand
}

// Maps the socket's Play, Playstate and GeneralCommand messages onto the player and the device.
// Ignored while Réglages > "Autoriser le contrôle à distance" is off (Core.remoteControl), except DisplayMessage:
// a notification, not control, shown in every state as on the desktop.
object RemoteControl {
    @Volatile
    var target: RemoteTarget? = null

    private val _plays = MutableSharedFlow<RemotePlay>(extraBufferCapacity = 4)

    /** The app's MainActivity starts its player on these; the new Playback then take()s the details. */
    val plays: SharedFlow<RemotePlay> = _plays

    /** Mobile (CA-05): Playstate and GeneralCommand (volume, tracks) only reach a live player; the TV keeps them without one. DisplayMessage always shows. */
    @Volatile
    var playerOnly = false

    @Volatile
    private var pending: Pair<RemotePlay, Long>? = null

    /** Hands [request] to the next Playback of its item (also when a "Lire" notification is tapped later). */
    fun arm(request: RemotePlay) {
        pending = request to System.currentTimeMillis()
    }

    /** Starts [request] as a "Play on" would (SyncPlay: the group's item). */
    fun play(request: RemotePlay) {
        arm(request)
        _plays.tryEmit(request)
    }

    /** The remote request for [itemId] (position, version, tracks), once, if it is under 30 s old. */
    fun take(itemId: String): RemotePlay? {
        val (req, at) = pending ?: return null
        if (req.itemId != itemId) return null
        pending = null
        return req.takeIf { System.currentTimeMillis() - at < 30_000 }
    }

    private fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.content?.takeIf { it.isNotEmpty() && it != "null" }

    private fun JsonElement?.long(): Long? = (this as? JsonPrimitive)?.let { it.longOrNull ?: it.content.toDoubleOrNull()?.toLong() }

    private fun JsonElement?.int(): Int? = (this as? JsonPrimitive)?.let { it.intOrNull ?: it.content.toIntOrNull() }

    fun parse(m: SocketMessage): RemoteCommand? {
        val d = m.data as? JsonObject ?: return null
        return when (m.type) {
            "Play" -> {
                val command = d["PlayCommand"].str() ?: "PlayNow"
                val ids = (d["ItemIds"] as? JsonArray)?.mapNotNull { it.str() }.orEmpty()
                // The server's ids only: they go into URLs and an Intent. One bad id drops the request (desktop).
                if (ids.isEmpty() || !ids.all(SafeNames::isValidId)) return null
                if (command == "PlayNext" || command == "PlayLast") return RemoteCommand.Queue(ids.take(1000), command == "PlayNext")
                if (command != "PlayNow") return null
                val id = ids.getOrNull(d["StartIndex"].int() ?: 0) ?: return null
                RemoteCommand.Play(
                    RemotePlay(
                        id, d["StartPositionTicks"].long()?.let { it / TICKS_PER_MS },
                        d["MediaSourceId"].str()?.takeIf(SafeNames::isValidId), d["AudioStreamIndex"].int(), d["SubtitleStreamIndex"].int(),
                        d["ControllingUserId"].str()?.takeIf(SafeNames::isValidId),
                        queue = ids.take(1000).takeIf { it.size > 1 }.orEmpty(),
                    ),
                )
            }
            "Playstate" -> RemoteCommand.State(d["Command"].str() ?: return null, d["SeekPositionTicks"].long()?.let { it / TICKS_PER_MS })
            "GeneralCommand" -> RemoteCommand.General(
                d["Name"].str() ?: return null,
                (d["Arguments"] as? JsonObject)?.mapNotNull { (k, v) -> v.str()?.let { k to it } }?.toMap().orEmpty(),
            )
            else -> null
        }
    }

    /** With remote control off ([enabled] false), only DisplayMessage gets through. */
    fun accepts(c: RemoteCommand, enabled: Boolean): Boolean = enabled || c.isMessage

    private val RemoteCommand.isMessage get() = this is RemoteCommand.General && name == "DisplayMessage"

    fun dispatch(c: RemoteCommand, target: RemoteTarget?, host: RemoteHost, playerOnly: Boolean = this.playerOnly) {
        if (c is RemoteCommand.General && target == null && playerOnly && !c.isMessage) return
        when (c) {
            is RemoteCommand.Play -> {
                arm(c.request)
                host.play(c.request)
            }
            // Spliced into the queue playing, else played now (desktop playback-service play()).
            is RemoteCommand.Queue -> if (target?.enqueue(c.ids, c.next) != true) {
                val r = RemotePlay(c.ids[0], null, null, null, null, queue = c.ids.takeIf { it.size > 1 }.orEmpty())
                arm(r)
                host.play(r)
            }
            is RemoteCommand.State -> when (c.command) {
                "Pause" -> target?.pause()
                "Unpause" -> target?.unpause()
                "PlayPause" -> target?.playPause()
                "Stop" -> target?.stop()
                "Seek" -> c.seekMs?.let { target?.seek(it) }
                "NextTrack" -> target?.next()
                "PreviousTrack" -> target?.previous()
            }
            is RemoteCommand.General -> when (c.name) {
                "SetVolume", "VolumeUp", "VolumeDown", "Mute", "Unmute", "ToggleMute" -> host.volume(c.name, c.args["Volume"]?.toIntOrNull())
                "SetAudioStreamIndex" -> c.args["Index"]?.toIntOrNull()?.let { target?.audio(it) }
                "SetSubtitleStreamIndex" -> c.args["Index"]?.toIntOrNull()?.let { target?.subtitle(it) }
                "DisplayMessage" -> c.args["Text"]?.let { host.message(c.args["Header"], it) }
                "GoHome" -> target?.stop()
            }
        }
    }

    /** STREAM_MUSIC as controllers see it in the reports: level 0–100 and muted (§3.4); null without audio. */
    fun streamVolume(context: Context): Pair<Int, Boolean>? = runCatching {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val s = AudioManager.STREAM_MUSIC
        val max = am.getStreamMaxVolume(s).takeIf { it > 0 } ?: return null
        (am.getStreamVolume(s) * 100 + max / 2) / max to am.isStreamMute(s)
    }.getOrNull()

    private val main by lazy { Handler(Looper.getMainLooper()) }

    /** From the socket thread: commands run on the main thread, where the player lives, if [current] still holds there. */
    fun handle(m: SocketMessage, enabled: Boolean, current: () -> Boolean = { true }) {
        val c = parse(m)?.takeIf { accepts(it, enabled) } ?: return
        main.post { if (current()) dispatch(c, target, AndroidHost) }
    }

    private object AndroidHost : RemoteHost {
        override fun play(request: RemotePlay) {
            _plays.tryEmit(request)
        }

        override fun volume(command: String, level: Int?) {
            val am = Core.app.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
            val s = AudioManager.STREAM_MUSIC
            val ui = AudioManager.FLAG_SHOW_UI
            runCatching {
                when (command) {
                    "SetVolume" -> level?.let { am.setStreamVolume(s, (it.coerceIn(0, 100) * am.getStreamMaxVolume(s) + 50) / 100, ui) }
                    "VolumeUp" -> am.adjustStreamVolume(s, AudioManager.ADJUST_RAISE, ui)
                    "VolumeDown" -> am.adjustStreamVolume(s, AudioManager.ADJUST_LOWER, ui)
                    "Mute" -> am.adjustStreamVolume(s, AudioManager.ADJUST_MUTE, ui)
                    "Unmute" -> am.adjustStreamVolume(s, AudioManager.ADJUST_UNMUTE, ui)
                    "ToggleMute" -> am.adjustStreamVolume(s, AudioManager.ADJUST_TOGGLE_MUTE, ui)
                }
            }
        }

        override fun message(header: String?, text: String) {
            MessageBanner.show(header?.takeIf { it.isNotBlank() } ?: Core.str(R.string.remote_message), text.take(500))
        }
    }
}
