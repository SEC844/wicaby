package com.wika.wicaby.core.scrobble

import com.wika.wicaby.core.data.Item
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.Collections

private const val LB_TOKEN = "lb-token-0123456789"
private val FM_KEY = "a".repeat(32)
private val FM_SECRET = "b".repeat(32)
private const val SK = "session-key-xyz"

// ListenBrainz and Last.fm on loopback. [down] answers 503 to every submission; the Last.fm session is given on the
// second auth.getSession (the first says "not authorized yet", error 14).
private class FakeServices : Dispatcher() {
    @Volatile var down = false
    val sent: MutableList<String> = Collections.synchronizedList(mutableListOf())
    val bodies: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private var polls = 0

    private fun send(code: Int, body: String) = MockResponse.Builder().code(code).body(body).build()

    override fun dispatch(request: RecordedRequest): MockResponse {
        val body = request.body?.utf8().orEmpty()
        if (request.url.encodedPath.startsWith("/1/")) {
            if (request.headers["Authorization"] != "Token $LB_TOKEN") return send(401, """{"code":401}""")
            if (request.url.encodedPath == "/1/validate-token") return send(200, """{"valid":true,"user_name":"wika"}""")
            if (down) return send(503, "")
            bodies += body
            sent += "lb:" + body.substringAfter("\"listen_type\":\"").substringBefore('"')
            return send(200, """{"status":"ok"}""")
        }
        val p = if (request.method == "POST") "http://x/?$body".toHttpUrl() else request.url
        val params = p.queryParameterNames.associateWith { p.queryParameter(it)!! }
        assertEquals("json", params["format"])
        assertEquals(lastfmSign(params - "api_sig", FM_SECRET), params["api_sig"])
        return when (params["method"]) {
            "auth.getToken" -> send(200, """{"token":"tok"}""")
            "auth.getSession" -> if (++polls < 2) send(403, """{"error":14,"message":"not authorized"}""") else send(200, """{"session":{"name":"wika","key":"$SK","subscriber":0}}""")
            else -> {
                if (down) return send(200, """{"error":16,"message":"temporarily unavailable"}""")
                assertEquals(SK, params["sk"])
                sent += "fm:" + params["method"]
                send(200, """{"scrobbles":{"@attr":{"accepted":1}}}""")
            }
        }
    }
}

private class MemStore : ScrobbleStore {
    @Volatile var accounts = ScrobbleAccounts()
    @Volatile var q = emptyList<QueuedListen>()
    override suspend fun load() = accounts
    override suspend fun save(a: ScrobbleAccounts) { accounts = a }
    override suspend fun queue() = q
    override suspend fun setQueue(q: List<QueuedListen>) { this.q = q }
}

class ScrobbleTest {
    private lateinit var server: MockWebServer
    private lateinit var scope: CoroutineScope
    private val song = Item(
        "a1", name = " Song ", type = "Audio", artists = listOf("A", " B "), albumArtist = "A", album = "Album",
        runTimeTicks = 40_000L * 10_000, indexNumber = 3, providerIds = mapOf("MusicBrainzRecording" to "0F3B6E2A-8C3E-4B8E-9F4D-1A2B3C4D5E6F", "MusicBrainzAlbum" to "nope"),
    )

    @Before
    fun setUp() {
        server = MockWebServer()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }

    @After
    fun tearDown() {
        scope.cancel()
        server.close()
    }

    private suspend fun until(ms: Long = 10_000, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + ms
        while (!cond()) {
            if (System.currentTimeMillis() > end) fail("timed out")
            delay(20)
        }
    }

