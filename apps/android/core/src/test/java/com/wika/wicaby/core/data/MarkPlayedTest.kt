package com.wika.wicaby.core.data

import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

// "Saison vue" / "Marquer les précédents comme vus" on both flavours, and the offline watch state
// laid over a downloaded item (offline home).
class MarkPlayedTest {
    private lateinit var srv: MockWebServer

    @Before
    fun setUp() {
        srv = MockWebServer().apply { start() }
    }

    @After
    fun tearDown() = srv.close()

    private fun api(kind: String) = Api(Server("srv", "Server", srv.url("/").toString().trimEnd('/'), kind), "dev", "tok", "u1")

    private fun reply(code: Int, body: String = "") = srv.enqueue(MockResponse.Builder().code(code).body(body).build())

    private fun ep(id: String, season: Int, played: Boolean = false) = Item(id, type = "Episode", parentIndexNumber = season, userData = UserData(played = played))

    @Test
    fun jellyfinUsesTheModernRouteThenTheOldOne() = runBlocking {
        reply(204)
        api("jellyfin").setPlayed("e1", true)
        val modern = srv.takeRequest()
        assertEquals("POST /UserPlayedItems/e1", "${modern.method} ${modern.url.encodedPath}")
        assertEquals("u1", modern.url.queryParameter("userId"))
        // Jellyfin before 10.9: 404 on the new route, the per-user one answers.
        reply(404)
        reply(204)
        api("jellyfin").setPlayed("e1", false)
        assertEquals("DELETE /UserPlayedItems/e1", srv.takeRequest().let { "${it.method} ${it.url.encodedPath}" })
        assertEquals("DELETE /Users/u1/PlayedItems/e1", srv.takeRequest().let { "${it.method} ${it.url.encodedPath}" })
    }

    @Test
    fun embyKeepsTheUserRoute() = runBlocking {
        reply(200, "{}")
        api("emby").setPlayed("e1", true)
        assertEquals("/emby/Users/u1/PlayedItems/e1", srv.takeRequest().url.encodedPath)
    }

    @Test
    fun jellyfinItemFallsBackOn404And405() = runBlocking {
        reply(404)
        reply(200, """{"Id":"m1","Name":"Film"}""")
        assertEquals("Film", api("jellyfin").item("m1").name)
        assertEquals("/Items/m1", srv.takeRequest().url.encodedPath)
        assertEquals("/Users/u1/Items/m1", srv.takeRequest().url.encodedPath)
        // Jellyfin 10.8 routes DELETE/POST /Items/{id} but not GET: 405, the old route answers.
        reply(405)
        reply(200, """{"Id":"m1","Name":"Film"}""")
        assertEquals("Film", api("jellyfin").item("m1").name)
        assertEquals("/Items/m1", srv.takeRequest().url.encodedPath)
        assertEquals("/Users/u1/Items/m1", srv.takeRequest().url.encodedPath)
        // Any other error is the server's answer: no second request.
        reply(500)
        assertEquals(500, runCatching { api("jellyfin").item("m1") }.exceptionOrNull().let { (it as ApiException).status })
        assertEquals("/Items/m1", srv.takeRequest().url.encodedPath)
        assertEquals(5, srv.requestCount)
    }

    @Test
    fun jellyfinHomeRowsUseTheModernRoutes() = runBlocking {
        reply(200, """{"Items":[{"Id":"v1","Name":"Films"}]}""")
        reply(200, """{"Items":[]}""")
        assertEquals("Films", api("jellyfin").views().single().name)
        api("jellyfin").resume()
        assertEquals("/UserViews", srv.takeRequest().url.encodedPath)
        assertEquals("/UserItems/Resume", srv.takeRequest().url.encodedPath)
    }

    @Test
    fun markPlayedSkipsWhatIsAlreadyThere() = runBlocking {
        reply(200, "{}")
        val steps = mutableListOf<Pair<Int, Int>>()
        val n = api("emby").markPlayed(listOf(ep("a", 1, played = true), ep("b", 1)), on = true) { d, t -> steps += d to t }
        assertEquals(1, n)
        assertEquals(listOf(0 to 1, 1 to 1), steps)
        assertEquals("/emby/Users/u1/PlayedItems/b", srv.takeRequest().url.encodedPath)
        assertEquals(1, srv.requestCount)
    }

    @Test
    fun previousEpisodesLeaveSpecialsOut() {
        val all = listOf(ep("s0", 0), ep("a", 1), ep("b", 1), ep("c", 2), ep("d", 2))
        assertEquals(listOf("a", "b"), previousEpisodes(all, all[3]).map { it.id })
        assertEquals(emptyList<Item>(), previousEpisodes(all, ep("x", 1)))
        // From a special, the earlier specials count.
        assertEquals(listOf("s0"), previousEpisodes(listOf(ep("s0", 0), ep("s1", 0)), ep("s1", 0)).map { it.id })
    }

    @Test
    fun upNextFollowsInterleavedSpecialsOnly() {
        // Interleaved by the server (the special carries its aired season): played in air order.
        val aired = Item("sp", type = "Episode", parentIndexNumber = 0, airsBeforeSeasonNumber = 2)
        val inter = listOf(ep("a", 1), aired, ep("c", 2))
        assertEquals("sp", nextInOrder(inter, inter[0])?.id)
        assertEquals("c", nextInOrder(inter, aired)?.id)
        // Season 0 without an aired season after a regular episode: skipped.
        val flat = listOf(ep("a", 1), ep("s1", 0), ep("s2", 0), ep("c", 2))
        assertEquals("c", nextInOrder(flat, flat[0])?.id)
        assertEquals(null, nextInOrder(listOf(ep("z", 3), ep("s1", 0)), ep("z", 3)))
        // From a special, the next one in the server's order (specials first, then season 1).
        val first = listOf(ep("s1", 0), ep("s2", 0), ep("a", 1))
        assertEquals("s2", nextInOrder(first, first[0])?.id)
        assertEquals("a", nextInOrder(first, first[1])?.id)
        assertEquals(null, nextInOrder(first, ep("x", 1)))
    }

    @Test
    fun nextEpisodeAsksForTheSpecialsPlacement() = runBlocking {
        srv.enqueue(MockResponse.Builder().body("""{"Items":[{"Id":"a","Type":"Episode","ParentIndexNumber":1},{"Id":"s","Type":"Episode","ParentIndexNumber":0},{"Id":"b","Type":"Episode","ParentIndexNumber":1}]}""").build())
        assertEquals("b", api("jellyfin").nextEpisode(Item("a", type = "Episode", seriesId = "show", parentIndexNumber = 1))?.id)
        val q = srv.takeRequest().url
        assertEquals("a", q.queryParameter("StartItemId"))
        assertEquals("false", q.queryParameter("IsMissing"))
        assertEquals(true, q.queryParameter("Fields")?.split(',')?.contains("SpecialEpisodeNumbers"))
    }

    @Test
    fun pendingWatchStateOverridesTheStoredOne() {
        val stored = ep("a", 1, played = true)
        val pending = listOf(PendingProgress("srv", "u1", "a", 600, false, 1), PendingProgress("other", "u1", "b", 9, true, 1))
        val item = stored.withPending(pending, "srv", "u1")
        assertEquals(600L, item.userData?.playbackPositionTicks)
        assertEquals(false, item.userData?.played)
        // Another server's or user's entry does not apply.
        assertEquals(stored, stored.withPending(pending, "srv", "u2"))
    }
}
