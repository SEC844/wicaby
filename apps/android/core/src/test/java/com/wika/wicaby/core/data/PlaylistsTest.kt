package com.wika.wicaby.core.data

import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

// "Ajouter à une playlist / collection": the routes desktop calls, on both flavours.
class PlaylistsTest {
    private lateinit var srv: MockWebServer

    @Before
    fun setUp() {
        srv = MockWebServer().apply { start() }
    }

    @After
    fun tearDown() = srv.close()

    private fun api(kind: String) = Api(Server("srv", "Server", srv.url("/").toString().trimEnd('/'), kind), "dev", "tok", "u1")

    private fun reply(code: Int, body: String = "") = srv.enqueue(MockResponse.Builder().code(code).body(body).build())

    private val movie = Item("m1", type = "Movie")
    private val song = Item("a1", type = "Audio")

    @Test
    fun menuEntriesFollowDesktop() {
        assertTrue(Playlists.accepts(ListKind.Playlist, Item("e", type = "Episode")))
        assertFalse(Playlists.accepts(ListKind.Collection, Item("e", type = "Episode")))
        assertTrue(Playlists.accepts(ListKind.Collection, Item("b", type = "Book")))
        assertFalse(Playlists.accepts(ListKind.Playlist, Item("b", type = "Book")))
    }

    @Test
    fun playlistsOfAnotherMediaTypeAreLeftOut() {
        val all = listOf(Item("v", type = "Playlist", mediaType = "Video"), Item("a", type = "Playlist", mediaType = "Audio"), Item("n", type = "Playlist"))
        assertEquals(listOf("v", "n"), Playlists.targetsFor(ListKind.Playlist, movie, all).map { it.id })
        assertEquals(listOf("a", "n"), Playlists.targetsFor(ListKind.Playlist, song, all).map { it.id })
        assertEquals(3, Playlists.targetsFor(ListKind.Collection, movie, all).size)
    }

    @Test
    fun listsAskForTheRightType() = runBlocking {
        reply(200, """{"Items":[{"Id":"p1","Name":"Soirée"}]}""")
        assertEquals("Soirée", api("emby").lists(ListKind.Playlist).single().name)
        val r = srv.takeRequest()
        assertEquals("/emby/Users/u1/Items", r.url.encodedPath)
        assertEquals("Playlist", r.url.queryParameter("IncludeItemTypes"))
        assertEquals("true", r.url.queryParameter("Recursive"))
        reply(200, """{"Items":[]}""")
        api("jellyfin").lists(ListKind.Collection)
        val j = srv.takeRequest()
        assertEquals("/Items", j.url.encodedPath)
        assertEquals("BoxSet", j.url.queryParameter("IncludeItemTypes"))
    }

    @Test
    fun createSendsQueryAndBody() = runBlocking {
        reply(200, """{"Id":"p9"}""")
        api("jellyfin").createList(ListKind.Playlist, "Soirée", song)
        val r = srv.takeRequest()
        assertEquals("POST /Playlists", "${r.method} ${r.url.encodedPath}")
        assertEquals("Soirée", r.url.queryParameter("Name"))
        assertEquals("a1", r.url.queryParameter("Ids"))
        assertEquals("Audio", r.url.queryParameter("MediaType"))
        assertEquals("""{"Name":"Soirée","Ids":["a1"],"UserId":"u1","MediaType":"Audio"}""", r.body!!.utf8())
        reply(200, """{"Id":"c9"}""")
        api("emby").createList(ListKind.Collection, "Saga", movie)
        val c = srv.takeRequest()
        assertEquals("POST /emby/Collections", "${c.method} ${c.url.encodedPath}")
        assertEquals("Saga", c.url.queryParameter("Name"))
        assertEquals("m1", c.url.queryParameter("Ids"))
    }

    @Test
    fun addGoesToTheListItems() = runBlocking {
        reply(204)
        api("emby").addToList(ListKind.Playlist, "p1", movie)
        val p = srv.takeRequest()
        assertEquals("POST /emby/Playlists/p1/Items", "${p.method} ${p.url.encodedPath}")
        assertEquals("m1", p.url.queryParameter("Ids"))
        assertEquals("u1", p.url.queryParameter("UserId"))
        reply(204)
        api("jellyfin").addToList(ListKind.Collection, "c1", movie)
        val c = srv.takeRequest()
        assertEquals("POST /Collections/c1/Items", "${c.method} ${c.url.encodedPath}")
        assertEquals("m1", c.url.queryParameter("Ids"))
    }
}
