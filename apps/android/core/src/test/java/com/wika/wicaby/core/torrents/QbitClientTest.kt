package com.wika.wicaby.core.torrents

import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.net.URLDecoder

// A small fake of the qBittorrent Web API v2: login with a session cookie, CSRF checks
// on Referer/Origin, 403 on a missing/expired session, the 4.x/5.x pause|stop rename,
// and scripted sync/maindata replies.
class FakeQbit(var version: String = "v5.0.2", val cookieName: String = "SID", val hideVersion: Boolean = false) : Dispatcher() {
    val calls = mutableListOf<String>()
    val bodies = mutableMapOf<String, String>()
    val maindata = ArrayDeque<String>()
    val rids = mutableListOf<String?>()
    var logins = 0
    var altSpeed = false
    var origin = ""
    private val sessions = mutableSetOf<String>()

    fun expireSessions() = sessions.clear()

    private fun ok(body: String = "Ok.") = MockResponse.Builder().code(200).body(body).build()
    private fun status(code: Int, body: String = "") = MockResponse.Builder().code(code).body(body).build()

    private fun form(body: String): Map<String, String> = body.split('&').filter { '=' in it }.associate {
        URLDecoder.decode(it.substringBefore('='), "UTF-8") to URLDecoder.decode(it.substringAfter('='), "UTF-8")
    }

    override fun dispatch(request: RecordedRequest): MockResponse {
        val path = request.url.encodedPath.removePrefix("/api/v2/")
        val body = request.body?.utf8().orEmpty()
        calls += path
        bodies[path] = body
        // CSRF: qBittorrent answers 401 when Referer/Origin do not match the host.
        val ref = request.headers["Referer"].orEmpty()
        if (request.headers["Origin"] != origin || !ref.startsWith(origin)) return status(401, "Unauthorized")

        if (path == "auth/login") {
            logins++
            val f = form(body)
            if (f["username"] != "admin" || f["password"] != "secret") return ok("Fails.")
            val sid = "s$logins"
            sessions += sid
            return MockResponse.Builder().code(200).body("Ok.").addHeader("Set-Cookie", "$cookieName=$sid; HttpOnly; SameSite=Strict; path=/").build()
        }
        val cookie = request.headers["Cookie"].orEmpty().split(';').map { it.trim() }
            .firstOrNull { it.startsWith("$cookieName=") }?.substringAfter('=')
        if (cookie == null || cookie !in sessions) return status(403, "Forbidden")

        val modern = version.removePrefix("v").substringBefore('.').toInt() >= 5
        return when (path) {
            "app/version" -> if (hideVersion) status(404) else ok(version)
            "app/webapiVersion" -> if (hideVersion) status(404) else ok(if (modern) "2.11.2" else "2.9.3")
            "torrents/pause", "torrents/resume" -> if (modern) status(404, "Not Found") else ok("")
            "torrents/stop", "torrents/start" -> if (modern) ok("") else status(404, "Not Found")
            "torrents/add", "torrents/delete", "torrents/setCategory" -> ok()
            "transfer/toggleSpeedLimitsMode" -> {
                altSpeed = !altSpeed
                ok("")
            }
            "transfer/speedLimitsMode" -> ok(if (altSpeed) "1" else "0")
            "torrents/categories" -> ok("""{"films":{"name":"films","savePath":"/data/films"}}""")
            "transfer/info" -> ok("""{"dl_info_speed":100,"up_info_speed":50,"connection_status":"connected"}""")
            "sync/maindata" -> {
                rids += request.url.queryParameter("rid")
                ok(maindata.removeFirstOrNull() ?: """{"rid":99}""")
            }
            else -> status(404, "Not Found")
        }
    }
}

class QbitClientTest {
    private lateinit var server: MockWebServer
    private lateinit var fake: FakeQbit
    private val http = OkHttpClient()

    private fun start(f: FakeQbit) {
        fake = f
        server.dispatcher = f
        server.start()
        f.origin = "http://${server.hostName}:${server.port}"
    }

    private fun client(user: String = "admin", pass: String = "secret") = QbitClient("${server.hostName}:${server.port}", user, pass, http)

    @Before
    fun setUp() {
        server = MockWebServer()
    }

    @After
    fun tearDown() {
        server.close()
    }

    @Test
    fun loginThenCookieAndCsrfHeaders() = runBlocking {
        start(FakeQbit("v4.6.7"))
        val c = client()
        assertEquals("v4.6.7", c.version())
        assertEquals(listOf("auth/login", "app/version"), fake.calls)
        assertEquals("username=admin&password=secret", fake.bodies["auth/login"])
        assertEquals(1, fake.logins)
    }

    @Test
    fun newCookieNameIsReplayedToo() = runBlocking {
        start(FakeQbit("v5.1.0", cookieName = "QBT_SID_8080"))
        assertEquals("v5.1.0", client().version())
    }

