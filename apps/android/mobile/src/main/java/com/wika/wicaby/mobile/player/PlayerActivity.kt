package com.wika.wicaby.mobile.player

import android.app.PictureInPictureParams
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.util.Rational
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.player.ExternalPlayer
import com.wika.wicaby.mobile.ui.Cache
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.accentOf
import com.wika.wicaby.mobile.ui.WicabyTheme
import kotlinx.coroutines.launch

class PlayerActivity : AppCompatActivity() {
    companion object {
        private const val EXTRA_ID = "id"
        private const val EXTRA_FROM_START = "fromStart"
        private const val EXTRA_TRAILER = "trailer"
        private const val EXTRA_SERVER = "server"

        // trailer: a local trailer, played from the start without reporting anything.
        // server: TP-06, an extra server's id (null = the primary one).
        fun start(context: Context, id: String, fromStart: Boolean, trailer: Boolean = false, server: String? = null) {
            context.startActivity(
                Intent(context, PlayerActivity::class.java)
                    .putExtra(EXTRA_ID, id)
                    .putExtra(EXTRA_SERVER, server)
                    .putExtra(EXTRA_FROM_START, fromStart)
                    .putExtra(EXTRA_TRAILER, trailer)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }

    private var inPip by mutableStateOf(false)
    private var controller: ListenableFuture<MediaController>? = null
    private val listener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            // Screen on only while frames are actually moving.
            if (isPlaying) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            updatePip()
        }

        override fun onVideoSizeChanged(videoSize: VideoSize) = updatePip()
    }

