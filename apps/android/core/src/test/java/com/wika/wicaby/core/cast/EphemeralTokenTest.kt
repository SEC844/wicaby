package com.wika.wicaby.core.cast

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

// cast/EphemeralToken (cast spec CA-11) against mockwebserver3 as a Jellyfin with Quick Connect: the token is minted as
// the cast's own device (never with the user token on the anonymous calls), kept until revoked, Logout sent with the
// token itself; Quick Connect off, Emby or a failure fall back to the user token (null); a cleanup revokes what a crash
// left, leaves a live sender cast alone, and keeps a receiver token while its session is listed.
class EphemeralTokenTest {
    private lateinit var server: MockWebServer
    private val calls = CopyOnWriteArrayList<RecordedRequest>()
    @Volatile private var enabled = true
    @Volatile private var authorizeCode = 200
    @Volatile private var logoutCode: Int? = null
    // Tokens the server accepts, and devices GET /Sessions?DeviceId= lists.
    private val valid: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val listed: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private var minted = 0
    @Volatile private var stored = ""
    private fun store() = EphemeralTokens(load = { stored }, save = { stored = it })

    private fun field(r: RecordedRequest, name: String) = Regex("""$name="([^"]*)"""").find(r.headers["Authorization"].orEmpty())?.groupValues?.get(1)?.let { java.net.URLDecoder.decode(it, "UTF-8") }

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                calls += request
                val ok = { body: String -> MockResponse.Builder().body(body).build() }
                return when (request.url.encodedPath) {
                    "/QuickConnect/Enabled" -> ok("$enabled")
                    "/QuickConnect/Initiate" -> ok("""{"Code":"123456","Secret":"s3cr3t","Authenticated":false}""")
                    "/QuickConnect/Authorize" -> MockResponse.Builder().code(authorizeCode).body("true").build()
                    "/Users/AuthenticateWithQuickConnect" -> {
                        if (!request.body!!.utf8().contains("\"s3cr3t\"")) return MockResponse.Builder().code(401).build()
                        val t = "tok-${++minted}"
                        valid += t
                        listed += field(request, "DeviceId")!!
                        ok("""{"AccessToken":"$t","User":{"Id":"u1","Name":"Wika"}}""")
                    }
                    "/Sessions/Logout" -> {
                        logoutCode?.let { return MockResponse.Builder().code(it).build() }
                        if (valid.remove(field(request, "Token"))) MockResponse.Builder().code(204).build() else MockResponse.Builder().code(401).build()
                    }
                    "/Sessions" -> ok(if (request.url.queryParameter("DeviceId") in listed) """[{"Id":"s1"}]""" else "[]")
                    else -> MockResponse.Builder().code(404).build()
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() = server.close()

    private fun api(kind: String = "jellyfin", id: String = "srv1") = Api(Server(id, "NAS", server.url("/").toString().trimEnd('/'), kind), "phone", "user-token", "u1")
    private fun path(p: String) = calls.filter { it.url.encodedPath == p }

    @Test
    fun mintsAsTheCastDevice() = runBlocking {
        val tokens = store()
        val d = tokens.mint(api(), "Living room TV", EphemeralTokens.SENDER)!!
        assertEquals("tok-1", d.token)
        assertEquals(listOf(d), tokens.list())
        assertFalse(d.toString().contains("tok-1"))
        val init = path("/QuickConnect/Initiate").single()
        assertEquals("Wicaby Cast", field(init, "Client"))
        assertEquals("Living room TV", field(init, "Device"))
        assertTrue("spaces as %20, which every server decodes", init.headers["Authorization"]!!.contains("Device=\"Living%20room%20TV\""))
        assertEquals(d.deviceId, field(init, "DeviceId"))
        assertTrue(d.deviceId.length >= 32 && d.deviceId != "phone")
        assertNull("no token on the anonymous Initiate", field(init, "Token"))
        val authorize = path("/QuickConnect/Authorize").single()
        assertEquals("123456", authorize.url.queryParameter("code"))
        assertEquals("user-token", field(authorize, "Token"))
        val auth = path("/Users/AuthenticateWithQuickConnect").single()
        assertEquals(d.deviceId, field(auth, "DeviceId"))
        assertNull(field(auth, "Token"))
        assertTrue(calls.none { it.url.encodedPath != "/QuickConnect/Authorize" && it.url.encodedPath != "/QuickConnect/Enabled" && it.headers.toString().contains("user-token") })

        // Logout with the token itself; it leaves the store.
        assertTrue(tokens.revoke(d, api()))
        assertEquals("tok-1", field(path("/Sessions/Logout").single(), "Token"))
        assertEquals(emptyList<Disposable>(), tokens.list())
        assertEquals("", stored)
    }

    @Test
    fun fallsBackWithoutAnError() = runBlocking {
        val tokens = store()
        enabled = false
        assertNull(tokens.mint(api(), "TV", EphemeralTokens.SENDER))
        assertTrue(path("/QuickConnect/Initiate").isEmpty())
        enabled = true
        assertNull("Emby has no Quick Connect", tokens.mint(api("emby"), "TV", EphemeralTokens.SENDER))
        assertTrue(calls.none { it.url.encodedPath.contains("QuickConnect") && it.url.encodedPath.startsWith("/emby") })
        authorizeCode = 500
        assertNull(tokens.mint(api(), "TV", EphemeralTokens.SENDER))
        assertTrue(tokens.list().isEmpty())
    }

    @Test
    fun cleanupRevokesLeftovers() = runBlocking {
        val first = store()
        val sender = first.mint(api(), "TV", EphemeralTokens.SENDER)!!
        val receiver = first.mint(api(), "Chromecast", EphemeralTokens.RECEIVER)!!
        // The live cast's token stays; the receiver's session is listed.
        first.cleanup(api())
        assertEquals(setOf("tok-1", "tok-2"), valid)

        // Another server's cleanup leaves them alone.
        store().cleanup(api(id = "other"))
        assertEquals(2, store().list().size)

        // A failed revoke keeps the token for later.
        logoutCode = 500
        store().cleanup(api())
        assertEquals(2, store().list().size)
        logoutCode = null

        // The next start (a new process): the sender's leftover goes, the receiver's waits for its session to go.
        val next = store()
        next.cleanup(api())
        assertEquals(setOf("tok-2"), valid)
        assertEquals(listOf(receiver), next.list())
        listed -= receiver.deviceId
        next.cleanup(api())
        assertTrue(valid.isEmpty())
        assertTrue(next.list().isEmpty())
        assertNotNull(sender)
        // Already revoked elsewhere: a 401 counts as gone.
        assertTrue(next.revoke(sender, api()))
    }
}
