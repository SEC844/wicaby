package com.wika.wicaby.mobile

import android.Manifest
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.widget.Toast
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.livetv.Reminders
import com.wika.wicaby.mobile.cast.RemotePlayNotification
import com.wika.wicaby.core.livetv.liveLinkQuery
import com.wika.wicaby.core.livetv.resolveLiveLink
import com.wika.wicaby.mobile.ui.WicabyRoot
import com.wika.wicaby.mobile.ui.livetv.LiveRepos
import com.wika.wicaby.mobile.ui.livetv.tune
import kotlinx.coroutines.launch

// AppCompatActivity: AppCompatDelegate.setApplicationLocales relocalizes it below Android 13 too.
class MainActivity : AppCompatActivity() {
    companion object {
        const val ACTION_NOW_PLAYING = "com.wika.wicaby.mobile.NOW_PLAYING"
    }

    // Android 13+: asked when the first Live TV reminder is set; refused, reminders stay in-app.
    private val askNotify = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (!ok) Toast.makeText(this, com.wika.wicaby.core.R.string.player_live_reminder_permission, Toast.LENGTH_LONG).show()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Always dark: light status-bar icons over the graphite background and artwork.
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        // Debug builds: plex.tv at the loopback mock (tools/mock-server/mock-plex.mjs through adb reverse; PlexTv
        // ignores anything but http://127.0.0.1 or localhost, and a release build ignores it).
        if (BuildConfig.DEBUG) intent.getStringExtra("plextv_url")?.let { com.wika.wicaby.core.plex.PlexTv.devBase = it }
        setContent { WicabyRoot() }
        lifecycleScope.launch { Reminders.askPermission.collect { askNotify.launch(Manifest.permission.POST_NOTIFICATIONS) } }
        // "Play on Wicaby" from another app: in place, the player, or a notification in the background (CA-05).
        RemotePlayNotification.install(this)
        if (savedInstanceState == null) openIntent(intent)
    }

    // singleTask: a reminder tapped while the app runs lands here.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openIntent(intent)
    }

    private fun openIntent(intent: Intent) {
        // "Lire" on the remote Play notification.
        if (intent.action == RemotePlayNotification.ACTION_PLAY) {
            intent.action = null
            RemotePlayNotification.accept(this)
        } else if (intent.action == ACTION_NOW_PLAYING) {
            // The music notification or lock screen (PlaybackService's session activity while music plays).
            intent.action = null
            com.wika.wicaby.mobile.music.NowPlaying.open = true
        } else openLiveLink(intent)
    }

    // wicaby://live?channel=…&server=… (reminder notification, §9.6): on a cold start Core.api and the
    // channels arrive a moment later, so resolveLiveLink retries (F3).
    private fun openLiveLink(intent: Intent) {
        val (channel, server) = intent.data?.let(::liveLinkQuery) ?: return
        intent.data = null
        lifecycleScope.launch {
            resolveLiveLink(channel) { Core.api?.takeIf { server == null || it.server.id == server }?.let { LiveRepos.of(this@MainActivity, it) } }
                ?.let { (repo, row) -> tune(this@MainActivity, repo, row.id) }
        }
    }
}
