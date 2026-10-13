package com.wika.wicaby.core.data

import com.wika.wicaby.core.Core
import com.wika.wicaby.core.net.ServerTransport
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

// TP-06: several servers merged. The merge cases are shared with the desktop (tools/checks/fixtures/servers.json).
class ServersTest {
    private val servers = mutableListOf<MockWebServer>()

    @After
    fun tearDown() {
        Core.api = null
        Servers.extra = emptyList()
        Servers.extraTimeoutMs = 5_000
        servers.forEach { it.close() }
    }

    private fun mock(vararg bodies: String) = MockWebServer().apply {
        bodies.forEach { enqueue(MockResponse.Builder().code(200).body(it).build()) }
        start()
        servers += this
    }

    private fun api(id: String, address: String) = Api(Server(id, "Server $id", address, "jellyfin"), "dev", "token-$id", "u-$id")

    private fun item(id: String, server: String?, type: String = "Movie", vararg ids: Pair<String, String>) =
        Item(id, name = "T$id", type = type, serverId = server, providerIds = ids.toMap())

    @Test
    fun mergeFixturesMatchTheDesktop() {
        val cases = json.parseToJsonElement(File("../../../tools/checks/fixtures/servers.json").readText()).jsonObject["merge"]!!.jsonArray
        for (c in cases.map { it.jsonObject }) {
            val lists = c["lists"]!!.jsonArray.map { l -> if (l is JsonNull) null else json.decodeFromJsonElement(ListSerializer(Item.serializer()), l) }
            val got = Servers.merge(lists, c["byDate"]!!.jsonPrimitive.boolean).map(Servers::key)
            assertEquals(c["name"]!!.jsonPrimitive.content, c["expected"]!!.jsonArray.map { it.jsonPrimitive.content }, got)
        }
    }

    @Test
    fun sameTitleNeedsAMatchingProviderIdOfTheSameType() {
        assertTrue(Servers.sameTitle(item("1", "a", "Movie", "Imdb" to "tt1"), item("2", "b", "Movie", "imdb" to "tt1", "Tmdb" to "3")))
        assertFalse(Servers.sameTitle(item("1", "a", "Movie", "Tvdb" to "5"), item("2", "b", "Series", "Tvdb" to "5")))
        assertFalse(Servers.sameTitle(item("1", "a"), item("2", "b")))
    }

    @Test
    fun aloneTheMergedQueryIsThePrimarysAnswerAndItsError() = runBlocking {
        val a = api("a", "http://127.0.0.1:1")
        Core.api = a
        val list = listOf(item("1", null), item("2", null))
        assertEquals(list, Servers.merged(a) { list })
        try {
            Servers.merged(a) { throw IllegalStateException("down") }
            fail("the error is lost")
        } catch (e: IllegalStateException) {
            assertEquals("down", e.message)
        }
        assertEquals(emptyList<Api>(), Servers.all.filter { it !== a })
        assertEquals(null, Servers.extraOf("a"))
    }

    @Test
    fun severalServersAreTaggedInterleavedAndADownOneIsLeftOut() = runBlocking {
        val a = api("a", "http://127.0.0.1:1")
        val b = api("b", "http://127.0.0.1:2")
        val c = api("c", "http://127.0.0.1:3")
        Core.api = a
        // The primary also signed in as an extra one counts once.
        Servers.extra = listOf(api("a", "http://127.0.0.1:1"), b, c)
        assertEquals(listOf("a", "b", "c"), Servers.all.map { it.server.id })
        assertEquals(b, Servers.extraOf("b"))
        val got = Servers.merged(a) { s ->
            when (s.server.id) {
                "a" -> listOf(item("1", null, "Movie", "Imdb" to "tt1"), item("2", null))
                "b" -> listOf(item("1", null, "Movie", "Imdb" to "tt1"), item("3", null))
                else -> error("down")
            }
        }
        assertEquals(listOf("a:1", "a:2", "b:3"), got.map(Servers::key))
    }

    @Test
    fun anExtraServerThatHangsOrIsUnreachableGoesOfflineAndIsNoLongerQueried() = runBlocking {
        // Ids of their own: the offline state outlives the test (its probe retries every retryMs).
        val a = api("p", "http://127.0.0.1:1")
        val hung = api("x", "http://127.0.0.1:2")
        val refused = api("y", "http://127.0.0.1:3")
        val answered = api("z", "http://127.0.0.1:4")
        Core.api = a
        Servers.extra = listOf(hung, refused, answered)
        Servers.extraTimeoutMs = 200
        val calls = mutableListOf<String>()
        val fn: suspend (Api) -> List<Item> = { s ->
            synchronized(calls) { calls += s.server.id }
            when (s.server.id) {
                "p" -> listOf(item("1", null))
                "x" -> { kotlinx.coroutines.delay(60_000); emptyList() }
                "y" -> throw java.io.IOException("refused")
                else -> throw ApiException("HTTP 500", 500)
            }
        }
        val started = System.currentTimeMillis()
        assertEquals(listOf("p:1"), Servers.merged(a, fn = fn).map(Servers::key))
        assertTrue("held back by the hung server", System.currentTimeMillis() - started < 5_000)
        // An HTTP error is a server that answers: it stays online.
        assertEquals(listOf("p", "z"), Servers.online.map { it.server.id })
        assertTrue(Servers.multi)
        calls.clear()
        assertEquals(listOf("p:1"), Servers.merged(a, fn = fn).map(Servers::key))
        assertEquals(setOf("p", "z"), calls.toSet())
    }

