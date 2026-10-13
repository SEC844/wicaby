package com.wika.wicaby.tv

import android.app.Activity
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.os.Build
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Density
import androidx.compose.ui.platform.LocalDensity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

// Phones and tablets get the TV layout too: landscape, full screen, scaled to fit.
val isTv: Boolean by lazy { Wicaby.app.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK) }

fun ComponentActivity.goFullscreen() {
    enableEdgeToEdge()
    // Draw into the notch/punch-hole area too.
    if (Build.VERSION.SDK_INT >= 28) {
        window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= 30) WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }
    if (!isTv) requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    hideSystemBars()
}

// The system shows the bars again after dialogs, the IME or a swipe: call on every focus regain.
fun Activity.hideSystemBars() {
    WindowCompat.getInsetsController(window, window.decorView).apply {
        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        hide(WindowInsetsCompat.Type.systemBars())
    }
}

// The UI is drawn for a 960x540 dp TV canvas. Off TV, scale density so the shorter fit
// is exactly that; a 20:9 phone then gets a wider canvas instead of letterboxing.
@Composable
fun TvCanvas(content: @Composable () -> Unit) {
    if (isTv) return content()
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val scale = minOf(constraints.maxWidth / 960f, constraints.maxHeight / 540f)
        if (scale <= 0f || constraints.maxWidth == Int.MAX_VALUE) return@BoxWithConstraints content()
        CompositionLocalProvider(LocalDensity provides Density(scale, LocalDensity.current.fontScale)) { content() }
    }
}
