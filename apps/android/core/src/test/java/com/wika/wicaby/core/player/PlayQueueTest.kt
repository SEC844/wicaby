package com.wika.wicaby.core.player

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// TP-04: the queue model (desktop play-queue.ts): splice, jump, remove.
class PlayQueueTest {
    @Test
    fun playNextGoesAfterTheCurrentEntryAndLastAtTheEnd() {
        val q = PlayQueue(listOf("a", "b", "c"), startIndex = 1)
        q.add(next = true, listOf("x", "y"))
        q.add(next = false, listOf("z"))
        assertEquals(listOf("a", "b", "x", "y", "c", "z"), q.ids)
        assertEquals("b", q.id)
        assertEquals("x", q.nextId)
    }

    @Test
    fun jumpAndEnd() {
        val q = PlayQueue(listOf("a", "b"))
        assertNull(q.jump(5))
        assertEquals("b", q.jump(1))
        assertEquals(1, q.index)
        assertNull(q.nextId)
    }

    @Test
    fun removeKeepsTheCurrentEntry() {
        val q = PlayQueue(listOf("a", "b", "c", "d"), startIndex = 2)
        assertFalse(q.remove(2))
        assertFalse(q.remove(9))
        assertTrue(q.remove(0))
        assertEquals("c", q.id)
        assertEquals(1, q.index)
        assertTrue(q.remove(2))
        assertEquals(listOf("b", "c"), q.ids)
        assertNull(q.nextId)
    }

    // Desktop lib/queue.svelte.ts shuffle(): same query; ids that cannot go into a URL are dropped.
    @Test
    fun shuffleAsksForEverythingPlayableUnderTheParent() = runBlocking {
        MockWebServer().use { srv ->
            srv.start()
            srv.enqueue(MockResponse.Builder().code(200).body("""{"Items":[{"Id":"e1","Name":"A"},{"Id":"../x","Name":"B"},{"Id":"e2","Name":"C"}],"TotalRecordCount":3}""").build())
            val api = Api(Server("srv", "Server", srv.url("/").toString().trimEnd('/'), "emby"), "dev", "tok", "u1")
            assertEquals(setOf("e1", "e2"), PlayQueue.shuffle(api, "s1").toSet())
            val url = srv.takeRequest().url
            assertEquals("/emby/Users/u1/Items", url.encodedPath)
            assertEquals("s1", url.queryParameter("ParentId"))
            assertEquals("true", url.queryParameter("Recursive"))
            assertEquals("Movie,Episode,Video,MusicVideo,Audio", url.queryParameter("IncludeItemTypes"))
            assertEquals("Random", url.queryParameter("SortBy"))
            assertEquals("500", url.queryParameter("Limit"))
        }
    }

    @Test
    fun startIndexIsClamped() {
        assertEquals(1, PlayQueue(listOf("a", "b"), startIndex = 7).index)
        assertNull(PlayQueue(emptyList()).id)
    }
}