    @Test
    fun ruleAndPayloads() {
        assertFalse("under 30 s never", shouldScrobble(29_000, 29_000))
        assertTrue("half of a 30 s track", shouldScrobble(30_000, 15_000))
        assertFalse(shouldScrobble(200_000, 99_999))
        assertTrue(shouldScrobble(200_000, 100_000))
        assertTrue("4 min of a long track", shouldScrobble(1_200_000, 240_000))
        assertFalse(shouldScrobble(1_200_000, 239_999))
        assertFalse("unknown length: 4 min", shouldScrobble(0, 239_999))
        assertTrue(shouldScrobble(0, 240_000))

        val info = trackInfo(song)!!
        assertEquals(TrackInfo(listOf("A", "B"), "Song", "Album", "A", 40_000, 3, mapOf("recording_mbid" to "0f3b6e2a-8c3e-4b8e-9f4d-1a2b3c4d5e6f")), info)
        assertNull("only songs", trackInfo(song.copy(type = "Movie")))
        assertNull("no title", trackInfo(song.copy(name = "")))
        assertEquals("album artist fallback", listOf("Z"), trackInfo(Item("x", name = "T", type = "Audio", albumArtist = "Z"))!!.artists)
        assertNull("no artist", trackInfo(Item("x", name = "T", type = "Audio")))

        val single = listenBody(info, 1_700_000_000, "1.2.3")
        assertEquals("single", single["listen_type"]!!.jsonPrimitive.content)
        val listen = single["payload"]!!.jsonArray[0].jsonObject
        assertEquals("1700000000", listen["listened_at"]!!.jsonPrimitive.content)
        val meta = listen["track_metadata"]!!.jsonObject
        assertEquals("A, B", meta["artist_name"]!!.jsonPrimitive.content)
        assertEquals("Album", meta["release_name"]!!.jsonPrimitive.content)
        assertEquals("0f3b6e2a-8c3e-4b8e-9f4d-1a2b3c4d5e6f", meta["additional_info"]!!.jsonObject["recording_mbid"]!!.jsonPrimitive.content)
        val now = listenBody(info, null, "1.2.3")
        assertEquals("playing_now", now["listen_type"]!!.jsonPrimitive.content)
        assertNull(now["payload"]!!.jsonArray[0].jsonObject["listened_at"])

        // md5("api_keykmethodauth.getSessiontokents"): sorted, format left out, secret last.
        assertEquals("4b1fe62eb056c03672443be528ff2633", lastfmSign(mapOf("token" to "t", "method" to "auth.getSession", "api_key" to "k", "format" to "json"), "s"))
        assertEquals(
            mapOf("artist" to "A", "track" to "Song", "album" to "Album", "albumArtist" to "A", "trackNumber" to "3", "duration" to "40", "mbid" to "0f3b6e2a-8c3e-4b8e-9f4d-1a2b3c4d5e6f", "timestamp" to "123"),
            lastfmTrackParams(info, 123),
        )
    }

    @Test
    fun serviceFlow() = runBlocking {
        val f = FakeServices()
        server.dispatcher = f
        server.start()
        val base = "http://${server.hostName}:${server.port}"
        val store = MemStore()
        val svc = ScrobbleService(store, scope, "9.9.9").apply { lbBase = base; lastfmBase = "$base/2.0/" }

        // Nothing connected: nothing sent.
        svc.nowPlaying(song)
        svc.listened(song, 100, 40_000)
        delay(200)
        assertTrue("nothing sent: ${f.sent}", f.sent.isEmpty())

        assertFalse(svc.connectListenBrainz("bad token!"))
        assertFalse("refused", svc.connectListenBrainz("wrong-token-123456"))
        assertTrue(svc.connectListenBrainz(" $LB_TOKEN "))
        assertEquals("wika", svc.state.value.lbUser)
        assertFalse(svc.connectLastfm("short", "x"))
        assertTrue(svc.connectLastfm(FM_KEY, FM_SECRET))
        assertTrue("auth url", svc.state.value.authUrl!!.startsWith("https://www.last.fm/api/auth/?api_key=$FM_KEY&token=tok"))
        until { svc.state.value.fmUser == "wika" }
        assertNull(svc.state.value.authUrl)

        // Playing now, then one listen stamped with the start; too short a listen is not one.
        svc.nowPlaying(song)
        svc.listened(song, 1_700_000_000, 20_000)
        svc.listened(song, 1_700_000_100, 19_999)
        until { f.sent.size == 4 }
        delay(200)
        assertEquals(listOf("lb:playing_now", "fm:track.updateNowPlaying", "lb:single", "fm:track.scrobble"), f.sent.toList())
        assertTrue("listened_at: ${f.bodies}", f.bodies.last().contains("\"listened_at\":1700000000"))

        // Offline: both kept (persisted in the store), and sent with the next listen that goes through.
        f.down = true
        svc.listened(song, 1_700_000_200, 40_000)
        until { svc.state.value.queued == 2 }
        assertEquals(2, store.q.size)
        f.down = false
        f.sent.clear()
        svc.listened(song, 1_700_000_300, 40_000)
        until { svc.state.value.queued == 0 }
        assertEquals(listOf("lb:single", "fm:track.scrobble", "lb:single", "fm:track.scrobble"), f.sent.toList())

        // Capped at 500, oldest dropped.
        val info = trackInfo(song)!!
        store.q = List(500) { QueuedListen("lastfm", it.toLong(), info) }
        f.down = true
        svc.listened(song, 1_700_000_400, 40_000)
        until { store.q.lastOrNull()?.at == 1_700_000_400L && store.q.size == 500 }
        assertEquals("the oldest went", 2L, store.q.first().at)
        // Disconnecting drops a service's waiting listens.
        svc.disconnectLastfm()
        assertTrue("only ListenBrainz left: ${store.q.map { it.to to it.at }.takeLast(3)}", store.q.all { it.to == "listenbrainz" })
        assertNull(svc.state.value.fmUser)
        assertFalse("no secret in the accounts' text", store.accounts.toString().contains(LB_TOKEN))
    }
}
