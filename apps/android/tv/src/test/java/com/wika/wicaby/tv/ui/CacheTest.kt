package com.wika.wicaby.tv.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class CacheTest {
    @Before
    fun clear() = Cache.map.clear()

    // rememberLoad keys its LaunchedEffect on Cache.version: each change must move it.
    @Test
    fun changedBumpsVersion() {
        val before = Cache.version
        Cache.changed()
        assertEquals(before + 1, Cache.version)
        Cache.changed()
        assertEquals(before + 2, Cache.version)
    }

    @Test
    fun mapKeepsTheMostRecentlyUsed() {
        for (i in 0 until Cache.MAX) Cache.map["k$i"] = i
        Cache.map["k0"] // read: k0 becomes the newest, k1 the eldest
        Cache.map["new"] = -1
        assertEquals(Cache.MAX, Cache.map.size)
        assertTrue("k0" in Cache.map)
        assertFalse("k1" in Cache.map)
        assertTrue("new" in Cache.map)
    }
}
