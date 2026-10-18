package com.wika.wicaby.mobile.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class MediaHoldTest {
    // A finishing player stops counting in onPause; its later onStop must not count down a second time.
    @Test
    fun stopIsCountedOnce() {
        val before = G.mediaStarted
        val player = G.MediaHold()
        val reader = G.MediaHold()
        player.start()
        reader.start()
        player.start()
        assertEquals(before + 2, G.mediaStarted)
        player.stop() // onPause, finishing
        player.stop() // onStop
        assertEquals(before + 1, G.mediaStarted)
        reader.stop()
        assertEquals(before, G.mediaStarted)
    }
}
