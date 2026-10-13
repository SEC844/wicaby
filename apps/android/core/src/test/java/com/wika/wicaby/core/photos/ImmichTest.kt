package com.wika.wicaby.core.photos

import com.wika.wicaby.core.net.ServerTransport
import kotlinx.coroutines.runBlocking
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

// Photos spec PH-13 (the PH-12 AC 1, 3, 4 and 6 on Android): the Immich client and the timeline adapter against a
// small hand-written fake of the API shapes tools/mock-server/mock-immich.mjs serves (contract:
// tools/checks/fixtures/photos/immich-contract.json).
class FakeImmich(var version: String = "3.3.0", var scopes: Set<String> = ALL, var broken: Boolean = false) : Dispatcher() {
    val requests = mutableListOf<RecordedRequest>()

    companion object {
        const val KEY = "mock-immich-key"
        val ALL = setOf("asset.read", "asset.view", "asset.update", "album.read", "person.read", "map.read", "memory.read")
        const val A = "11111111-1111-4111-a111-111111111111"
        const val B = "22222222-2222-4222-a222-222222222222"
        const val ARCHIVED = "33333333-3333-4333-a333-333333333333"
        const val C = "44444444-4444-4444-a444-444444444444"
    }

    private fun json(body: String, code: Int = 200) = MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    private fun asset(id: String, local: String, video: Boolean = false) =
        """{"id":"$id","type":"${if (video) "VIDEO" else "IMAGE"}","localDateTime":"$local.000Z","fileCreatedAt":"$local.000Z","isFavorite":false,
           "duration":"${if (video) "0:00:12.000000" else "0:00:00.00000"}","exifInfo":{"exifImageWidth":4000,"exifImageHeight":3000,"orientation":"6","make":"Wicaby Test","exposureTime":"1/250","fNumber":2.8,"iso":200}}"""

    override fun dispatch(request: RecordedRequest): MockResponse {
        requests += request
        val path = request.url.encodedPath
        if (path == "/api/server/version") {
            val (ma, mi, pa) = version.split('.')
            return json("""{"major":$ma,"minor":$mi,"patch":$pa}""")
        }
        if (request.headers[IMMICH_HEADER] != KEY) return json("""{"message":"Invalid API key"}""", 401)
        val scope = when {
            path.startsWith("/api/timeline") || path.startsWith("/api/search") || path.matches(Regex("/api/assets/[^/]+")) -> "asset.read"
            path.endsWith("/thumbnail") && path.startsWith("/api/assets") -> "asset.view"
            path == "/api/assets" -> "asset.update"
            path == "/api/albums" -> "album.read"
            path.startsWith("/api/people") -> "person.read"
            path == "/api/map/markers" -> "map.read"
            path == "/api/memories" -> "memory.read"
            else -> return json("""{"message":"Not found"}""", 404)
        }
        if (scope !in scopes) return json("""{"message":"Missing required permission: $scope"}""", 403)
        return when (path) {
            "/api/timeline/buckets" -> json("""[{"timeBucket":"2024-05-01","count":2},{"timeBucket":"2023-01-01","count":1}]""")
            "/api/timeline/bucket" -> when {
                broken -> json("""{"assets":[{"assetId":"$A"}]}""")
                request.url.queryParameter("timeBucket") == "2024-05-01" -> json(
                    """{"id":["$A","$B","$ARCHIVED"],"ratio":[1.5,0.5625,1],"isImage":[true,false,true],"isFavorite":[true,false,false],
                       "visibility":["timeline","timeline","archive"],"isTrashed":[false,false,false],
                       "fileCreatedAt":["2024-05-03T08:00:00.000Z","2024-05-20T22:30:00.000Z","2024-05-04T08:00:00.000Z"],
                       "localOffsetHours":[2,-5,0],"duration":[null,"0:00:12.000000",null],"latitude":[48.85,null,null],"longitude":[2.29,null,null]}""",
                )
                else -> json("""{"id":["$C"],"ratio":[1.3333],"isImage":[true],"isFavorite":[false],"fileCreatedAt":["2023-01-10T12:00:00.000Z"],"localOffsetHours":[1]}""")
            }
            "/api/search/metadata" -> {
                val page = Regex("\"page\":(\\d+)").find(request.body?.utf8().orEmpty())?.groupValues?.get(1)
                if (page == "1") json("""{"assets":{"total":3,"count":2,"nextPage":"2","items":[${asset(B, "2024-05-20T17:30:00", video = true)},${asset(A, "2024-05-03T10:00:00")}]}}""")
                else json("""{"assets":{"total":3,"count":1,"nextPage":null,"items":[${asset(C, "2023-01-10T13:00:00")}]}}""")
            }
            "/api/albums" -> json("""[{"id":"$A","albumName":"Mountains","albumThumbnailAssetId":"$A","assetCount":3,"isShared":false},{"id":"$B","albumName":"Garden","albumThumbnailAssetId":null,"assetCount":1,"shared":true}]""")
            "/api/people" -> json("""{"total":3,"people":[{"id":"$A","name":"Alex","isHidden":false},{"id":"$B","name":"","isHidden":false},{"id":"$C","name":"Noa","isHidden":true}]}""")
            "/api/map/markers" -> json("[]")
            "/api/memories" -> json("""[{"id":"m","type":"on_this_day","data":{"year":2023},"assets":[${asset(C, "2023-01-10T13:00:00")}]}]""")
            "/api/assets" -> MockResponse.Builder().code(204).build()
            else -> if (path.endsWith("/thumbnail")) MockResponse.Builder().code(200).addHeader("Content-Type", "image/png").body("png").build() else json(asset(A, "2024-05-03T10:00:00"))
        }
    }
}

