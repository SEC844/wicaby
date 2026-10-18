package com.wika.wicaby.core.subsonic

import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ItemsResult
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.json
import com.wika.wicaby.core.net.ServerTransport
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

// MU-N3: SubsonicApi against a fake OpenSubsonic server (mockwebserver3): token auth on every call (md5 checked, a
// fresh salt each time, never p=), the Emby routes the apps call mapped and answered, star by kind, playlist edits,
// the scrobble rule, lyrics, error codes; and no credential in any URL string the app hands to Coil or Media3, the
// interceptor adding them on the server's own hops only.
class SubsonicApiTest {
    private lateinit var server: MockWebServer
    private lateinit var other: MockWebServer
    private val calls = CopyOnWriteArrayList<RecordedRequest>()
    private val salts = mutableSetOf<String>()
    private var problems = CopyOnWriteArrayList<String>()
    private val inFlight = java.util.concurrent.atomic.AtomicInteger()
    private val peak = java.util.concurrent.atomic.AtomicInteger()

    private fun ok(body: String = "") = MockResponse.Builder().addHeader("Content-Type", "application/json")
        .body("""{"subsonic-response":{"status":"ok","version":"1.16.1","type":"navidrome","openSubsonic":true${if (body.isEmpty()) "" else ",$body"}}}""").build()

    private fun failed(code: Int) = MockResponse.Builder().addHeader("Content-Type", "application/json")
        .body("""{"subsonic-response":{"status":"failed","version":"1.16.1","error":{"code":$code,"message":"no"}}}""").build()

    private val song = """{"id":"s1","title":"Fil","album":"Lignes claires","albumId":"a1","artist":"Nora Vale","artistId":"r1","track":1,"discNumber":1,"duration":200,"suffix":"flac","coverArt":"al-a1_0","starred":"2026-01-01T00:00:00Z"}"""
    private val song2 = """{"id":"s2","title":"Marelle","albumId":"a1","artist":"Nora Vale","artistId":"r1","track":2,"duration":200,"suffix":"flac"}"""

