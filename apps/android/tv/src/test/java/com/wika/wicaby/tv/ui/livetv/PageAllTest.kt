package com.wika.wicaby.tv.ui.livetv

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class PageAllTest {
    private fun item(i: Int) = JsonObject(mapOf("Id" to JsonPrimitive("r$i")))
    private fun page(items: List<JsonObject>, total: Int?) =
        JsonObject(buildMap { put("Items", JsonArray(items)); if (total != null) put("TotalRecordCount", JsonPrimitive(total)) })

    @Test
    fun pagesUntilTheTotal() = runBlocking {
        val starts = mutableListOf<Int>()
        val got = pageAll(size = 2) { s -> starts += s; page((s until minOf(s + 2, 4)).map(::item), if (s == 0) 4 else null) }
        assertEquals(4, got.size)
        assertEquals(listOf(0, 2), starts)
    }

    // Plex's route answers everything whatever StartIndex says: the loop used to never end with 500+ recordings.
    @Test
    fun routeIgnoringStartIndexEnds() = runBlocking {
        var calls = 0
        assertEquals(3, pageAll(size = 2) { calls++; page((0 until 3).map(::item), 3) }.size)
        assertEquals(1, calls)
        calls = 0
        assertEquals(3, pageAll(size = 2) { calls++; page((0 until 3).map(::item), null) }.size)
        assertEquals(2, calls)
        calls = 0
        pageAll(size = 2, maxPages = 5) { s -> calls++; page(listOf(item(s), item(s + 1)), null) }
        assertEquals(5, calls)
    }
}
