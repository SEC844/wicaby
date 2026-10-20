package com.wika.wicaby.tv.music

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.annotation.OptIn
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.SafeNames
import com.wika.wicaby.core.music.Lyrics
import com.wika.wicaby.core.music.MusicSession
import com.wika.wicaby.core.music.instantMix
import com.wika.wicaby.core.music.lyrics
import com.wika.wicaby.core.player.buildEngine
import com.wika.wicaby.core.scrobble.ScrobbleService
import com.wika.wicaby.tv.BuildConfig

/**
 * The TV's music (music spec §4.7, MU-09): one core MusicSession that outlives the now-playing screen, so music goes
 * on while browsing and on the TV's home screen. Its ExoPlayer is its own (kept between sessions); starting a video
 * releases it (PlayerActivity). Main thread only.
 */
object Music {
    var session by mutableStateOf<MusicSession?>(null)
        private set
    private var player: Player? = null
    private var controller: ListenableFuture<MediaController>? = null

    /** Lyrics by track id ([NO_LYRICS]: the server has none), kept for the process. */
    val lyrics = mutableStateMapOf<String, Lyrics>()
    val NO_LYRICS = Lyrics(false, emptyList())

    /** Something to show: a session with a track (the ambient screen and the Dream look here). */
    val active: Boolean get() = session?.let { !it.released && it.current != null } == true

    /**
     * What the screensaver shows instead of its own (§4.7, TP-10): the session only while it plays (paused or ended: the
     * chosen screensaver), and only when it belongs to [open], the account the gate opened (a locked one never shows).
     */
    fun ambient(open: Api?): MusicSession? =
        session?.takeIf { active && it.playOn && open != null && it.api.server.id == open.server.id && it.api.userId == open.userId }

    /** Plays [items] from [start]; [player] is for tests (default: the music ExoPlayer, and MusicService bound to it). */
    fun start(context: Context, api: Api, items: List<Item>, start: Int, player: Player? = null): MusicSession {
        val old = session
        session = null
        old?.release()
        val app = context.applicationContext
        val p = player ?: testPlayer ?: this.player ?: buildEngine(app, api.authHeaders(), "Wicaby/${BuildConfig.VERSION_NAME} (Android TV)").player.also {
            // Music plays on with the screen saver up or the screen off: the CPU and Wi-Fi stay awake while it plays.
            it.setWakeMode(C.WAKE_MODE_NETWORK)
        }
        this.player = p
        // The session ending by itself (the queue emptied, a remote Stop) frees everything.
        val s = MusicSession(api, p, items, start, onReleased = { if (session === it) release() }, scrobbler = ScrobbleService.shared)
        session = s
        s.start()
        // Binding a controller starts MusicService (media session, foreground while playing), as mobile does.
        if (player == null && testPlayer == null && controller == null) controller = MediaController.Builder(app, SessionToken(app, ComponentName(app, MusicService::class.java))).buildAsync()
        return s
    }

    /** Plays [items] from [start] at [startMs] (a resume point) and opens the now-playing screen over the page. */
    fun play(context: Context, api: Api, items: List<Item>, start: Int, startMs: Long = 0) {
        val s = start(context, api, items, start)
        if (startMs > 0) s.seekTo(startMs)
        MusicActivity.open(context)
    }

    /** Ends the session, the service and the decoder. */
    fun release() {
        val s = session
        session = null
        s?.release()
        controller?.let(MediaController::releaseFuture)
        controller = null
        onRelease?.invoke()
        player?.release()
        player = null
    }

    suspend fun loadLyrics(s: MusicSession) {
        val id = s.queue.id ?: return
        if (id in lyrics) return
        // The full item: Jellyfin's HasLyrics, Emby's subtitle streams (the Emby shape is unverified: a miss is "none").
        val full = runCatching { s.api.item(id) }.getOrNull() ?: return
        lyrics[id] = s.api.lyrics(full) ?: NO_LYRICS
    }

    internal var onRelease: (() -> Unit)? = null

    // Tests: the player every session gets (no engine, no service).
    @androidx.annotation.VisibleForTesting
    var testPlayer: Player? = null
}

/** "Mix" (§3.3): the server's instant mix of the current track replaces what comes after it; the track plays on. */
suspend fun MusicSession.mix(): Boolean {
    val id = queue.id ?: return false
    val mix = runCatching { api.instantMix(id).items }.getOrNull()?.filter { it.id != id && SafeNames.isValidId(it.id) }.orEmpty()
    if (mix.isEmpty() || released) return false
    clearUpcoming()
    addToQueue(mix)
    return true
}

/** The tracks [ids] stand for, in that order (PlayQueue.tracks gives the ids; this their metadata, 100 a request). */
suspend fun Api.tracksOf(ids: List<String>): List<Item> {
    val byId = ids.distinct().chunked(100).flatMap { items("Ids" to it.joinToString(","), "Limit" to it.size, "Fields" to trackFields).items }.associateBy { it.id }
    return ids.mapNotNull(byId::get)
}

/**
 * Hosts the music session's MediaSession (music spec §4.7): the system's media controls, the remote's media keys while
 * another app is in front, the "Now playing" card on Google TV, and a foreground service (mediaPlayback) while it plays.
 */
class MusicService : MediaSessionService() {
    private var media: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val s = Music.session ?: return stopSelf()
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MusicActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        media = MediaSession.Builder(this, QueuePlayer(s.player)).setId("music").setSessionActivity(open).setCallback(OwnItemsOnly).build().also { addSession(it) }
        Music.onRelease = {
            media?.release()
            media = null
            stopSelf()
        }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = media

    // The service is exported: another app may pause or skip, never hand the player its own URLs (requests from this
    // process with the server's token, onto the LAN or the mesh).
    private object OwnItemsOnly : MediaSession.Callback {
        override fun onAddMediaItems(mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>): ListenableFuture<MutableList<MediaItem>> =
            if (controller.packageName == BuildConfig.APPLICATION_ID) super.onAddMediaItems(mediaSession, controller, mediaItems)
            else Futures.immediateFailedFuture(UnsupportedOperationException())
    }

    override fun onDestroy() {
        media?.release()
        media = null
        Music.onRelease = null
        super.onDestroy()
    }
}

/**
 * Next / previous from the session (the remote's media keys, Google TV's controls) go through the queue: the player's
 * own playlist only holds the current track and the two after it (MusicSession's window).
 */
@OptIn(UnstableApi::class)
private class QueuePlayer(player: Player) : ForwardingPlayer(player) {
    override fun seekToNext() = Music.session?.next() ?: Unit
    override fun seekToNextMediaItem() = Music.session?.next() ?: Unit
    override fun seekToPrevious() = Music.session?.previous() ?: Unit
    override fun seekToPreviousMediaItem() = Music.session?.previous() ?: Unit
}
