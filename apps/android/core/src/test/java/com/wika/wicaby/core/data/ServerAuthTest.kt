package com.wika.wicaby.core.data

import com.wika.wicaby.core.net.ServerTransport
import com.wika.wicaby.core.net.TransportInterceptor
import com.wika.wicaby.core.net.origin
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

// Core.http's ServerAuthInterceptor: credentials reach the active server (or its mesh
// forwarder) and nothing else, redirects included.
class ServerAuthTest {
    private lateinit var a: MockWebServer // the active server
    private lateinit var b: MockWebServer // some other host

    @Before
    fun setUp() {
        a = MockWebServer().apply { start() }
        b = MockWebServer().apply { start() }
    }

    @After
    fun tearDown() {
        a.close()
        b.close()
    }

    private fun api(address: String) = Api(Server("srv", "Server", address, "emby"), "dev", "secret-token", "u1")

    private fun client(active: Api?, transport: ServerTransport = ServerTransport.Direct) = OkHttpClient.Builder()
        .addInterceptor(TransportInterceptor { transport })
        .addNetworkInterceptor(ServerAuthInterceptor({ transport }) { active })
        .build()

    private fun ok() = MockResponse.Builder().code(200).body("ok").build()

    private fun get(c: OkHttpClient, url: String, headers: Map<String, String> = emptyMap()) {
        val req = Request.Builder().url(url).apply { headers.forEach { (k, v) -> header(k, v) } }.build()
        c.newCall(req).execute().use { assertEquals(200, it.code) }
    }

    private fun RecordedRequest.hasNoCredentials() {
        assertNull(headers["X-Emby-Token"])
        assertNull(headers["X-Emby-Authorization"])
        assertNull(headers["Authorization"])
    }

    @Test
    fun headerOnlyForTheServerOrigin() {
        val c = client(api(a.url("/").toString().trimEnd('/')))
        a.enqueue(ok())
        b.enqueue(ok())
        get(c, a.url("/emby/Videos/1/stream").toString())
        get(c, b.url("/poster.jpg").toString())
        val atA = a.takeRequest()
        assertEquals("secret-token", atA.headers["X-Emby-Token"])
        assertTrue(atA.headers["X-Emby-Authorization"].orEmpty().startsWith("Emby "))
        b.takeRequest().hasNoCredentials()
    }

    @Test
    fun noHeaderWithoutActiveServer() {
        a.enqueue(ok())
        get(client(null), a.url("/emby/Items").toString())
        a.takeRequest().hasNoCredentials()
    }

    @Test
    fun crossHostRedirectDropsTheToken() {
        val c = client(api(a.url("/").toString().trimEnd('/')))
        a.enqueue(MockResponse.Builder().code(302).addHeader("Location", b.url("/landing").toString()).build())
        b.enqueue(ok())
        // As Api.raw / Downloads do: explicit headers on the first request.
        get(c, a.url("/emby/Items/1/Download").toString(), mapOf("X-Emby-Token" to "secret-token", "X-Emby-Authorization" to "Emby Client=\"Wicaby\""))
        assertEquals("secret-token", a.takeRequest().headers["X-Emby-Token"])
        val atB = b.takeRequest()
        assertEquals("/landing", atB.url.encodedPath)
        atB.hasNoCredentials()
    }

    @Test
    fun sameServerRedirectKeepsTheToken() {
        val c = client(api(a.url("/").toString().trimEnd('/')))
        a.enqueue(MockResponse.Builder().code(302).addHeader("Location", "/emby/next").build())
        a.enqueue(ok())
        get(c, a.url("/emby/first").toString())
        assertEquals("secret-token", a.takeRequest().headers["X-Emby-Token"])
        assertEquals("secret-token", a.takeRequest().headers["X-Emby-Token"])
    }

    @Test
    fun meshForwarderCountsAsTheServer() {
        // The stored address is only reachable on the mesh: TransportInterceptor sends it to "a/tok".
        val address = "http://media.invalid:8096"
        val forwarder = a.url("/tok").toString()
        val transport = object : ServerTransport {
            override fun forward(origin: String) = if (origin == "http://media.invalid:8096") forwarder else null
        }
        val c = client(api(address), transport)
        a.enqueue(ok())
        a.enqueue(ok())
        get(c, "$address/emby/Items")
        val atA = a.takeRequest()
        assertEquals("/tok/emby/Items", atA.url.encodedPath)
        assertEquals("secret-token", atA.headers["X-Emby-Token"])
        // Same forwarder port, another path token: not this server.
        get(c, a.url("/other/emby/Items").toString())
        a.takeRequest().hasNoCredentials()
    }

