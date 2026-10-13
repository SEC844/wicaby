package com.wika.wicaby.core.music

import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.NameId
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

// Music spec MU-13 on Android, against a loopback stand-in for lrclib.net (never the real service): off means not one
// request; on, the query and User-Agent LRCLIB documents, synced lyrics marked lrclib, a 30-day cache per track id
// that keeps "not found" too but never a server error.
class LrcLibTest {
    private lateinit var srv: MockWebServer
    private var on = false
    private var now = 1_000_000L
    private val cache = mutableMapOf<String, String>()
    private var saves = 0

    @Before
    fun setUp() {
        srv = MockWebServer().apply { start() }
    }

    @After
    fun tearDown() = srv.close()

    private fun lib() = LrcLib({ OkHttpClient() }, srv.url("/mock/lrclib").toString().trimEnd('/'), "Wicaby/test", { on }, cache, { saves++ }, { now })

    private val track = Item("t1", name = "Écume", album = "Marée basse", artistItems = listOf(NameId("Les Ondes Calmes", "a1")), runTimeTicks = 250_000_000)
    private val synced = """{"id":1,"trackName":"Écume","instrumental":false,"plainLyrics":"Un\nDeux","syncedLyrics":"[00:00.00]Un\n[00:01.50]Deux"}"""

    private fun reply(code: Int, body: String) = srv.enqueue(MockResponse.Builder().code(code).body(body).build())

    @Test
    fun offSendsNothing() = runBlocking {
        assertNull(lib().lyrics(track))
        assertEquals(0, srv.requestCount)
        assertTrue(cache.isEmpty())
    }

    @Test
    fun onAsksOnceThenCachesThirtyDays() = runBlocking {
        on = true
        reply(200, synced)
        val l = lib().lyrics(track)!!
        assertTrue(l.synced && l.lrclib)
        assertEquals(listOf(LyricLine(0, "Un"), LyricLine(1500, "Deux")), l.lines)
        val req = srv.takeRequest()
        assertEquals("/mock/lrclib/api/get", req.url.encodedPath)
        assertEquals("Les Ondes Calmes", req.url.queryParameter("artist_name"))
        assertEquals("Écume", req.url.queryParameter("track_name"))
        assertEquals("Marée basse", req.url.queryParameter("album_name"))
        assertEquals("25", req.url.queryParameter("duration"))
        assertEquals("Wicaby/test", req.headers["User-Agent"])
        assertEquals(1, saves)
        // Cached: no second request, even a day short of 30.
        now += LrcLib.TTL_MS - 1
        assertEquals(l, lib().lyrics(track))
        assertEquals(1, srv.requestCount)
        // Expired: asked again.
        now += 1
        reply(200, synced)
        lib().lyrics(track)
        assertEquals(2, srv.requestCount)
    }

    @Test
    fun notFoundIsKeptAServerErrorIsNot() = runBlocking {
        on = true
        reply(404, """{"code":404,"name":"TrackNotFound"}""")
        assertNull(lib().lyrics(track))
        assertNull(lib().lyrics(track))
        assertEquals(1, srv.requestCount)
        cache.clear()
        reply(503, "busy")
        assertNull(lib().lyrics(track))
        assertFalse("t1" in cache)
    }

    @Test
    fun instrumentalOrEmptyReadsAsNone() {
        assertEquals("", LrcLib.textOf("""{"instrumental":true,"syncedLyrics":"[00:00.00]x"}"""))
        assertEquals("Un", LrcLib.textOf("""{"syncedLyrics":null,"plainLyrics":"Un"}"""))
        assertEquals("", LrcLib.textOf("not json"))
    }
}
