package com.wika.wicaby.core.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// B10: Home's own reload triggers, on a fake clock.
class HomeRefreshTest {
    private var t = 0L
    private val r = HomeRefresh { t }

    @Test
    fun comingBackReloadsButNotTheFirstShow() {
        assertFalse(r.shown())
        t = 5_000
        assertTrue(r.shown())
        assertTrue(r.shown())
    }

    @Test
    fun serverChangesAreDebouncedAndSpaced() {
        t = 60_000
        r.onMessage("SessionsStart")
        t += 10_000
        assertFalse("other messages do nothing", r.due())
        r.onMessage("UserDataChanged")
        t += 1_000
        r.onMessage("LibraryChanged")
        assertFalse("2 s debounce", r.due())
        t += 1_000
        assertTrue(r.due())
        assertFalse("one reload per burst", r.due())
        // Another device playing: one UserDataChanged per progress report, one reload per 30 s at most.
        t += 2_000
        r.onMessage("UserDataChanged")
        t += 10_000
        assertFalse(r.due())
        t += 18_000
        assertTrue("held, not lost", r.due())
    }

    @Test
    fun everyFiveMinutesWhileOnShow() {
        t = HomeRefresh.PERIOD_MS - 1
        assertFalse(r.due())
        t += 1
        assertTrue(r.due())
        t += HomeRefresh.PERIOD_MS - 1
        assertFalse(r.due())
        // A return reloads and restarts the period.
        assertFalse(r.shown())
        assertTrue(r.shown())
        t += 1
        assertFalse(r.due())
    }
}