    // "Lecteur externe" after a playback error: this activity waits for the other app, then saves
    // the position it hands back and closes. If Android killed our process meanwhile, the
    // recreated activity only waits for the result and refetches the item (onSaveInstanceState).
    private var externalId: String? = null
    private var externalItem: Item? = null
    // TP-06: the item's server, so the position goes back to the server it came from.
    private var externalServer: String? = null
    private val externalPlayer = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val id = externalId
        val server = externalServer
        val known = externalItem?.takeIf { it.id == id }
        if (id != null) Core.scope.launch {
            val api = (if (server != null) com.wika.wicaby.mobile.ui.savedApi(server) else Core.api) ?: return@launch
            val item = known ?: runCatching { api.item(id) }.getOrNull() ?: return@launch
            if (ExternalPlayer.report(api, item, r.data)) Cache.invalidateHome()
        }
        finish()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString("externalId", externalId)
        outState.putString("externalServer", externalServer)
    }

    // Stops our playback (its Stopped report goes first), then hands the item over from where it was.
    private fun openExternal() {
        val pb = PlayerHolder.playback ?: return
        val api = pb.api
        val item = pb.item ?: return
        val intent = ExternalPlayer.intent(this, api, item, pb.player.currentPosition.takeIf { it > 0 } ?: item.resumeMs)
        PlayerHolder.release()
        externalId = item.id
        externalItem = item
        externalServer = api.server.id
        if (runCatching { externalPlayer.launch(intent) }.isFailure) finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // Recreated while the external player was open: do not start playback again.
        externalId = savedInstanceState?.getString("externalId")
        externalServer = savedInstanceState?.getString("externalServer")
        if (externalId != null) return
        if (!handle(intent)) return finish()
        // USER_: both landscapes follow the sensor only while the system rotation lock is off (B45).
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE
        if (Build.VERSION.SDK_INT >= 28) {
            window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
        }
        immersive()
        val player = PlayerHolder.engine!!.player
        player.addListener(listener)
        listener.onIsPlayingChanged(player.isPlaying)
        // Binding a controller starts PlaybackService, which owns the notification and lock-screen controls.
        controller = MediaController.Builder(this, SessionToken(this, ComponentName(this, PlaybackService::class.java))).buildAsync()
        val canExternal = Core.api?.let { ExternalPlayer.available(this, it) } == true
        setContent {
            val snap by Core.prefs.data.collectAsState(null)
            WicabyTheme(accentOf(snap?.accent ?: 0)) {
                val pb = PlayerHolder.playback
                val engine = PlayerHolder.engine
                // Not for a trailer (nothing to report) nor a downloaded copy (no server link to hand over).
                val external = (::openExternal).takeIf { canExternal && pb != null && !pb.trailer && !pb.offline }
                if (pb != null && engine != null) PlayerScreen(pb, engine, inPip, onExit = ::exit, onPip = ::enterPip, onExternal = external)
            }
        }
    }

    // A new item (Lire elsewhere while in PiP), or nothing when reopened from the notification.
    private fun handle(intent: Intent): Boolean {
        val id = intent.getStringExtra(EXTRA_ID)
        intent.removeExtra(EXTRA_ID)
        if (id == null) return PlayerHolder.playback != null
        val server = intent.getStringExtra(EXTRA_SERVER)
        val api = (if (server != null) Servers.extraOf(server) else Core.api) ?: return false
        if (PlayerHolder.playback?.itemId == id && intent.getBooleanExtra(EXTRA_FROM_START, false).not()) return true
        PlayerHolder.start(this, api, id, intent.getBooleanExtra(EXTRA_FROM_START, false), intent.getBooleanExtra(EXTRA_TRAILER, false))
        return true
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun immersive() {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    private fun pipParams(): PictureInPictureParams {
        val player = PlayerHolder.engine?.player
        val size = player?.videoSize
        // PiP accepts 1:2.39 .. 2.39:1.
        val ratio = if (size != null && size.width > 0 && size.height > 0) {
            Rational(size.width, size.height).let { r -> if (r.toFloat() > 2.39f) Rational(239, 100) else if (r.toFloat() < 0.42f) Rational(100, 239) else r }
        } else Rational(16, 9)
        // Live: CH− / CH+ in the PiP window (M-2).
        return PictureInPictureParams.Builder().setAspectRatio(ratio).setActions(PlaybackService.pipActions(this)).apply {
            // Android 12+: going Home while playing slides into PiP on its own.
            if (Build.VERSION.SDK_INT >= 31) {
                setAutoEnterEnabled(player?.isPlaying == true)
                setSeamlessResizeEnabled(true)
            }
        }.build()
    }

    private fun updatePip() {
        if (packageManager.hasSystemFeature("android.software.picture_in_picture")) runCatching { setPictureInPictureParams(pipParams()) }
    }

    private fun enterPip() {
        runCatching { enterPictureInPictureMode(pipParams()) }
    }

    // Before Android 12 there is no auto-enter: do it when the user leaves with Home.
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT < 31 && PlayerHolder.engine?.player?.isPlaying == true) enterPip()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        inPip = isInPictureInPictureMode
    }

    override fun onStart() {
        super.onStart()
        PlayerHolder.visible = true
        G.mediaStarted++
    }

    override fun onStop() {
        super.onStop()
        PlayerHolder.visible = false
        G.mediaStarted = (G.mediaStarted - 1).coerceAtLeast(0)
        // Stopped in PiP with the screen on = the PiP window was dismissed: end playback. Locking
        // the phone in PiP stops the activity too, with the screen off: playback goes on.
        if (inPip && getSystemService(PowerManager::class.java).isInteractive) exit()
        // Live video does not hold a tuner in the background; radio keeps playing (F6).
        else if (!isChangingConfigurations && PlayerHolder.playback?.liveState?.radio == false) exit()
    }

    private fun exit() {
        PlayerHolder.release()
        finish()
    }

    override fun onDestroy() {
        PlayerHolder.engine?.player?.removeListener(listener)
        controller?.let { MediaController.releaseFuture(it) }
        if (isFinishing && !isChangingConfigurations && PlayerHolder.playback != null && PlayerHolder.engine?.player?.playWhenReady != true) PlayerHolder.release()
        super.onDestroy()
    }
}
