package com.wika.wicaby.core.data

import com.wika.wicaby.core.Core
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

// The A–Z rail: letters of names, and each letter's offset from the server's "sorts before" counts.
class LetterIndexTest {
    private var server: MockWebServer? = null

    @After
    fun tearDown() {
        server?.close()
        Core.api = null
    }

    @Test
    fun lettersFoldAccentsAndSendTheRestToHash() {
        assertEquals('E', LetterIndex.letterOf("Été indien"))
        assertEquals('E', LetterIndex.letterOf("être"))
        assertEquals('C', LetterIndex.letterOf("Ça"))
        assertEquals('O', LetterIndex.letterOf("Œil"))
        assertEquals('A', LetterIndex.letterOf("  alien"))
        assertEquals('#', LetterIndex.letterOf("2001"))
        assertEquals('#', LetterIndex.letterOf("[REC]"))
        assertEquals('#', LetterIndex.letterOf("Ωmega"))
        assertEquals('#', LetterIndex.letterOf(""))
        assertEquals('#', LetterIndex.letterOf(null))
        assertEquals(0, LetterIndex.indexOf('#'))
        assertEquals(26, LetterIndex.indexOf('Z'))
    }

    // Sorted: "2001", "[rec]", "alien", "avatar", "brazil", "zodiac", "été" (past 'z' when the server does not fold).
    private val sorted = listOf("2001", "[rec]", "alien", "avatar", "brazil", "zodiac", "été")
    private fun before(b: String) = sorted.count { it < b }

    @Test
    fun offsetsComeFromTheCountsBeforeEachLetter() {
        val o = LetterIndex.offsets(LetterIndex.bounds.map(::before))
        assertEquals(0, o[0]) // '#'
        assertEquals(2, o[LetterIndex.indexOf('A')])
        assertEquals(4, o[LetterIndex.indexOf('B')])
        assertEquals(5, o[LetterIndex.indexOf('Z')])
        assertEquals(-1, o[LetterIndex.indexOf('C')])
        // "été" sorts past 'z' here: no letter holds it, Z ends before it.
        assertEquals(listOf('#', 'A', 'B', 'Z'), o.indices.filter { o[it] >= 0 }.map { LetterIndex.LETTERS[it] })
        // No digits: no '#'.
        assertEquals(-1, LetterIndex.offsets(LetterIndex.bounds.map { b -> sorted.drop(2).count { it < b } })[0])
    }

    @Test
    fun letterAtAndNextSkipEmptyLetters() {
        val o = LetterIndex.offsets(LetterIndex.bounds.map(::before))
        assertEquals(0, LetterIndex.letterAt(o, 1))
        assertEquals(LetterIndex.indexOf('A'), LetterIndex.letterAt(o, 3))
        assertEquals(LetterIndex.indexOf('B'), LetterIndex.letterAt(o, 4))
        assertEquals(LetterIndex.indexOf('Z'), LetterIndex.letterAt(o, 6))
        assertEquals(LetterIndex.indexOf('Z'), LetterIndex.next(o, LetterIndex.indexOf('B'), 1))
        assertEquals(LetterIndex.indexOf('A'), LetterIndex.next(o, LetterIndex.indexOf('B'), -1))
        assertEquals("the last letter stays", LetterIndex.indexOf('Z'), LetterIndex.next(o, LetterIndex.indexOf('Z'), 1))
        assertEquals(0, LetterIndex.next(o, 0, -1))
    }

    @Test
    fun theRailOpensOnTheItemsOwnLetterWhenTheServerSortsItThere() {
        val o = LetterIndex.offsets(LetterIndex.bounds.map(::before))
        assertEquals(LetterIndex.indexOf('A'), LetterIndex.entry(o, 2, "Alien"))
        // "The Brazil" sorted as "brazil": B, not T.
        assertEquals(LetterIndex.indexOf('B'), LetterIndex.entry(o, 4, "The Brazil"))
        // "Été" past 'z' on this server: the letter its offset falls in.
        assertEquals(LetterIndex.indexOf('Z'), LetterIndex.entry(o, 6, "Été"))
        assertEquals(0, LetterIndex.entry(o, 0, "2001"))
    }

    // One count per bound, with the grid's filters, without loading any item.
    @Test
    fun loadAsksCountsOnly() = runBlocking {
        val asked = java.util.Collections.synchronizedList(mutableListOf<RecordedRequest>())
        server = MockWebServer().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    asked += request
                    val b = request.url.queryParameter("NameLessThan")!!
                    return MockResponse.Builder().body("""{"Items":[],"TotalRecordCount":${before(b)}}""").build()
                }
            }
            start()
        }
        val api = Api(Server("j", "J", server!!.url("/").toString().trimEnd('/'), "jellyfin"), "dev", "t", "u")
        val o = LetterIndex.load(api, "ParentId" to "lib", "IncludeItemTypes" to "Movie", "Recursive" to true)
        assertArrayEquals(LetterIndex.offsets(LetterIndex.bounds.map(::before)), o)
        assertEquals(27, asked.size)
        for (r in asked) {
            assertEquals("0", r.url.queryParameter("Limit"))
            assertEquals("lib", r.url.queryParameter("ParentId"))
            assertEquals("Movie", r.url.queryParameter("IncludeItemTypes"))
        }
    }
}
