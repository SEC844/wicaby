package com.wika.wicaby.tv.ui

import androidx.compose.ui.graphics.Color
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ThemeTest {
    @After
    fun reset() {
        C.oled = false
    }

    // Mirrors html[data-theme='oled'] in app.css: true black canvas, darker surfaces, same tokens otherwise.
    @Test
    fun oledSwapsTheCanvasAndSurfaces() {
        C.oled = false
        assertEquals(Color(0xFF0B0B0D), C.bg)
        C.oled = true
        assertEquals(Color.Black, C.bg)
        assertEquals(Color(0xFF0E0E10), C.elevated)
        assertEquals(Color(0xFF161618), C.elevated2)
        // The focus fill must still stand out from the darkest surface.
        assertNotEquals(C.elevated2, C.raised)
    }
}
