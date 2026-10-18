package com.wika.wicaby.tv.ui

import androidx.compose.ui.graphics.Color
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ThemeTest {
    @After
    fun reset() {
        C.theme = "graphite"
    }

    // Mirrors html[data-theme='oled'] (packages/tokens/tokens.json): true black canvas, darker surfaces, same tokens otherwise.
    @Test
    fun oledSwapsTheCanvasAndSurfaces() {
        C.theme = "graphite"
        assertEquals(Color(0xFF0B0B0D), C.bg)
        C.theme = "oled"
        assertEquals(Color.Black, C.bg)
        assertEquals(Color(0xFF0E0E10), C.elevated)
        assertEquals(Color(0xFF161618), C.elevated2)
        // The focus fill must still stand out from the darkest surface.
        assertNotEquals(C.elevated2, C.raised)
    }

    // onAccent reads the generated per-accent flag: dark content on orange, green and graphite only.
    @Test
    fun onAccentKeepsDarkContentOnLightAccents() {
        val w = Color.White
        val b = Color.Black
        assertEquals(listOf(w, w, w, w, w, b, b, b), Accents.map(::onAccent))
        assertEquals(Color.White, onAccent(Color(0xFF123456)))
    }

    // A synced or stale id the TV does not offer (light, unknown) reads as graphite.
    @Test
    fun lightAndUnknownThemesFallBackToGraphite() {
        C.theme = "light"
        assertEquals(Color(0xFF0B0B0D), C.bg)
        C.theme = "nope"
        assertEquals(Color(0xFF0B0B0D), C.bg)
        C.theme = "cinema"
        assertEquals(Color(0xFF0E0C0A), C.bg)
    }

    // High contrast: black content on every accent, its tones the accessible ones.
    @Test
    fun contrastPutsBlackOnEveryAccent() {
        C.theme = "contrast"
        assertEquals(List(8) { Color.Black }, Accents.map(::onAccent))
        assertEquals(Color(0xFF409CFF), Accents[0])
    }

    // The inverted focus pair is the exact white and black the screens were written with.
    @Test
    fun tvFocusIsWhiteOnBlack() {
        assertEquals(Color.White, TvFocus.bg)
        assertEquals(Color.Black, TvFocus.fg)
    }
}
