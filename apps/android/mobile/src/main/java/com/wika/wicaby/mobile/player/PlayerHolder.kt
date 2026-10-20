package com.wika.wicaby.mobile.player

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import android.content.ComponentName
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.music.MusicSession
import com.wika.wicaby.core.data.OfflineProgress
import com.wika.wicaby.core.data.withPending
import com.wika.wicaby.core.player.LocalMedia
import com.wika.wicaby.core.player.Engine
import com.wika.wicaby.core.player.Playback
import com.wika.wicaby.core.player.STILL_WATCHING_AFTER
import com.wika.wicaby.core.player.SleepTimer
import com.wika.wicaby.core.player.buildEngine
import com.wika.wicaby.core.scrobble.ScrobbleService
import com.wika.wicaby.mobile.BuildConfig
import com.wika.wicaby.mobile.cast.Casting
import com.wika.wicaby.mobile.download.Downloads
import com.wika.wicaby.mobile.ui.Cache
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel

// The player outlives PlayerActivity (background audio, PiP, lock screen), so it lives here,
// shared by the activity (video surface) and PlaybackService (MediaSession, notification).
object PlayerHolder {
    var engine: Engine? = null
        private set
    var playback by mutableStateOf<Playback?>(null)
        private set
    private var scope: CoroutineScope? = null
    // PlayerActivity is started (on screen or in PiP): its countdown drives the next episode.
    var visible = false
    private val releaseListeners = mutableListOf<() -> Unit>()

    // Music spec MU-07/MU-08: the music session on the same engine. Video and music are exclusive: starting one ends the other.
    var music by mutableStateOf<MusicSession?>(null)
        internal set
    private var controller: ListenableFuture<MediaController>? = null

    /** Plays [items] from [index] as the music queue ([shuffle]: a random first track, then shuffled). */
    fun startMusic(context: Context, api: Api, items: List<Item>, index: Int = 0, shuffle: Boolean = false): MusicSession {
        val app = context.applicationContext
        playback?.stop()
        playback = null
        music?.release()
        Casting.stopDirect()
        val eng = ensureEngine(app)
        val start = if (shuffle && items.isNotEmpty()) items.indices.random() else index
        val s = MusicSession(api, eng.player, items, start, local = { id -> Downloads.local(api.server.id, id) }, onReleased = { if (music === it) music = null }, scrobbler = ScrobbleService.shared)
        s.start()
        if (shuffle) s.toggleShuffle()
        music = s
        // Binding a controller starts PlaybackService (notification, lock screen, Bluetooth), as PlayerActivity does for video.
        if (controller == null) controller = MediaController.Builder(app, SessionToken(app, ComponentName(app, PlaybackService::class.java))).buildAsync()
        return s
    }

    fun start(context: Context, api: Api, id: String, fromStart: Boolean, trailer: Boolean = false): Playback {
        // The engine is kept across users and servers: Core.http's ServerAuthInterceptor adds the
        // active server's auth to each request, so the MediaSession survives a token change.
        music?.release()
        playback?.stop()
        // A direct DLNA cast reports as this device's session: it ends before local playback starts (cast spec §1).
        Casting.stopDirect()
        val eng = ensureEngine(context)
        val sc = scope ?: MainScope().also { scope = it }
        val pb = Playback(
            context.applicationContext, api, eng.player, id, fromStart,
            // A downloaded copy resumes where it was last watched offline (OfflineProgress), not where it was downloaded.
            local = { id -> Downloads.local(api.server.id, id)?.let { LocalMedia(it.item.withPending(OfflineProgress.pending(), api.server.id, api.userId), it.uri) } },
            onStopped = { Cache.invalidateHome() },
            onEnded = { playback?.let(::autoNext) },
            trailer = trailer,
        )
        pb.start(sc)
        playback = pb
        return pb
    }

    // Off screen (phone locked, another app on top, activity gone) nothing composes the countdown,
    // so the session moves on to the next episode itself, within the "Toujours là ?" limit.
    private fun autoNext(pb: Playback) {
        if (!visible && pb.next != null && !pb.upNextDismissed && !SleepTimer.endOfVideo && pb.autoCount < STILL_WATCHING_AFTER) pb.advance(auto = true)
    }

    // The engine is kept across users and servers (Core.http adds the server's auth per request); Android Auto (MU-12)
    // builds it too, to browse before anything plays.
    fun ensureEngine(context: Context): Engine =
        engine ?: buildEngine(context.applicationContext, emptyMap(), "Wicaby/${BuildConfig.VERSION_NAME} (Android)").also { engine = it }

    fun onRelease(l: () -> Unit) {
        releaseListeners += l
    }

    // Ends the session (Stopped report) and frees the decoder; the service then stops itself.
    fun release() {
        playback?.stop()
        playback = null
        music?.release()
        controller?.let(MediaController::releaseFuture)
        controller = null
        releaseEngine()
        val ls = releaseListeners.toList()
        releaseListeners.clear()
        ls.forEach { it() }
    }

    private fun releaseEngine() {
        scope?.cancel()
        scope = null
        engine?.player?.release()
        engine = null
    }
}
