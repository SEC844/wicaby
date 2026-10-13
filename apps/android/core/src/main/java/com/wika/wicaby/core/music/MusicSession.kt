package com.wika.wicaby.core.music

import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.SafeNames
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.poster
import com.wika.wicaby.core.player.AudioFx
import com.wika.wicaby.core.player.LocalMedia
import com.wika.wicaby.core.player.PlayQueue
import com.wika.wicaby.core.player.RemoteControl
import com.wika.wicaby.core.player.RemoteTarget
import com.wika.wicaby.core.player.SessionReporter
import com.wika.wicaby.core.player.audioAttributes
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.UUID
import kotlin.random.Random

enum class GainMode { Off, Track, Album }

/** Loudness (music spec §3.6, D2): the server's NormalizationGain (Jellyfin 10.9+; Emby has none, so 0 dB) plus the preamp. */
object MusicGain {
    // shortcut: the defaults only (album mode, 0 dB preamp, clipping prevented); no Android settings pane for them yet.
    @Volatile
    var mode = GainMode.Album

    @Volatile
    var preampDb = 0.0

    const val MIN_DB = -24.0
    const val MAX_DB = 12.0

    fun db(track: Double?, album: Double?, mode: GainMode = this.mode, preampDb: Double = this.preampDb): Double = when (mode) {
        GainMode.Off -> 0.0
        GainMode.Track -> (track ?: 0.0) + preampDb
        GainMode.Album -> (album ?: track ?: 0.0) + preampDb
    }.coerceIn(MIN_DB, MAX_DB)
}

/**
 * The music player (music spec MU-07, §4.5), the twin of player/Playback.kt for songs. The queue ([PlayQueue] with the
 * MusicQueue ops) is the truth; the player holds a window of it, the current track and the next two, so ExoPlayer
 * plays them gapless. Each transition reports Stopped (previous) then Playing (next), sets the loudness gain and
 * refills the window. Tracks stream directly (/Audio/{id}/stream?static=true, §3.4), a downloaded one from its file.
 */
