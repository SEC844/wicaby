package com.wika.wicaby.core.player

import androidx.annotation.StringRes
import com.wika.wicaby.core.R
import kotlinx.serialization.json.JsonPrimitive

// The player's picture format ("Ajuster / Remplir l'écran / Étirer / Zoom"). resizeMode is an
// AspectRatioFrameLayout mode (media3-ui, which :core does not depend on): FIT = 0, FILL = 3,
// ZOOM = 4. scale > 1 enlarges the video view beyond the screen, centred, for the zoom step
// (it crops a letterboxed picture's bars). The choice is remembered at the scope set in Réglages (X-05).
enum class Aspect(val resizeMode: Int, val scale: Float, @StringRes val label: Int) {
    Fit(0, 1f, R.string.aspect_fit),
    Fill(4, 1f, R.string.aspect_fill),
    Stretch(3, 1f, R.string.aspect_stretch),
    Zoom(4, 4f / 3f, R.string.aspect_zoom);

    fun next(): Aspect = entries[(ordinal + 1) % entries.size]

    // Pinch (mobile): spreading goes Fit → Fill → Zoom, pinching goes back to Fit.
    fun pinch(out: Boolean): Aspect = if (!out) Fit else when (this) {
        Fit, Stretch -> Fill
        Fill, Zoom -> Zoom
    }

    companion object {
        // X-05: remembered through ScopedPrefs at the "aspect" scope (per title by default); the
        // per-item, per-process memory it replaces needs no migration.
        fun of(ctx: ScopedPrefs.Ctx?): Aspect =
            ScopedPrefs.recall(ScopedPrefs.ASPECT, ctx)?.let { v -> runCatching { valueOf((v as JsonPrimitive).content) }.getOrNull() } ?: Fit

        fun remember(ctx: ScopedPrefs.Ctx?, a: Aspect) = ScopedPrefs.remember(ScopedPrefs.ASPECT, ctx, JsonPrimitive(a.name))
    }
}
