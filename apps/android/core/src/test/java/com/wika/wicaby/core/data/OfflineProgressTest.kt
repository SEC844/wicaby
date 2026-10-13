package com.wika.wicaby.core.data

import org.junit.Assert.assertEquals
import org.junit.Test

class OfflineProgressTest {
    private fun p(item: String, pos: Long, at: Long, user: String = "u") = PendingProgress("s", user, item, pos, false, at)

    @Test
    fun latestWatchWinsPerItem() {
        var list = mergePending(emptyList(), p("a", 10, 100))
        list = mergePending(list, p("b", 5, 110))
        list = mergePending(list, p("a", 50, 120))
        assertEquals(listOf("b" to 5L, "a" to 50L), list.map { it.itemId to it.positionTicks })
    }

    @Test
    fun olderEntryDoesNotOverwrite() {
        val list = mergePending(listOf(p("a", 50, 200)), p("a", 10, 100))
        assertEquals(50L, list.single().positionTicks)
    }

    @Test
    fun usersAreSeparate() {
        val list = mergePending(listOf(p("a", 50, 200, user = "u1")), p("a", 10, 300, user = "u2"))
        assertEquals(2, list.size)
    }

    @Test
    fun isoIsUtc() {
        assertEquals("1970-01-01T00:00:01.500Z", isoUtc(1_500))
    }
}