class MusicSession(
    val api: Api,
    val player: Player,
    items: List<Item>,
    startIndex: Int = 0,
    private val local: (String) -> LocalMedia? = { null },
    private val onReleased: (MusicSession) -> Unit = {},
) {
    val queue = PlayQueue(items.map { it.id }, startIndex, fromStart = true)

    /** Every queued track by id (queue sheet rows, metadata of the player's items). */
    val known = mutableStateMapOf<String, Item>().apply { items.forEach { put(it.id, it) } }
    var current by mutableStateOf<Item?>(null)
        private set
    var isPlaying by mutableStateOf(false)
        private set
    /** Set to play and short of the queue's end: unlike [isPlaying], a buffering stall still counts (the TV screensaver's ambient layout). */
    var playOn by mutableStateOf(false)
        private set
    var released by mutableStateOf(false)
        private set

    // The queue index of each player item.
    private var window = emptyList<Int>()
    private val scope: CoroutineScope = MainScope()
    private val reporter = SessionReporter(api)
    private var playSessionId = ""
    private var reported = false
    private var lastPosMs = 0L
    private var errors = 0
    private val albumGains = HashMap<String, Double?>()

    fun start() {
        load()
        player.prepare()
        player.play()
        syncPlayOn()
    }

    private fun syncPlayOn() {
        playOn = !released && player.playWhenReady && player.playbackState != Player.STATE_ENDED
    }

    /** Builds the player's window and reports the first track; [start] also prepares and plays. */
    fun load() {
        player.setAudioAttributes(audioAttributes(music = true), true)
        player.addListener(listener)
        window = upcoming(queue.index)
        player.setMediaItems(window.map { mediaItem(queue.ids[it]) }, 0, 0)
        begin()
        RemoteControl.target = remote
        scope.launch {
            var n = 0
            while (isActive) {
                delay(1_000)
                if (!player.isPlaying) continue
                lastPosMs = player.currentPosition
                if (++n % 10 == 0) report("/Sessions/Playing/Progress", "TimeUpdate")
            }
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Transport.

    fun playPause() = if (player.playWhenReady) player.pause() else { if (player.playbackState == Player.STATE_ENDED) player.seekTo(0, 0); player.play() }

    fun seekTo(ms: Long) = player.seekTo(ms)

    fun next() {
        val n = queue.nextIndex(manual = true)
        if (n >= 0) jump(n)
    }

    /** Desktop: the previous entry within the first 5 s, else back to the start. */
    fun previous() {
        val p = if (queue.index > 0) queue.index - 1 else if (queue.repeat == Repeat.All) queue.ids.lastIndex else -1
        if (player.currentPosition > 5_000 || p < 0) player.seekTo(0) else jump(p)
    }

    /** Plays queue entry [i] now. */
    fun jump(i: Int) {
        if (i !in queue.ids.indices || released) return
        lastPosMs = player.currentPosition
        // The next one is already loaded: a plain seek keeps it (and the listener moves the queue).
        if (i != queue.index && window.getOrNull(1) == i) return player.seekToNextMediaItem()
        end(lastPosMs)
        queue.apply(QueueOp.Jump(i))
        restart()
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Queue edits.

    fun playNext(items: List<Item>) = add(items, QueueOp.InsertNext(items.map { it.id }))

    fun addToQueue(items: List<Item>) = add(items, QueueOp.Append(items.map { it.id }))

    private fun add(items: List<Item>, op: QueueOp) {
        items.forEach { known[it.id] = it }
        edit(op)
    }

    fun move(from: Int, to: Int) = edit(QueueOp.Move(from, to))

    fun remove(i: Int) = edit(QueueOp.Remove(i))

    fun clearUpcoming() = edit(QueueOp.ClearUpcoming)

    fun toggleShuffle() = edit(if (queue.unshuffled == null) QueueOp.Shuffle(Random.nextInt()) else QueueOp.Unshuffle)

    fun cycleRepeat() = edit(QueueOp.SetRepeat(Repeat.entries[(queue.repeat.ordinal + 1) % Repeat.entries.size]))

    /** A queue operation: only the player items after the current one change, unless the playing entry went. */
    fun edit(op: QueueOp) {
        if (released) return
        val was = queue.id
        queue.apply(op)
        when {
            queue.ids.isEmpty() -> release()
            queue.id != was -> {
                end(player.currentPosition)
                restart()
            }
            else -> syncTail()
        }
    }

    fun release() {
        if (released) return
        released = true
        playOn = false
        end(player.currentPosition)
        scope.cancel()
        player.removeListener(listener)
        player.stop()
        player.clearMediaItems()
        player.setAudioAttributes(audioAttributes(music = false), true)
        AudioFx.musicGainDb = 0f
        if (RemoteControl.target === remote) RemoteControl.target = null
        onReleased(this)
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The window.

    // The current entry and the two that follow it (repeat applied): what the player holds.
    private fun upcoming(from: Int): List<Int> {
        val out = mutableListOf(from)
        var s = queue.state.copy(index = from)
        while (out.size < WINDOW) {
            val n = MusicQueue.nextIndex(s)
            if (n < 0) break
            out += n
            s = s.copy(index = n)
        }
        return out
    }

    private fun restart() {
        window = upcoming(queue.index)
        player.setMediaItems(window.map { mediaItem(queue.ids[it]) }, 0, 0)
        player.prepare()
        begin()
    }

    // After a queue edit: the items after the current one become the wanted ones; a common head is kept (its buffer too).
    private fun syncTail() {
        val c = player.currentMediaItemIndex
        val want = upcoming(queue.index)
        val wantIds = want.drop(1).map { queue.ids[it] }
        val haveIds = (c + 1 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }
        val keep = wantIds.zip(haveIds).takeWhile { (a, b) -> a == b }.size
        if (c + 1 + keep < player.mediaItemCount) player.removeMediaItems(c + 1 + keep, player.mediaItemCount)
        if (keep < wantIds.size) player.addMediaItems(wantIds.drop(keep).map(::mediaItem))
        window = List(c) { -1 } + want
    }

    internal fun mediaItem(id: String): MediaItem {
        val copy = local(id)
        val it = copy?.item ?: known[id] ?: Item(id)
        val uri = copy?.uri ?: Uri.parse(api.url("/Audio/$id/stream", "static" to true, "MediaSourceId" to (it.mediaSources.firstOrNull()?.id ?: id)))
        val meta = MediaMetadata.Builder()
            .setTitle(it.name).setArtist(it.artistLine).setAlbumTitle(it.album).setAlbumArtist(it.albumArtist)
            .setTrackNumber(it.indexNumber).setDiscNumber(it.parentIndexNumber)
            // The album art, loaded by the session's bitmap loader through Core.http (auth and mesh transport).
            .setArtworkUri(api.poster(it, ART_PX)?.let(Uri::parse))
            .setDurationMs(it.runTimeTicks?.let { t -> t / TICKS_PER_MS })
            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
            .build()
        return MediaItem.Builder().setMediaId(id).setUri(uri).setMediaMetadata(meta).build()
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Player events.

    internal val listener = object : Player.Listener {
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            // PLAYLIST_CHANGED comes from this class's own edits, which report for themselves.
            if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED) moved(reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO)
        }

        override fun onIsPlayingChanged(playing: Boolean) {
            isPlaying = playing
            if (player.playbackState != Player.STATE_ENDED) report("/Sessions/Playing/Progress", if (player.playWhenReady) "Unpause" else "Pause")
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = syncPlayOn()

        override fun onPlaybackStateChanged(state: Int) {
            syncPlayOn()
            if (state == Player.STATE_READY) errors = 0
            // The end of the queue: the last track is reported as played through.
            if (state == Player.STATE_ENDED) end(current?.runTimeTicks?.let { it / TICKS_PER_MS } ?: player.currentPosition)
        }

        override fun onPlayerError(error: PlaybackException) {
            // shortcut: a track that fails is skipped; a PlaybackInfo / transcode retry (spec §4.5) would rescue odd containers.
            val n = queue.nextIndex(manual = true)
            if (++errors <= queue.ids.size && n >= 0 && n != queue.index) jump(n)
        }
    }

    // The player moved to another item of the window (end of a track, or the notification's next).
    internal fun moved(auto: Boolean) {
        val c = player.currentMediaItemIndex
        val qi = window.getOrNull(c) ?: return
        if (c <= 0 || qi < 0) return
        end(if (auto) current?.runTimeTicks?.let { it / TICKS_PER_MS } ?: lastPosMs else lastPosMs)
        player.removeMediaItems(0, c)
        window = window.drop(c)
        queue.apply(QueueOp.Jump(qi))
        begin()
        syncTail()
    }

    // A new current track: its Playing report and its gain.
    private fun begin() {
        current = known[queue.id] ?: queue.id?.let { local(it)?.item }
        playSessionId = UUID.randomUUID().toString().replace("-", "")
        lastPosMs = 0
        reported = true
        report("/Sessions/Playing", null)
        applyGain()
    }

    private fun applyGain() {
        val it = current ?: return
        val albumId = it.albumId
        AudioFx.musicGainDb = MusicGain.db(it.normalizationGain, albumId?.let(albumGains::get)).toFloat()
        // shortcut: the gain changes when the track is heard, so the first buffer (< 1 s) of a new album's track plays
        // at the previous gain; within an album (album mode, the default) nothing changes.
        if (MusicGain.mode != GainMode.Album || albumId == null || albumId in albumGains || api.server.isEmby) return
        albumGains[albumId] = null
        scope.launch {
            albumGains[albumId] = runCatching { api.item(albumId).normalizationGain }.getOrNull()
            if (current?.albumId == albumId) applyGain()
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Reports (/Sessions/Playing*, spec §3.9): the server plugins scrobble from them.

    private fun body(it: Item, posMs: Long, event: String?) = reporter.body(
        SessionReporter.State(
            it.id, it.mediaSources.firstOrNull()?.id ?: it.id, playSessionId, posMs * TICKS_PER_MS, !player.playWhenReady,
            muted = false, volume = null, playMethod = "DirectPlay", canSeek = true,
        ),
        event,
    )

    private fun report(path: String, event: String?) {
        val it = current ?: return
        if (released && path != "/Sessions/Playing/Stopped") return
        reporter.report(path, body(it, if (path == "/Sessions/Playing") 0 else player.currentPosition, event))
    }

    // Stopped for the current track, once.
    private fun end(posMs: Long) {
        val it = current ?: return
        if (!reported) return
        reported = false
        reporter.report("/Sessions/Playing/Stopped", body(it, posMs, null))
    }

    // Server remote control (another client's Pause, Next, Play next…) while music plays.
    private val remote = object : RemoteTarget {
        override fun pause() = player.pause()
        override fun unpause() = player.play()
        override fun playPause() = this@MusicSession.playPause()
        override fun stop() = release()
        override fun seek(ms: Long) = player.seekTo(ms)
        override fun next() = this@MusicSession.next()
        override fun previous() = this@MusicSession.previous()
        override fun audio(index: Int) = Unit
        override fun subtitle(index: Int) = Unit
        override fun enqueue(ids: List<String>, next: Boolean): Boolean {
            val safe = ids.filter(SafeNames::isValidId)
            scope.launch {
                val items = runCatching { api.items("Ids" to safe.joinToString(","), "EnableImages" to true).items }.getOrNull() ?: return@launch
                if (next) playNext(items) else addToQueue(items)
            }
            return true
        }
    }

    companion object {
        const val WINDOW = 3
        const val ART_PX = 512
    }
}
