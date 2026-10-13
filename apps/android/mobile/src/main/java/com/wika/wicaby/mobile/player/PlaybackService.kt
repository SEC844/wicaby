package com.wika.wicaby.mobile.player

import android.app.PendingIntent
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.drawable.Icon
import androidx.core.content.ContextCompat
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import com.wika.wicaby.mobile.Lang
import com.wika.wicaby.mobile.MainActivity
import com.wika.wicaby.core.Core
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.session.CacheBitmapLoader
import com.wika.wicaby.mobile.R
import androidx.media3.session.MediaSessionService
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.CommandButton
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import com.wika.wicaby.core.cast.CastController
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.mobile.cast.Casting
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

// Keeps playback alive off screen: Media3 posts the media notification, lock-screen and
// Bluetooth controls, and holds the foreground service while the player plays.
class PlaybackService : MediaSessionService() {
    companion object {
        private const val ACTION_ZAP = "com.wika.wicaby.mobile.ZAP"
        private const val EXTRA_DELTA = "delta"

        /** PiP CH− / CH+ while a channel plays (§8.3); none otherwise. */
        fun pipActions(context: Context): List<RemoteAction> {
            if (!LiveZap.active) return emptyList()
            fun action(delta: Int, icon: Int, label: Int): RemoteAction {
                val text = context.getString(label)
                val pi = PendingIntent.getBroadcast(
                    context, delta + 1, Intent(ACTION_ZAP).setPackage(context.packageName).putExtra(EXTRA_DELTA, delta),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                return RemoteAction(Icon.createWithResource(context, icon), text, text, pi)
            }
            return listOf(
                action(-1, androidx.media3.session.R.drawable.media3_icon_previous, R.string.player_live_previous_channel),
                action(1, androidx.media3.session.R.drawable.media3_icon_next, R.string.player_live_next_channel),
            )
        }
    }

    private var session: MediaSession? = null
    private var castSession: MediaSession? = null
    private val zapReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            LiveZap.press(this@PlaybackService, i.getIntExtra(EXTRA_DELTA, 0))
        }
    }

    // The media notification's button labels in the app language (Android 12 and below).
    override fun attachBaseContext(base: Context) = super.attachBaseContext(Lang.wrap(base))

    override fun onCreate() {
        super.onCreate()
        setMediaNotificationProvider(DefaultMediaNotificationProvider.Builder(this).build().apply { setSmallIcon(R.drawable.ic_stat_wicaby) })
        // PiP actions are PendingIntents of this app: a not-exported receiver gets them.
        ContextCompat.registerReceiver(this, zapReceiver, IntentFilter(ACTION_ZAP), ContextCompat.RECEIVER_NOT_EXPORTED)
        if (PlayerHolder.engine == null && Casting.direct == null) return stopSelf()
        localSession()
    }

    // A direct DLNA cast first (local playback stops it before starting, cast spec §1), else the local player.
    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = Casting.direct?.let(::castSession) ?: localSession()

    // Built when a player exists, again after a cast if the service outlived the previous one.
    private fun localSession(): MediaSession? {
        session?.let { return it }
        val player = PlayerHolder.engine?.player ?: return null
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, PlayerActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        // Music (MU-07): the session activity is the app's now-playing screen while a music session owns the player.
        val nowPlaying = PendingIntent.getActivity(
            this, 2, Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_NOW_PLAYING),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        // Lock-screen and notification art through Core.http (the server's auth, the mesh transport).
        val art = CacheBitmapLoader(DataSourceBitmapLoader.Builder(this).setDataSourceFactory(DefaultDataSource.Factory(this, OkHttpDataSource.Factory(Core.http))).build())
        val s = MediaSession.Builder(this, LivePlayer(player, this)).setSessionActivity(open).setBitmapLoader(art).build()
        player.addListener(object : Player.Listener {
            override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) {
                s.setSessionActivity(if (PlayerHolder.music != null) nowPlaying else open)
            }
        })
        session = s
        PlayerHolder.onRelease {
            s.release()
            if (session === s) session = null
            if (castSession == null) stopSelf()
        }
        return s
    }

    // A direct DLNA cast (CA-08) gets its own session on a player that mirrors the renderer: Media3 then posts the
    // media notification (play/pause, Stop) and holds the foreground service while it plays, with or without an
    // activity, so the cast keeps reporting to the server. It goes once the cast ends (the player turns IDLE).
    private fun castSession(c: CastController): MediaSession? {
        castSession?.let { s -> if ((s.player as RendererPlayer).controller === c) return s }
        if (c.state.value == null) return null
        castSession?.let { it.player.release(); it.release() }
        val player = RendererPlayer(c, getString(com.wika.wicaby.core.R.string.cast_casting_to, c.device.name))
        val stop = CommandButton.Builder(CommandButton.ICON_STOP).setPlayerCommand(Player.COMMAND_STOP)
            .setDisplayName(getString(com.wika.wicaby.core.R.string.cast_stop)).build()
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 1, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val s = MediaSession.Builder(this, player).setId("cast").setMediaButtonPreferences(listOf(stop))
            .apply { open?.let(::setSessionActivity) }.build()
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState != Player.STATE_IDLE) return
                // Not from inside the player's own callback.
                ContextCompat.getMainExecutor(this@PlaybackService).execute {
                    if (castSession !== s) return@execute
                    castSession = null
                    s.release()
                    player.release()
                    if (session == null) stopSelf()
                }
            }
        })
        castSession = s
        return s
    }

    // Swiping the player's task away from Recents ends playback; the main task does not.
    override fun onTaskRemoved(rootIntent: Intent?) {
        if (rootIntent?.component?.className == PlayerActivity::class.java.name || session?.player?.playWhenReady != true) {
            PlayerHolder.release()
            // A direct cast keeps playing and reporting with no activity at all (CA-08).
            if (castSession == null) stopSelf()
        }
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(zapReceiver) }
        session?.release()
        session = null
        castSession?.let { it.player.release(); it.release() }
        castSession = null
        super.onDestroy()
    }
}