class ImmichTest {
    private lateinit var server: MockWebServer
    private lateinit var fake: FakeImmich
    private var source: ImmichSource? = null
    private val http = OkHttpClient.Builder().addNetworkInterceptor(ImmichKeyInterceptor({ ServerTransport.Direct }) { source }).build()

    @Before
    fun up() {
        fake = FakeImmich()
        server = MockWebServer()
        server.dispatcher = fake
        server.start()
        source = ImmichSource("abcdef012345", server.url("/").toString().trimEnd('/'), FakeImmich.KEY)
    }

    @After
    fun down() = server.close()

    private fun client() = ImmichClient(source!!.url, http = http)

    @Test
    fun adapterHelpers() {
        assertEquals("2019-10-12T10:30:00", ImmichTimeline.wallClock("2019-10-12T08:30:00.000Z", 2.0))
        assertEquals("2019-10-12T18:30:00", ImmichTimeline.wallClock("2019-10-12T23:30:00Z", -5.0))
        assertEquals(65_500L, ImmichTimeline.durationMs("0:01:05.500000"))
        assertNull(ImmichTimeline.durationMs("0:00:00.00000"))
        assertEquals("http://photos.local:2283", normalizeImmichUrl("photos.local:2283/api/"))
        assertEquals("https://nas/immich", normalizeImmichUrl("https://nas/immich/"))
        assertNull(normalizeImmichUrl("http://u:p@nas"))
        try {
            ImmichTimeline.columns(kotlinx.serialization.json.Json.parseToJsonElement("""{"id":["a"],"ratio":[]}"""), "immich:x", false, null)
            fail("a short column must not parse")
        } catch (e: ImmichTimeline.ShapeException) {
            assertTrue(e.message!!.contains("ratio"))
        }
    }

    // AC 6 and the column mapping: archived rows absent, wall clock from the offset, newest first, no coordinates.
    @Test
    fun timelineFromBuckets() = runBlocking {
        val r = client().timeline(ImmichTimeline.Filter())
        assertFalse(r.fallback)
        assertEquals(listOf(FakeImmich.B, FakeImmich.A, FakeImmich.C), r.assets.map { it.id })
        val b = r.assets[0]
        assertEquals("video", b.kind)
        assertEquals("2024-05-20T17:30:00", b.takenAt)
        assertEquals(12_000L, b.durationMs)
        assertEquals("2024-05-03T10:00:00", r.assets[1].takenAt)
        assertTrue(r.assets[1].favorite)
        assertTrue(r.assets.none { it.id == FakeImmich.ARCHIVED })
        assertTrue(r.assets.all { it.lat == null && it.lon == null })
        val q = fake.requests.first { it.url.encodedPath == "/api/timeline/buckets" }.url
        assertEquals("timeline", q.queryParameter("visibility"))
    }

