package com.wika.wicaby.core.music

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.MediaSource
import com.wika.wicaby.core.data.MediaStream
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.playlistMove
import com.wika.wicaby.core.data.playlistRemove
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

// Music spec MU-01 AC3: the music calls hit each server's routes (§3), Jellyfin's modern user routes included.
class MusicApiTest {
    private lateinit var srv: MockWebServer

    @Before
    fun setUp() {
        srv = MockWebServer().apply { start() }
    }

    @After
    fun tearDown() = srv.close()

    private fun api(kind: String) = Api(Server("srv", "Server", srv.url("/").toString().trimEnd('/'), kind), "dev", "tok", "u1")
    private fun reply(code: Int = 200, body: String = """{"Items":[],"TotalRecordCount":0}""") = srv.enqueue(MockResponse.Builder().code(code).body(body).build())
    private fun asked(): RecordedRequest = srv.takeRequest()
    private fun RecordedRequest.route() = "$method ${url.encodedPath}"

    @Test
    fun browsingRoutes() = runBlocking {
        repeat(4) { reply() }
        api("emby").albums("lib")
        asked().let {
            assertEquals("GET /emby/Users/u1/Items", it.route())
            assertEquals("MusicAlbum", it.url.queryParameter("IncludeItemTypes"))
            assertEquals("lib", it.url.queryParameter("ParentId"))
        }
        api("jellyfin").songs("lib")
        asked().let {
            assertEquals("GET /Items", it.route())
            assertEquals("u1", it.url.queryParameter("userId"))
            assertEquals("Audio", it.url.queryParameter("IncludeItemTypes"))
            assertEquals("Album,ParentIndexNumber,IndexNumber,SortName", it.url.queryParameter("SortBy"))
        }
        api("jellyfin").musicArtists("lib", albumArtistsOnly = true)
        assertEquals("GET /Artists/AlbumArtists", asked().route())
        api("emby").musicArtists("lib", albumArtistsOnly = false)
        asked().let {
            assertEquals("GET /emby/Artists", it.route())
            assertEquals("u1", it.url.queryParameter("UserId"))
        }
    }

    @Test
    fun genresDifferPerServer() = runBlocking {
        repeat(2) { reply() }
        api("emby").musicGenres("lib")
        asked().let {
            assertEquals("GET /emby/MusicGenres", it.route())
            assertEquals("lib", it.url.queryParameter("ParentId"))
        }
        api("jellyfin").musicGenres("lib")
        asked().let {
            assertEquals("GET /Genres", it.route())
            assertEquals("MusicAlbum", it.url.queryParameter("IncludeItemTypes"))
            assertEquals("u1", it.url.queryParameter("userId"))
        }
    }

    @Test
    fun instantMixIsTheItemsRouteOnBoth() = runBlocking {
        repeat(2) { reply() }
        api("emby").instantMix("t1")
        asked().let {
            assertEquals("GET /emby/Items/t1/InstantMix", it.route())
            assertEquals("u1", it.url.queryParameter("UserId"))
            assertEquals("100", it.url.queryParameter("Limit"))
        }
        api("jellyfin").instantMix("ar1", 50)
        asked().let {
            assertEquals("GET /Items/ar1/InstantMix", it.route())
            assertEquals("u1", it.url.queryParameter("userId"))
        }
    }

    @Test
    fun lyricsInEachServersShape() = runBlocking {
        reply(body = """{"Metadata":{"IsSynced":true},"Lyrics":[{"Text":"Ligne 1","Start":10000000},{"Text":"Ligne 2","Start":20000000}]}""")
        val j = api("jellyfin").lyrics(Item("t1", type = "Audio", hasLyrics = true))
        assertEquals("GET /Audio/t1/Lyrics", asked().route()) // Jellyfin's route, never isEmby
        assertEquals(Lyrics(true, listOf(LyricLine(1000, "Ligne 1"), LyricLine(2000, "Ligne 2"))), j)
        // HasLyrics false: no call.
        assertNull(api("jellyfin").lyrics(Item("t2", type = "Audio", hasLyrics = false)))
        // Emby (unverified shape): the lrc stream, Stream.lrc, then Stream.txt after a failure.
        val lrcItem = Item("t3", type = "Audio", mediaSources = listOf(MediaSource("ms3", mediaStreams = listOf(MediaStream(0, "Audio"), MediaStream(1, "Subtitle", codec = "lrc")))))
        reply(body = "[00:01.00]Un\n[00:02.00]Deux\n")
        assertEquals(2, api("emby").lyrics(lrcItem)?.lines?.size)
        assertEquals("GET /emby/Videos/t3/ms3/Subtitles/1/Stream.lrc", asked().route())
        reply(404, "")
        reply(body = "Sans temps\n")
        assertEquals(Lyrics(false, listOf(LyricLine(null, "Sans temps"))), api("emby").lyrics(lrcItem))
        assertEquals("GET /emby/Videos/t3/ms3/Subtitles/1/Stream.lrc", asked().route())
        assertEquals("GET /emby/Videos/t3/ms3/Subtitles/1/Stream.txt", asked().route())
        // No stream, or a failing server: no lyrics, never an error.
        assertNull(api("emby").lyrics(Item("t4", type = "Audio")))
        reply(500, "")
        assertNull(api("jellyfin").lyrics(Item("t5", type = "Audio")))
    }

    @Test
    fun playlistEditsAndSavingTheQueue() = runBlocking {
        reply(204, "")
        api("jellyfin").playlistRemove("p1", listOf("e1", "e2"))
        asked().let {
            assertEquals("DELETE /Playlists/p1/Items", it.route())
            assertEquals("e1,e2", it.url.queryParameter("EntryIds"))
        }
        reply(204, "")
        api("emby").playlistMove("p1", "e2", 0)
        assertEquals("POST /emby/Playlists/p1/Items/e2/Move/0", asked().route())
        reply(body = """{"Id":"p9"}""")
        assertEquals("p9", api("jellyfin").saveQueueAsPlaylist("File", listOf("t1", "t2")))
        asked().let {
            assertEquals("POST /Playlists", it.route())
            assertEquals("t1,t2", it.url.queryParameter("Ids"))
            assertEquals("Audio", it.url.queryParameter("MediaType"))
            assertEquals("""{"Name":"File","Ids":["t1","t2"],"UserId":"u1","MediaType":"Audio"}""", it.body!!.utf8())
        }
    }
}
