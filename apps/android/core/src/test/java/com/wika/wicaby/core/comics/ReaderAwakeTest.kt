package com.wika.wicaby.core.comics

import android.app.Activity
import android.view.WindowManager
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import android.os.Looper
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReaderAwakeTest {
    @Test
    fun screenStaysOnUntilIdle() {
        val window = Robolectric.buildActivity(Activity::class.java).setup().get().window
        fun on() = window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0
        val awake = ReaderAwake(window, idleMs = 1_000)
        awake.poke()
        assertTrue(on())
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(800))
        awake.poke() // a page turn re-arms the delay
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(800))
        assertTrue(on())
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(300))
        assertFalse(on())
    }
}
