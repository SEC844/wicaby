package com.wika.wicaby.mobile.player

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.OfflineProgress
import com.wika.wicaby.core.data.withPending
import com.wika.wicaby.core.player.LocalMedia
import com.wika.wicaby.core.player.Engine
import com.wika.wicaby.core.player.Playback
import com.wika.wicaby.core.player.STILL_WATCHING_AFTER
import com.wika.wicaby.core.player.SleepTimer
import com.wika.wicaby.core.player.buildEngine
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

    fun start(context: Context, api: Api, id: String, fromStart: Boolean, trailer: Boolean = false): Playback {
        // The engine is kept across users and servers: Core.http's ServerAuthInterceptor adds the
        // active server's auth to each request, so the MediaSession survives a token change.
        playback?.stop()
        // A direct DLNA cast reports as this device's session: it ends before local playback starts (cast spec §1).
        Casting.stopDirect()
        val eng = engine ?: buildEngine(context.applicationContext, api.authHeaders(), "Wicaby/${BuildConfig.VERSION_NAME} (Android)").also { engine = it }
        val sc = scope ?: MainScope().also { scope = it }
        val pb = Playback(
            context.applicationContext, api, eng.player, id, fromStart,
            // A downloaded copy resumes where it was last watched offline (OfflineProgress), not where it was downloaded.
            local = { id -> Downloads.local(id)?.let { LocalMedia(it.item.withPending(OfflineProgress.pending(), api.server.id, api.userId), it.uri) } },
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

    fun onRelease(l: () -> Unit) {
        releaseListeners += l
    }

    // Ends the session (Stopped report) and frees the decoder; the service then stops itself.
    fun release() {
        playback?.stop()
        playback = null
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
