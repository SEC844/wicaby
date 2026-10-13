package com.wika.wicaby.mobile.ui

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.semantics
import kotlin.math.max

// Pinch and double-tap zoom, shared by the comic reader's pages and the photo viewer (photos spec PH-05).
@Stable
class ZoomState {
    var scale by mutableFloatStateOf(1f)
    var offset by mutableStateOf(Offset.Zero)
    val zoomed get() = scale > 1.01f

    fun reset() {
        scale = 1f
        offset = Offset.Zero
    }
}

// The current zoom, for tests and accessibility services.
val ZoomScale = SemanticsPropertyKey<Float>("ZoomScale")

// Content of contentW × contentH px, centred in the box: pinch zooms ×1–×5 around the fingers, a double tap zooms
// ×2.5 to the tapped spot (or back out), and one finger pans only while zoomed, so swipes stay page turns.
fun Modifier.zoomable(state: ZoomState, contentW: Float, contentH: Float, onTap: (Offset) -> Unit = {}, onZoom: (Boolean) -> Unit = {}): Modifier =
    pointerInput(contentW, contentH) {
        val center = Offset(size.width / 2f, size.height / 2f)
        fun clamp(o: Offset, s: Float) = clampPan(o, s, contentW, contentH, size.width, size.height)
        detectTapGestures(
            onDoubleTap = { p ->
                if (state.scale > 1.05f) state.reset() else {
                    state.scale = 2.5f
                    state.offset = clamp((p - center) * (1f - state.scale), state.scale)
                }
                onZoom(state.zoomed)
            },
            onTap = onTap,
        )
    }.pointerInput(contentW, contentH) {
        val center = Offset(size.width / 2f, size.height / 2f)
        fun clamp(o: Offset, s: Float) = clampPan(o, s, contentW, contentH, size.width, size.height)
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false)
            do {
                val ev = awaitPointerEvent()
                val fingers = ev.changes.count { it.pressed }
                if (fingers >= 2 || state.zoomed) {
                    val ns = (state.scale * ev.calculateZoom()).coerceIn(1f, 5f)
                    val c = ev.calculateCentroid(useCurrent = true)
                    if (c != Offset.Unspecified) {
                        // Keep the content under the fingers in place while scaling.
                        val anchor = c - center
                        state.offset = clamp(anchor - (anchor - state.offset) * (ns / state.scale) + ev.calculatePan(), ns)
                    }
                    state.scale = ns
                    if (!state.zoomed) state.offset = Offset.Zero
                    onZoom(state.zoomed)
                    ev.changes.forEach { if (it.positionChanged()) it.consume() }
                }
            } while (ev.changes.any { it.pressed })
        }
    }.semantics { this[ZoomScale] = state.scale }.graphicsLayer {
        scaleX = state.scale
        scaleY = state.scale
        translationX = state.offset.x
        translationY = state.offset.y
    }

// The pan that keeps the zoomed content covering the box.
private fun clampPan(o: Offset, s: Float, contentW: Float, contentH: Float, w: Int, h: Int): Offset {
    val mx = max(0f, (contentW * s - w) / 2)
    val my = max(0f, (contentH * s - h) / 2)
    return Offset(o.x.coerceIn(-mx, mx), o.y.coerceIn(-my, my))
}
