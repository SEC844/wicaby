package com.wika.wicaby.tv

import android.service.dreams.DreamService
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ComposeView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Profiles
import com.wika.wicaby.core.data.SessionGate
import com.wika.wicaby.core.data.Snapshot
import com.wika.wicaby.tv.ui.Accents
import com.wika.wicaby.tv.ui.Screensaver
import com.wika.wicaby.tv.ui.WicabyTheme

// TP-10: the backdrops of the session the app opened ("Who is watching?" resolved), or of the TV's lone account without
// a PIN; else none (black): the screensaver must not show a locked account's library.
fun dreamApi(s: Snapshot): Api? =
    (SessionGate.active(s.session) ?: s.session?.takeIf { Profiles.skipPicker(s) })?.let { Api(it.server, s.deviceId, it.token, it.userId) }

// The system screen saver (Settings > Device preferences > Screen saver > Wicaby): the in-app
// backdrop slideshow, for the signed-in user. Signed out, it stays black.
// A DreamService is no activity: Compose needs the lifecycle and saved-state owners set by hand.
class Dream : DreamService(), SavedStateRegistryOwner {
    private val registry = LifecycleRegistry(this)
    private val saved = SavedStateRegistryController.create(this)
    override val lifecycle: Lifecycle get() = registry
    override val savedStateRegistry get() = saved.savedStateRegistry

    override fun onCreate() {
        super.onCreate()
        saved.performRestore(null)
        registry.currentState = Lifecycle.State.CREATED
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        isInteractive = false
        isFullscreen = true
        setContentView(
            ComposeView(this).apply {
                setViewTreeLifecycleOwner(this@Dream)
                setViewTreeSavedStateRegistryOwner(this@Dream)
                setContent {
                    val snap by produceState<Snapshot?>(null) { value = Wicaby.app.prefs.current() }
                    val api = remember(snap) { snap?.let(::dreamApi) }
                    TvCanvas {
                        WicabyTheme(Accents[(snap?.accent ?: 0).coerceIn(Accents.indices)]) {
                            if (api != null) Screensaver(api) else Box(Modifier.fillMaxSize().background(Color.Black))
                        }
                    }
                }
            },
        )
    }

    override fun onDreamingStarted() {
        super.onDreamingStarted()
        registry.currentState = Lifecycle.State.RESUMED
    }

    override fun onDreamingStopped() {
        registry.currentState = Lifecycle.State.CREATED
        super.onDreamingStopped()
    }

    override fun onDestroy() {
        registry.currentState = Lifecycle.State.DESTROYED
        super.onDestroy()
    }
}