    // AC 3: a bucket of an unknown shape falls back to the Stable search/metadata, with the same photos.
    @Test
    fun brokenTimelineFallsBack() = runBlocking {
        fake.broken = true
        val r = client().timeline(ImmichTimeline.Filter(favorites = true))
        assertTrue(r.fallback)
        assertEquals(listOf(FakeImmich.B, FakeImmich.A, FakeImmich.C), r.assets.map { it.id })
        assertEquals("2024-05-20T17:30:00", r.assets[0].takenAt)
        // Orientation 6: the shown shape is swapped.
        assertEquals(0.75, r.assets[1].aspect, 1e-9)
        assertTrue(fake.requests.last().body!!.utf8().contains("\"isFavorite\":true"))
    }

    // AC 4: a key without person.read gets 403 on People (the caption names it); Test lists the missing permissions.
    @Test
    fun missingScopes() = runBlocking {
        fake.scopes = setOf("asset.read", "asset.view", "album.read")
        try {
            client().people()
            fail("people without person.read")
        } catch (e: ImmichException) {
            assertEquals(403, e.status)
        }
        assertEquals(2, client().albums().size)
        val t = ImmichClient(source!!.url, FakeImmich.KEY, http).test()
        assertTrue(t.ok)
        assertEquals(listOf("person.read", "map.read", "memory.read"), t.missing)
        fake.scopes = setOf("asset.read")
        assertEquals(listOf("asset.view", "album.read", "person.read", "map.read", "memory.read"), ImmichClient(source!!.url, FakeImmich.KEY, http).test().missing)
    }

    @Test
    fun versionAndKeyChecks() = runBlocking {
        source = null
        assertEquals(ImmichProbe(false, "auth", "3.3.0"), ImmichClient(server.url("/").toString().trimEnd('/'), "wrong", http).test())
        fake.version = "1.106.4"
        assertEquals(ImmichProbe(false, "version", "1.106.4"), ImmichClient(server.url("/").toString().trimEnd('/'), FakeImmich.KEY, http).test())
        assertEquals("network", ImmichClient("http://127.0.0.1:1", FakeImmich.KEY, http).test().error)
    }

    @Test
    fun albumsPeopleMemoriesDetail() = runBlocking {
        val albums = client().albums()
        assertEquals(listOf("Garden", "Mountains"), albums.map { it.name })
        assertTrue(albums[0].shared)
        assertEquals(listOf("Alex"), client().people().map { it.name })
        val mem = client().memories("2026-01-10")
        assertEquals(3, mem.single().first)
        val d = client().detail(FakeImmich.A)
        assertEquals(1 / 250.0, d.exposureTime!!, 1e-9)
        assertEquals(2.8, d.aperture!!, 1e-9)
        assertEquals(200, d.isoSpeedRating)
        client().setFavorite(FakeImmich.A, true)
        assertEquals("PUT", fake.requests.last().method)
    }

    // AC 1: the key only in the x-api-key header, only to the configured server; never in a URL; a redirect to
    // another host loses it.
    @Test
    fun keyStaysInTheHeaderAndOnItsServer() = runBlocking {
        client().albums()
        http.newCall(Request.Builder().url(client().thumb(FakeImmich.A, "thumbnail")).build()).execute().close()
        assertTrue(fake.requests.all { it.url.toString().contains(FakeImmich.KEY).not() })
        assertTrue(fake.requests.all { it.headers[IMMICH_HEADER] == FakeImmich.KEY })
        val other = MockWebServer()
        other.start()
        try {
            other.enqueue(MockResponse.Builder().code(200).body("ok").build())
            http.newCall(Request.Builder().url(other.url("/api/albums")).build()).execute().close()
            assertNull(other.takeRequest().headers[IMMICH_HEADER])
            // A redirect from the Immich origin to another one: the follow-up carries no key.
            other.enqueue(MockResponse.Builder().code(200).body("ok").build())
            val redirect = MockWebServer()
            redirect.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = MockResponse.Builder().code(302).addHeader("Location", other.url("/elsewhere").toString()).build()
            }
            redirect.start()
            source = source!!.copy(url = redirect.url("/").toString().trimEnd('/'))
            http.newCall(Request.Builder().url(redirect.url("/api/albums")).build()).execute().close()
            assertNull(other.takeRequest().headers[IMMICH_HEADER])
            redirect.close()
        } finally {
            other.close()
        }
    }
}