/**
 * While a channel plays, next / previous (notification, lock screen, Bluetooth) are CH+ / CH− (§8.3);
 * otherwise the player as is. Listeners hear the widened commands, so the notification shows the buttons.
 */
private class LivePlayer(player: Player, private val context: Context) : ForwardingPlayer(player) {
    private val zaps = intArrayOf(COMMAND_SEEK_TO_NEXT, COMMAND_SEEK_TO_PREVIOUS, COMMAND_SEEK_TO_NEXT_MEDIA_ITEM, COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
    private val wrapped = HashMap<Player.Listener, Player.Listener>()

    override fun getAvailableCommands(): Player.Commands =
        if (LiveZap.active) super.getAvailableCommands().buildUpon().addAll(*zaps).build() else super.getAvailableCommands()

    override fun isCommandAvailable(command: Int) = availableCommands.contains(command)

    override fun addListener(listener: Player.Listener) {
        // A Proxy, not `by` delegation: Kotlin does not forward the listener's Java default methods.
        val w = Proxy.newProxyInstance(Player.Listener::class.java.classLoader, arrayOf(Player.Listener::class.java)) { self, m, args ->
            when (m.name) {
                "onAvailableCommandsChanged" -> listener.onAvailableCommandsChanged(availableCommands)
                "equals" -> self === args?.get(0)
                "hashCode" -> System.identityHashCode(self)
                else -> try {
                    m.invoke(listener, *(args ?: emptyArray()))
                } catch (e: InvocationTargetException) {
                    throw e.targetException
                }
            }
        } as Player.Listener
        wrapped[listener] = w
        super.addListener(w)
    }

    override fun removeListener(listener: Player.Listener) {
        wrapped.remove(listener)?.let { super.removeListener(it) }
    }

    private fun zap(delta: Int) = LiveZap.press(context, delta)

    // Music: the queue's next and previous (repeat, shuffle, the 5 s rule), not the player's window.
    private fun music(delta: Int): Boolean {
        val m = PlayerHolder.music ?: return false
        if (delta > 0) m.next() else m.previous()
        return true
    }

    override fun seekToNext() { if (!zap(1) && !music(1)) super.seekToNext() }
    override fun seekToNextMediaItem() { if (!zap(1) && !music(1)) super.seekToNextMediaItem() }
    override fun seekToPrevious() { if (!zap(-1) && !music(-1)) super.seekToPrevious() }
    override fun seekToPreviousMediaItem() { if (!zap(-1) && !music(-1)) super.seekToPreviousMediaItem() }
}

/**
 * The device of a direct cast (a DLNA renderer, a Google Cast receiver) as a Player, for the cast's MediaSession: what
 * it plays, where, paused or not (CastController's polled state), and play/pause, seek and stop sent back to it.
 * Nothing plays on this device.
 */
@OptIn(UnstableApi::class)
private class RendererPlayer(val controller: CastController, private val where: String) : SimpleBasePlayer(Looper.getMainLooper()) {
    private val scope = MainScope()
    private val target = controller.device.target
    private val commands = Player.Commands.Builder().addAll(
        COMMAND_PLAY_PAUSE, COMMAND_STOP, COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, COMMAND_GET_CURRENT_MEDIA_ITEM,
        COMMAND_GET_TIMELINE, COMMAND_GET_METADATA, COMMAND_RELEASE,
    ).build()

    init {
        scope.launch { controller.state.collect { invalidateState() } }
    }

    override fun getState(): State {
        val b = State.Builder().setAvailableCommands(commands)
        val c = controller.state.value ?: return b.setPlaybackState(STATE_IDLE).build()
        val media = MediaItem.Builder().setMediaId(c.item.id)
            .setMediaMetadata(MediaMetadata.Builder().setTitle(c.item.name).setArtist(where).build()).build()
        val item = MediaItemData.Builder(c.item.id).setMediaItem(media)
            .apply { c.item.runTimeTicks?.let { setDurationUs(it / TICKS_PER_MS * 1000) } }.build()
        return b.setPlaylist(listOf(item)).setCurrentMediaItemIndex(0).setPlaybackState(STATE_READY)
            .setPlayWhenReady(!c.paused, PLAY_WHEN_READY_CHANGE_REASON_REMOTE)
            .setContentPositionMs(PositionSupplier.getExtrapolating(c.positionTicks / TICKS_PER_MS, if (c.paused) 0f else 1f))
            .build()
    }

    // Done once the renderer answered (its new state comes with the next poll).
    private fun send(block: suspend () -> Unit): ListenableFuture<*> {
        val done = SettableFuture.create<Unit>()
        scope.launch {
            runCatching { block() }
            done.set(Unit)
        }
        return done
    }

    override fun handleSetPlayWhenReady(playWhenReady: Boolean) = send { controller.transport(target, if (playWhenReady) "Unpause" else "Pause") }

    override fun handleStop() = send { controller.stop() }

    override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int) = send { controller.transport(target, "Seek", positionMs * TICKS_PER_MS) }

    override fun handleRelease(): ListenableFuture<*> {
        scope.cancel()
        return Futures.immediateVoidFuture()
    }
}