    @Test
    fun copiesAreFoundByNameAndKeptOnAProviderIdMatch() = runBlocking {
        val other = mock(
            """{"Items":[{"Id":"40","Name":"Dune","Type":"Movie","ProviderIds":{"Imdb":"tt2"}},{"Id":"41","Name":"Dune","Type":"Movie","ServerId":"b","ProviderIds":{"Imdb":"tt1"}}],"TotalRecordCount":2}""",
        )
        val a = api("a", "http://127.0.0.1:1")
        Core.api = a
        val film = Item("7", name = "Dune", type = "Movie", serverId = "a", providerIds = mapOf("Imdb" to "tt1"))
        assertEquals(emptyList<Item>(), Servers.copies(film, a))
        Servers.extra = listOf(api("b", other.url("/").toString().trimEnd('/')))
        val copies = Servers.copies(film, a)
        assertEquals(listOf("a:7", "b:41"), copies.map(Servers::key))
        val q = other.takeRequest().url
        assertEquals("Dune", q.queryParameter("SearchTerm"))
        assertEquals("Movie", q.queryParameter("IncludeItemTypes"))
        // No provider id: nothing to match on, no call.
        assertEquals(emptyList<Item>(), Servers.copies(film.copy(providerIds = emptyMap()), a))
    }

    @Test
    fun libraryRefKeepsPrimaryIdsAndScopesTheOthers() {
        // Both servers have a "lib-movies" (mock-jellyfin reuses mock-emby's items): two distinct home rows.
        assertEquals("lib-movies", Servers.libraryRef(Item("lib-movies", serverId = "a"), "a"))
        assertEquals("lib-movies", Servers.libraryRef(Item("lib-movies"), "a"))
        assertEquals("b/lib-movies", Servers.libraryRef(Item("lib-movies", serverId = "b"), "a"))
    }

    @Test
    fun mergedUpcomingIsInAirDateOrderAcrossServers() {
        fun ep(id: String, server: String, date: String?) = Item(id, id, "Episode", serverId = server, premiereDate = date)
        val merged = Servers.merge(listOf(
            listOf(ep("a1", "A", "2026-10-13T00:00:00.0000000Z"), ep("a2", "A", "2026-10-20T00:00:00.0000000Z")),
            listOf(ep("b1", "B", "2026-10-12T00:00:00.0000000Z"), ep("b2", "B", "2026-10-15T00:00:00.0000000Z")),
        ))
        assertEquals(listOf("b1", "a1", "b2", "a2"), Servers.byAirDate(merged).map { it.id })
    }

    @Test
    fun eachServerGetsItsOwnCredentials() {
        val sa = mock("ok")
        val sb = mock("ok")
        val a = Api(Server("a", "A", sa.url("/").toString().trimEnd('/'), "emby"), "dev", "token-a", "ua")
        val b = Api(Server("b", "B", sb.url("/").toString().trimEnd('/'), "emby"), "dev", "token-b", "ub")
        val c = OkHttpClient.Builder().addNetworkInterceptor(ServerAuthInterceptor({ ServerTransport.Direct }, { listOf(b) }) { a }).build()
        c.newCall(Request.Builder().url(sa.url("/x")).build()).execute().close()
        c.newCall(Request.Builder().url(sb.url("/y")).build()).execute().close()
        assertEquals("token-a", sa.takeRequest().headers["X-Emby-Token"])
        assertEquals("token-b", sb.takeRequest().headers["X-Emby-Token"])
    }

    // TP-06: an offline server is probed (/System/Info/Public) and comes back on its own, which signals the views.
    @Test
    fun anOfflineServerComesBackOnItsOwn() = runBlocking {
        val probe = mock("""{"Id":"w"}""")
        val a = api("p2", "http://127.0.0.1:1")
        val w = api("w", probe.url("/").toString().trimEnd('/'))
        Core.api = a
        Servers.extra = listOf(w)
        val before = Servers.back.value
        var down = true
        val fn: suspend (Api) -> List<Item> = { s -> if (s === w && down) throw java.io.IOException("down") else listOf(item("1", null)) }
        assertEquals(listOf("p2:1"), Servers.merged(a, fn = fn).map(Servers::key))
        kotlinx.coroutines.withTimeout(5_000) { while (Servers.back.value == before) kotlinx.coroutines.delay(20) }
        assertFalse(Servers.isOffline("w"))
        assertEquals("/System/Info/Public", probe.takeRequest().url.encodedPath)
        down = false
        assertEquals(listOf("p2:1", "w:1"), Servers.merged(a, fn = fn).map(Servers::key))
    }
}