    @Test
    fun foreignAbsoluteUrlsLoseTheKey() {
        val own = "https://nas.lan:8920"
        assertEquals("https://cdn.example.org/x.m3u8?a=1", stripForeignKey("https://cdn.example.org/x.m3u8?api_key=t&ApiKey=t&a=1", own))
        assertEquals("$own/emby/x.m3u8?api_key=t", stripForeignKey("$own/emby/x.m3u8?api_key=t", own))
        assertEquals("http://nas.lan:8096/x", stripForeignKey("http://nas.lan:8096/x?API_KEY=t", own))
        assertEquals("https://nas.lan:8920/emby/x?api_key=t", api(own).resolve("https://nas.lan:8920/emby/x?api_key=t"))
        assertEquals("https://evil.example/x", api(own).resolve("https://evil.example/x?api_key=t"))
        // Encoded names the server would decode back to a token key (verifier bypass).
        assertEquals("https://evil.example/x?a=1", stripForeignKey("https://evil.example/x?api%5Fkey=t&a=1", own))
        assertEquals("https://evil.example/x", stripForeignKey("https://evil.example/x?api%5fkey=t", own))
        assertEquals("https://evil.example/x?a=1", stripForeignKey("https://evil.example/x?a=1&ApiKe%79=t", own))
        assertEquals("https://evil.example/x", stripForeignKey("https://evil.example/x?api%u005Fkey=t", own))
        assertEquals("https://evil.example/x?a=b", stripForeignKey("https://evil.example/x?X-Emby-Token=t&a=b&x-mediabrowser-token=t", own))
        assertEquals("https://evil.example/x", stripForeignKey("https://evil.example/x?a=1;api_key=t", own))
        // Look-alikes stay.
        assertEquals("https://evil.example/x?api_keys=1&api%255Fkey=2", stripForeignKey("https://evil.example/x?api_keys=1&api%255Fkey=2", own))
        assertEquals("api_key", decodeQueryName("api%5Fkey"))
        assertEquals("a b%zz%", decodeQueryName("a+b%zz%"))
    }

    @Test
    fun httpsUpgradeRedirectKeepsServerAuth() {
        val t = ServerTransport.Direct
        val start = "http://nas.lan:8096/emby/Items".toHttpUrl()
        val upgraded = "https://nas.lan:8920/emby/Items".toHttpUrl()
        assertTrue(hopKeepsCredentials(upgraded, start, t))
        assertTrue(hopGetsServerAuth(upgraded, start, "http://nas.lan:8096", t))
        // Not an upgrade: another host, a downgrade, or HTTPS to another HTTPS port.
        assertFalse(hopKeepsCredentials("https://evil.lan:8920/x".toHttpUrl(), start, t))
        assertFalse(hopGetsServerAuth("https://evil.lan:8920/x".toHttpUrl(), start, "http://nas.lan:8096", t))
        assertFalse(hopKeepsCredentials("http://nas.lan:8096/x".toHttpUrl(), upgraded, t))
        assertFalse(hopKeepsCredentials("https://nas.lan:9999/x".toHttpUrl(), upgraded, t))
        // A call that started elsewhere never gets the server's token, upgrade or not.
        assertFalse(hopGetsServerAuth(upgraded, "http://nas.lan:9000/x".toHttpUrl(), "http://nas.lan:8096", t))
    }

    @Test
    fun downloadUrlCarriesNoKey() {
        assertFalse(api("http://nas.lan:8096").downloadUrl("1", "2").contains("api_key", true))
    }

    @Test
    fun httpsCandidatesComeFirst() {
        assertEquals(listOf("https://nas.lan", "https://nas.lan:8920", "http://nas.lan:8096", "http://nas.lan"), Api.candidates("nas.lan"))
        assertEquals(listOf("https://nas.lan:9000", "http://nas.lan:9000"), Api.candidates("nas.lan:9000"))
        assertTrue(Server("i", "n", "http://nas.lan:8096", "emby").insecure)
        assertFalse(Server("i", "n", "https://nas.lan", "emby").insecure)
        assertEquals("https://nas.lan:443", Server("i", "n", "https://nas.lan/jf", "jellyfin").origin)
        assertEquals(origin(a.url("/")), Server("i", "n", a.url("/x").toString(), "emby").origin)
    }

    @Test
    fun tokensAreRedactedInToString() {
        val s = Session(Server("i", "n", "https://nas.lan", "emby"), "u", "name", "secret-token")
        assertFalse(s.toString().contains("secret-token"))
        assertFalse(AuthResult("secret-token", User("u")).toString().contains("secret-token"))
    }
}
