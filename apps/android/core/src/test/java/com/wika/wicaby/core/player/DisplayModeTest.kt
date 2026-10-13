package com.wika.wicaby.core.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DisplayModeTest {
    private val modes = listOf(
        Mode(1, 3840, 2160, 60f), Mode(2, 3840, 2160, 59.94f), Mode(3, 3840, 2160, 50f),
        Mode(4, 3840, 2160, 24f), Mode(5, 3840, 2160, 23.976f), Mode(6, 3840, 2160, 25f),
        Mode(7, 1920, 1080, 60f), Mode(8, 1920, 1080, 23.976f), Mode(9, 1920, 1080, 50f),
    )
    private val ui = modes[0]

    @Test
    fun filmPrefersExactRate() {
        assertEquals(5, bestMode(modes, ui, 23.976f, 3840, 2160, matchResolution = false)?.id)
        assertEquals(4, bestMode(modes, ui, 24f, 3840, 2160, matchResolution = false)?.id)
    }

    @Test
    fun usesDoubleRateWhenNoSingle() {
        val noFifty = modes.filter { it.id != 3 && it.id != 6 }
        assertNull(bestMode(noFifty, ui, 25f, 1920, 1080, matchResolution = false))
        assertEquals(3, bestMode(modes.filter { it.id != 6 }, ui, 25f, 1920, 1080, matchResolution = false)?.id)
        assertEquals(2, bestMode(modes, ui, 29.97f, 1920, 1080, matchResolution = false)?.id)
    }

    @Test
    fun resolutionMatching() {
        assertEquals(8, bestMode(modes, ui, 23.976f, 1920, 800, matchResolution = true)?.id)
        // 720p content still uses the smallest mode >= 720p.
        assertEquals(9, bestMode(modes, ui, 50f, 1280, 720, matchResolution = true)?.id)
    }

    @Test
    fun noSwitchWhenAlreadyRight() {
        assertNull(bestMode(modes, ui, 60f, 3840, 2160, matchResolution = false))
        assertNull(bestMode(modes, ui, 0f, 3840, 2160, matchResolution = false))
    }
}