    @Before
    fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                calls += request
                val u = request.url
                if (u.queryParameter("p") != null) problems += "CLEARTEXT-PASSWORD"
                val user = u.queryParameter("u")
                val salt = u.queryParameter("s").orEmpty()
                val name = u.encodedPath.removePrefix("/rest/").removeSuffix(".view")
                if (user == "ldap") return failed(41)
                val media = name in setOf("stream", "getCoverArt", "download")
                if (!media && !salts.add(salt)) problems += "SALT-REUSE"
                if (user != "wika" || u.queryParameter("t") != SubsonicMap.token("mock-pass", salt)) return failed(40)
                return when (name) {
                    "getOpenSubsonicExtensions" -> ok(""""openSubsonicExtensions":[{"name":"songLyrics","versions":[1]}]""")
                    "getMusicFolders" -> ok(""""musicFolders":{"musicFolder":[{"id":1,"name":"Musique"}]}""")
                    "getArtists" -> ok(""""artists":{"index":[{"name":"N","artist":[{"id":"r1","name":"Nora Vale","albumCount":2},{"id":"r2","name":"Night Arcade","albumCount":1}]}]}""")
                    "getAlbumList2" -> ok(""""albumList2":{"album":[{"id":"a1","name":"Lignes claires","artist":"Nora Vale","artistId":"r1","songCount":2,"coverArt":"al-a1_0"}]}""")
                    "getAlbum" -> ok(""""album":{"id":"a1","name":"Lignes claires","song":[$song,$song2]}""")
                    "getSong" -> {
                        peak.accumulateAndGet(inFlight.incrementAndGet(), ::maxOf)
                        Thread.sleep(20)
                        inFlight.decrementAndGet()
                        ok(""""song":$song""")
                    }
                    "getPlaylist" -> ok(""""playlist":{"id":"p1","name":"Mix","entry":[$song,$song2,$song]}""")
                    "ping", "star", "unstar", "updatePlaylist", "createPlaylist", "scrobble" -> ok(if (name == "createPlaylist") """"playlist":{"id":"p9","name":"New"}""" else "")
                    "getLyricsBySongId" -> ok(""""lyricsList":{"structuredLyrics":[{"synced":true,"offset":0,"line":[{"start":1000,"value":"Une"}]}]}""")
                    "stream" -> MockResponse.Builder().addHeader("Content-Type", "audio/flac").body("fLaC").build()
                    "getCoverArt" -> MockResponse.Builder().addHeader("Content-Type", "image/png").body("png").build()
                    else -> MockResponse.Builder().code(404).build()
                }
            }
        }
        server.start()
        other = MockWebServer()
        other.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.url.queryParameter("t") != null || request.url.queryParameter("u") != null) problems += "TOKEN-TO-ANOTHER-HOST"
                return MockResponse.Builder().body("x").build()
            }
        }
        other.start()
    }

    @After
    fun stop() {
        server.close()
        other.close()
        assertEquals(emptyList<String>(), problems.toList())
    }

    private val address get() = server.url("/").toString().trimEnd('/')
    private fun api(user: String = "wika", pw: String = "mock-pass") = SubsonicApi(Server("nd0123456789abcd", "Navidrome", address, "navidrome"), "dev", pw, user, OkHttpClient())
    private fun names() = calls.map { it.url.encodedPath.removePrefix("/rest/") }

    @Test
    fun browseThroughTheEmbyRoutes() = runBlocking {
        val a = api()
        val views = json.decodeFromString(ItemsResult.serializer(), a.raw("GET", "/UserViews", null, "userId" to "wika"))
        assertEquals(listOf("mf_1"), views.items.map { it.id })
        assertEquals("music", views.items[0].collectionType)
        val albums = json.decodeFromString(ItemsResult.serializer(), a.raw("GET", "/Items", null, "ParentId" to "mf_1", "IncludeItemTypes" to "MusicAlbum", "SortBy" to "SortName", "StartIndex" to 0, "Limit" to 100))
        assertEquals(3, albums.totalRecordCount)
        assertEquals("al_a1", albums.items[0].id)
        assertEquals("nd0123456789abcd", albums.items[0].serverId)
        val tracks = json.decodeFromString(ItemsResult.serializer(), a.raw("GET", "/Items", null, "userId" to "wika", "ParentId" to "al_a1"))
        assertEquals(listOf("tr_s1", "tr_s2"), tracks.items.map { it.id })
        val one = json.decodeFromString(Item.serializer(), a.raw("GET", "/Users/wika/Items/tr_s1"))
        assertEquals("Fil", one.name)
        assertEquals(true, one.userData?.isFavorite)
        assertEquals("tr_s1", one.mediaSources.first().id)
        val aa = json.decodeFromString(ItemsResult.serializer(), a.raw("GET", "/Artists/AlbumArtists", null, "ParentId" to "mf_1", "NameStartsWith" to "No"))
        assertEquals(listOf("ar_r1"), aa.items.map { it.id })
        assertEquals("[]", a.raw("GET", "/Items/tr_s1/LocalTrailers"))
        assertEquals(0, json.decodeFromString(ItemsResult.serializer(), a.raw("GET", "/UserItems/Resume", null)).items.size)
        // Every call signed with a fresh salt, as JSON.
        assertTrue(calls.all { it.url.queryParameter("f") == "json" && it.url.queryParameter("v") == "1.16.1" })
    }

    @Test
    fun anIdsPageIsFetchedAFewAtATime() = runBlocking {
        val ids = List(30) { "tr_s1" }.joinToString(",")
        val r = json.decodeFromString(ItemsResult.serializer(), api().raw("GET", "/Items", null, "Ids" to ids))
        assertEquals(30, r.items.size)
        assertTrue("peak ${peak.get()}", peak.get() in 1..6)
    }

    @Test
    fun favouritesPlaylistsAndScrobbles() = runBlocking {
        val a = api()
        a.raw("POST", "/Users/wika/FavoriteItems/tr_s1")
        a.raw("POST", "/UserFavoriteItems/al_a1", null, "userId" to "wika")
        a.raw("DELETE", "/Users/wika/FavoriteItems/ar_r1")
        val stars = calls.filter { it.url.encodedPath.contains("star") }.map { r -> r.url.encodedPath.removePrefix("/rest/") + ":" + listOf("id", "albumId", "artistId").first { r.url.queryParameter(it) != null } }
        assertEquals(listOf("star:id", "star:albumId", "unstar:artistId"), stars)

        val entries = Json.parseToJsonElement(a.raw("GET", "/Playlists/pl_p1/Items")).jsonObject["Items"]!!.jsonArray
        assertEquals(listOf("pe_0", "pe_1", "pe_2"), entries.map { it.jsonObject["PlaylistItemId"]!!.jsonPrimitive.content })
        a.raw("DELETE", "/Playlists/pl_p1/Items", null, "EntryIds" to "pe_0,pe_2")
        assertEquals(listOf("2", "0"), calls.last().url.queryParameterValues("songIndexToRemove"))
        a.raw("POST", "/Playlists/pl_p1/Items", null, "Ids" to "al_a1")
        assertEquals(listOf("s1", "s2"), calls.last().url.queryParameterValues("songIdToAdd"))
        a.raw("POST", "/Playlists/pl_p1/Items/pe_0/Move/2")
        assertEquals(listOf("s2", "s1", "s1"), calls.last().url.queryParameterValues("songId"))
        assertEquals("p1", calls.last().url.queryParameter("playlistId"))
        val made = a.raw("POST", "/Playlists", """{"Name":"New","Ids":["tr_s1"],"MediaType":"Audio"}""", "Name" to "New", "Ids" to "tr_s1")
        assertEquals("""{"Id":"pl_p9"}""", made)

        // Now playing, a skip under the threshold, then one submission for the play however often Stopped comes.
        calls.clear()
        a.raw("POST", "/Sessions/Playing", """{"ItemId":"tr_s1","PlaySessionId":"x1","PositionTicks":0}""")
        a.raw("POST", "/Sessions/Playing/Progress", """{"ItemId":"tr_s1","PlaySessionId":"x1","PositionTicks":100}""")
        a.raw("POST", "/Sessions/Playing/Stopped", """{"ItemId":"tr_s2","PlaySessionId":"x0","PositionTicks":100000000}""")
        a.raw("POST", "/Sessions/Playing/Stopped", """{"ItemId":"tr_s1","PlaySessionId":"x1","PositionTicks":1500000000}""")
        a.raw("POST", "/Sessions/Playing/Stopped", """{"ItemId":"tr_s1","PlaySessionId":"x1","PositionTicks":2000000000}""")
        val scrobbles = calls.filter { it.url.encodedPath.endsWith("/scrobble") }.map { "${it.url.queryParameter("id")}:${it.url.queryParameter("submission")}" }
        assertEquals(listOf("s1:false", "s1:true"), scrobbles)
    }

    @Test
    fun lyricsAndErrors() = runBlocking {
        val a = api()
        assertEquals("""{"Metadata":{"IsSynced":true},"Lyrics":[{"Text":"Une","Start":10000000}]}""", a.raw("GET", "/Audio/tr_s1/Lyrics")) // never isEmby
        try {
            a.raw("GET", "/LiveTv/Channels")
            fail("unmapped")
        } catch (e: ApiException) {
            assertEquals(404, e.status)
            assertTrue(e.message!!.startsWith("NAVIDROME-UNMAPPED"))
        }
        // Sign-in through the Emby routes the Setup screens call: no user list, a token-auth ping, the password as the token.
        val signedOut = SubsonicApi(Server("nd0123456789abcd", "Navidrome", address, "navidrome"), "dev", null, null, OkHttpClient())
        assertEquals("[]", signedOut.raw("GET", "/Users/Public"))
        val auth = signedOut.raw("POST", "/Users/AuthenticateByName", """{"Username":"wika","Pw":"mock-pass"}""")
        assertEquals("""{"AccessToken":"mock-pass","User":{"Id":"wika","Name":"wika","HasPassword":true}}""", auth)
        try {
            signedOut.raw("POST", "/Users/AuthenticateByName", """{"Username":"wika","Pw":"nope"}""")
            fail("wrong password")
        } catch (e: SubsonicException) {
            assertEquals(401, e.status)
        }
        assertTrue(a.raw("GET", "/Users/wika").contains("\"Id\":\"wika\""))
        // Servers.goOffline's probe is mapped: an offline extra Navidrome can come back.
        assertTrue(a.raw("GET", "/System/Info/Public").contains("\"Id\":\"nd0123456789abcd\""))
        for ((user, code) in listOf("wika" to 40, "ldap" to 41)) {
            try {
                api(user, "wrong").raw("GET", "/UserViews")
                fail("$user")
            } catch (e: SubsonicException) {
                assertEquals(code, e.code)
                assertEquals(401, e.status)
            }
        }
    }

    @Test
    fun noCredentialInUrlsTheInterceptorSignsServerHopsOnly() {
        val a = api()
        val stream = a.url("/Audio/tr_s1/stream", "static" to true, "MediaSourceId" to "tr_s1", "PlaySessionId" to "p", "DeviceId" to "dev")
        val image = a.image("al_a1", "Primary", "al-a1_0", maxHeight = 300)
        assertEquals("$address/rest/stream?id=s1&format=raw", stream)
        assertEquals("$address/rest/getCoverArt?id=al-a1_0&size=300", image)
        assertEquals("$address/rest/getCoverArt?id=a1&size=600", a.image("al_a1", "Primary", null))
        assertEquals("", a.image("al_a1", "Backdrop", "x"))
        for (u in listOf(stream, image, a.url("/Items/tr_s1/Download"))) assertFalse(u, Regex("[?&](u|t|s|p)=").containsMatchIn(u) || u.contains("mock-pass"))

        val http = OkHttpClient.Builder().addNetworkInterceptor(SubsonicInterceptor({ ServerTransport.Direct }) { a }).build()
        http.newCall(Request.Builder().url(image).build()).execute().use { assertEquals(200, it.code) }
        val hop = calls.last().url
        assertEquals("wika", hop.queryParameter("u"))
        assertEquals(SubsonicMap.token("mock-pass", hop.queryParameter("s")!!), hop.queryParameter("t"))
        http.newCall(Request.Builder().url(stream).build()).execute().use { assertEquals("fLaC", it.body.string()) }
        // Another host with a /rest/ path gets nothing.
        http.newCall(Request.Builder().url(other.url("/rest/stream?id=s1")).build()).execute().close()
        // An action URL on the server itself (a hostile logo pointing there) is not signed: the server refuses it.
        calls.clear()
        http.newCall(Request.Builder().url("$address/rest/deletePlaylist?id=p1").build()).execute().close()
        assertNull(calls.single().url.queryParameter("t"))
        // Nor a redirect from another host onto a media endpoint of the server.
        other.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse.Builder().code(302).addHeader("Location", stream).build()
        }
        calls.clear()
        http.newCall(Request.Builder().url(other.url("/logo.png")).build()).execute().close()
        assertNull(calls.single().url.queryParameter("t"))
        assertNull(calls.firstOrNull { it.url.queryParameter("p") != null })
    }
}
