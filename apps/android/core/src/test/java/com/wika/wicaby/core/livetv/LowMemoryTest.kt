package com.wika.wicaby.core.livetv

import android.content.ComponentCallbacks2
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// onTrimMemory (spec §21.9): RUNNING_LOW halves the programme LRU; RUNNING_CRITICAL, or the app in
// the background, keeps only the visible set. Units are evicted whole, least recently used first.
@Suppress("DEPRECATION")
class LowMemoryTest {
    private val k = 100_000L

    private fun filled(): GuideCache {
        val c = GuideCache(null, PlatformTuning.TV_LOW, { slabStart(k) }, CoroutineScope(Dispatchers.Unconfined))
        // 40 channels × 2 slabs × 50 programmes = 4,000 programmes (the TV-low LRU is 8,000).
        for (ch in 0 until 40) {
            val id = "c$ch"
            for (s in 0 until 2) {
                val start = slabStart(k + s)
                c.put(id, listOf(k + s), (0 until 50).map { ProgramLite("$id-$s-$it", id, start + it * 60_000L, start + (it + 1) * 60_000L, "P", flags = 0) }, 0)
            }
        }
        return c
    }

    @Test
    fun criticalKeepsOnlyTheVisibleSet() {
        val c = filled()
        assertEquals(4_000, c.programCount)
        val visible = (0 until 5).map { coverageKey("c$it", k) }.toSet()
        c.visible = visible
        c.onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL)
        assertEquals(visible, c.unitKeys)
        assertEquals(250, c.programCount)
    }

    @Test
    fun backgroundKeepsOnlyTheVisibleSet() {
        val c = filled()
        c.visible = setOf(coverageKey("c1", k))
        c.onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN)
        assertEquals(setOf(coverageKey("c1", k)), c.unitKeys)
    }

    @Test
    fun lowHalvesTheLru() {
        val c = filled()
        c.onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW)
        assertEquals(PlatformTuning.TV_LOW.lruPrograms / 2, c.lruCap)
        assertEquals(4_000, c.programCount) // still under the halved cap
        // New units now evict the least recently used ones beyond 4,000 programmes.
        c.put("extra", listOf(k), (0 until 50).map { ProgramLite("x$it", "extra", slabStart(k) + it * 60_000L, slabStart(k) + (it + 1) * 60_000L, "P", flags = 0) }, 0)
        assertTrue(c.programCount <= 4_000)
        assertTrue(coverageKey("extra", k) in c.unitKeys)
        assertTrue("the eldest unit went first", coverageKey("c0", k) !in c.unitKeys)
    }

    @Test
    fun moderateLevelsChangeNothing() {
        val c = filled()
        c.onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE)
        assertEquals(4_000, c.programCount)
        assertEquals(PlatformTuning.TV_LOW.lruPrograms, c.lruCap)
    }
}
