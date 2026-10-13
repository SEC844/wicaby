package com.wika.wicaby.core.player

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Server
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Music stopgap: what an album, an artist, a playlist or a track queues (PlayQueue.tracks), on both servers' /Items.
class MusicQueueTest {
    private val server = MockWebServer().apply {
        repeat(4) { enqueue(MockResponse.Builder().body("""{"Items":[{"Id":"t1"},{"Id":"t2"},{"Id":"../bad"},{"Id":"t3"}],"TotalRecordCount":4}""").build()) }
        start()
    }
    private val api = Api(Server("j", "J", server.url("/").toString().trimEnd('/'), "jellyfin"), "dev", "tok", "u")

    @After
    fun tearDown() = server.close()

    private fun asked() = server.takeRequest().url

    @Test
    fun anAlbumQueuesItsTracksByDiscAndNumber() = runBlocking {
        assertEquals(listOf("t1", "t2", "t3"), PlayQueue.tracks(api, Item("al", type = "MusicAlbum", isFolder = true)))
        val u = asked()
        assertEquals("al", u.queryParameter("ParentId"))
        assertEquals("Audio", u.queryParameter("IncludeItemTypes"))
        assertEquals("true", u.queryParameter("Recursive"))
        assertEquals("ParentIndexNumber,IndexNumber,SortName", u.queryParameter("SortBy"))
    }

    @Test
    fun anArtistQueuesAllTheirTracksByAlbum() = runBlocking {
        PlayQueue.tracks(api, Item("ar", type = "MusicArtist", isFolder = true))
        val u = asked()
        assertEquals("ar", u.queryParameter("ArtistIds"))
        assertNull(u.queryParameter("ParentId"))
        assertEquals("Album,ParentIndexNumber,IndexNumber,SortName", u.queryParameter("SortBy"))
    }

    @Test
    fun aPlaylistKeepsItsOwnOrder() = runBlocking {
        PlayQueue.tracks(api, Item("pl", type = "Playlist", isFolder = true, mediaType = "Audio"))
        val u = asked()
        assertEquals("pl", u.queryParameter("ParentId"))
        assertNull(u.queryParameter("SortBy"))
    }

    @Test
    fun aTrackPlaysOnThroughItsAlbumOrAlone() = runBlocking {
        val track = Item("t2", type = "Audio", mediaType = "Audio", albumId = "al")
        val ids = PlayQueue.tracks(api, track)
        assertEquals("al", asked().queryParameter("ParentId"))
        // The player starts on the track itself, inside its album's queue (playMusic's start).
        assertEquals(1, ids.indexOf(track.id))
        assertEquals(listOf("solo"), PlayQueue.tracks(api, Item("solo", type = "Audio")))
        assertEquals(1, server.requestCount)
        // A queue of tracks moves like any other.
        val q = PlayQueue(ids, ids.indexOf("t2"))
        assertEquals("t3", q.nextId)
    }
}
