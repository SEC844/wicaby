package com.wika.wicaby.tv.data

import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.Item
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class HomeChannelsTest {
    @Test
    fun itemsAreCappedToTheChannelSize() {
        val items = List(30) { Item(id = "i$it") }
        assertEquals(items.take(HomeChannels.SIZE), shown(Result.success(items)))
    }

    @Test
    fun emptyListKeepsTheChannel() {
        assertEquals(emptyList<Item>(), shown(Result.success(emptyList())))
        assertFalse(missing(Result.success(emptyList())))
    }

    @Test
    fun onlyMissingEndpointDeletesTheChannel() {
        val notFound = Result.failure<List<Item>>(ApiException("Not found", 404))
        assertTrue(missing(notFound))
        assertNull(shown(notFound))
    }

    @Test
    fun otherFailuresKeepTheChannelAsItIs() {
        for (r in listOf(Result.failure<List<Item>>(ApiException("busy", 503)), Result.failure(IOException("offline")))) {
            assertNull(shown(r))
            assertFalse(missing(r))
        }
    }
}