    @Test
    fun badCredentials() = runBlocking {
        start(FakeQbit())
        try {
            client(pass = "nope").version()
            fail("expected an auth error")
        } catch (e: QbitException) {
            assertEquals(QbitException.Kind.Auth, e.kind)
        }
    }

    @Test
    fun reloginOnExpiredSession() = runBlocking {
        start(FakeQbit())
        val c = client()
        c.version()
        fake.expireSessions()
        c.toggleAltSpeed()
        assertTrue(fake.altSpeed)
        assertEquals(2, fake.logins)
        assertEquals(listOf("auth/login", "app/version", "transfer/toggleSpeedLimitsMode", "auth/login", "transfer/toggleSpeedLimitsMode"), fake.calls)
        assertTrue(c.altSpeedEnabled())
    }

    @Test
    fun v4UsesPauseResume() = runBlocking {
        start(FakeQbit("v4.6.7"))
        val c = client()
        c.pause(listOf("aaa", "bbb"))
        c.resume(emptyList())
        assertEquals(listOf("auth/login", "app/version", "torrents/pause", "torrents/resume"), fake.calls)
        assertEquals("hashes=aaa%7Cbbb", fake.bodies["torrents/pause"])
        assertEquals("hashes=all", fake.bodies["torrents/resume"])
    }

    @Test
    fun v5UsesStopStart() = runBlocking {
        start(FakeQbit("v5.0.2"))
        val c = client()
        c.pause(listOf("aaa"))
        c.resume(listOf("aaa"))
        assertEquals(listOf("auth/login", "app/version", "torrents/stop", "torrents/start"), fake.calls)
    }

    @Test
    fun unknownVersionFallsBackOn404() = runBlocking {
        start(FakeQbit("v5.0.2", hideVersion = true))
        val c = client()
        c.pause(listOf("aaa"))
        // Guessed 4.x (no version info): pause 404s, stop works, and the choice sticks.
        c.pause(listOf("bbb"))
        assertEquals(
            listOf("auth/login", "app/version", "app/webapiVersion", "torrents/pause", "torrents/stop", "torrents/stop"),
            fake.calls,
        )
    }

    @Test
    fun addDeleteCategory() = runBlocking {
        start(FakeQbit())
        val c = client()
        c.addUrls(listOf("magnet:?xt=urn:btih:abc", "https://x.org/a.torrent"), AddOptions(category = "films", paused = true))
        val add = fake.bodies.getValue("torrents/add")
        assertTrue(add, add.contains("name=\"urls\"") && add.contains("magnet:?xt=urn:btih:abc\nhttps://x.org/a.torrent"))
        assertTrue(add.contains("name=\"category\"") && add.contains("films"))
        assertTrue(add.contains("name=\"paused\"") && add.contains("name=\"stopped\""))

        c.addFile("ubuntu.torrent", "d8:announce0:e".toByteArray())
        val file = fake.bodies.getValue("torrents/add")
        assertTrue(file, file.contains("name=\"torrents\"; filename=\"ubuntu.torrent\"") && file.contains("application/x-bittorrent") && file.contains("d8:announce0:e"))
        assertFalse(file.contains("name=\"paused\""))

        c.remove(listOf("aaa"), deleteFiles = true)
        assertEquals("hashes=aaa&deleteFiles=true", fake.bodies["torrents/delete"])
        c.remove(listOf("aaa"), deleteFiles = false)
        assertEquals("hashes=aaa&deleteFiles=false", fake.bodies["torrents/delete"])

        c.setCategory(listOf("aaa"), "films")
        assertEquals("hashes=aaa&category=films", fake.bodies["torrents/setCategory"])
        assertEquals("/data/films", c.categories().getValue("films").savePath)
        assertEquals(100L, c.transferInfo().dlSpeed)
    }

    @Test
    fun syncSendsRidAndMerges() = runBlocking {
        start(FakeQbit())
        fake.maindata += """{"rid":5,"full_update":true,"torrents":{"aaa":{"name":"Alpha","progress":0.1,"state":"downloading"}},"server_state":{"dl_info_speed":10}}"""
        fake.maindata += """{"rid":6,"torrents":{"aaa":{"progress":0.2}},"server_state":{"use_alt_speed_limits":true}}"""
        val c = client()
        var d = c.sync(MainData())
        d = c.sync(d)
        assertEquals(listOf("0", "5"), fake.rids)
        assertEquals(6L, d.rid)
        val a = d.torrentList().single()
        assertEquals("Alpha", a.name)
        assertEquals(0.2f, a.progress, 0f)
        assertTrue(d.serverState().altSpeed)
        assertEquals(10L, d.serverState().dlSpeed)
    }
}
