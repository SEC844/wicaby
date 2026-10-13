package com.wika.wicaby.core.net

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AddressesTest {
    @Test
    fun altBaseLinesUpPaths() {
        val lan = "http://192.168.1.10:8096".toHttpUrl()
        assertEquals("https://media.example.org:443", altBase(lan, "https://media.example.org".toHttpUrl()))
        assertEquals("https://example.org:443/jf", altBase(lan, "https://example.org/jf".toHttpUrl()))
        assertEquals("http://192.168.1.10:8096", altBase("https://example.org/jf".toHttpUrl(), "http://192.168.1.10:8096/jf".toHttpUrl()))
        // The stored path "/jf" cannot be dropped by a prefix rewrite.
        assertNull(altBase("https://example.org/jf".toHttpUrl(), lan))
    }

    @Test
    fun candidatesKeepTheTokenUnderTls() {
        val learned = KnownAddresses(local = "http://192.168.1.10:8096/", remote = "https://media.example.org")
        assertEquals(listOf("http://192.168.1.10:8096", "https://media.example.org"), candidates("http://192.168.1.10:8096", learned))
        // Stored HTTPS: a learned plain-HTTP address is left out, a typed one is the user's call.
        assertEquals(listOf("https://media.example.org"), candidates("https://media.example.org", learned))
        assertEquals(listOf("https://media.example.org", "http://192.168.1.10:8096"), candidates("https://media.example.org", learned.copy(edited = true)))
        assertEquals(listOf("http://nas:8096"), candidates("http://nas:8096", KnownAddresses(local = "not a url")))
    }

    @Test
    fun learnsLanHttpAndHttpsRemoteOnly() {
        val info = PublicInfo("id", localAddress = "http://192.168.1.10:8096", wanAddress = "http://82.1.2.3:8096")
        assertEquals(KnownAddresses("http://192.168.1.10:8096", null), learned(KnownAddresses(), info))
        assertEquals(
            KnownAddresses("http://192.168.1.10:8096", "https://media.example.org"),
            learned(KnownAddresses(), info.copy(wanAddress = "https://media.example.org/")),
        )
        val typed = KnownAddresses("http://10.0.0.2:8096", "https://x.example", edited = true)
        assertEquals(typed, learned(typed, info))
    }

    @Test
    fun theFirstAddressAnsweringAsTheServerWins() = runBlocking {
        val lan = "http://192.168.1.10:8096"
        val wan = "https://media.example.org"
        // Away from home: the LAN address times out, the remote one answers.
        val away = firstAnswering(listOf(lan, wan), "srv") { a -> if (a == lan) { delay(500); null } else { delay(20); PublicInfo("srv") } }
        assertEquals(wan, away?.first)
        // At home both answer: the faster LAN one.
        val home = firstAnswering(listOf(lan, wan), "srv") { a -> delay(if (a == lan) 5 else 80); PublicInfo("srv") }
        assertEquals(lan, home?.first)
        // Another server on that LAN address (another network's 192.168.1.10) never counts.
        val other = firstAnswering(listOf(lan, wan), "srv") { a -> if (a == lan) PublicInfo("other") else { delay(30); PublicInfo("srv") } }
        assertEquals(wan, other?.first)
        assertNull(firstAnswering(listOf(lan), "srv") { throw java.io.IOException("unreachable") })
    }

    @Test
    fun forwardsToTheAddressInUseThroughTheMesh() {
        val mesh = object : ServerTransport {
            override fun forward(origin: String) = if (origin == "http://100.64.0.5:8096") "http://127.0.0.1:41234/tok" else null
        }
        val sw = AddressSwitch(mesh) { emptyList() }
        // Nothing picked: the stored address, or the mesh for a mesh peer.
        assertNull(sw.forward("http://192.168.1.10:8096"))
        assertEquals("http://127.0.0.1:41234/tok", sw.forward("http://100.64.0.5:8096"))
        // Away: the LAN-stored server answers on its remote address (with a path), or on a mesh peer.
        sw.use("srv", "http://192.168.1.10:8096", "https://example.org:443/jf", "https://example.org/jf")
        assertEquals("https://example.org:443/jf", sw.forward("http://192.168.1.10:8096"))
        val url = rewrite("http://192.168.1.10:8096/Items?x=1".toHttpUrl(), sw.forward("http://192.168.1.10:8096")!!)
        assertEquals("https://example.org/jf/Items?x=1", url.toString())
        // ServerAuthInterceptor still treats the rewritten hop as the server (its credentials go there, and only there).
        assertEquals(true, com.wika.wicaby.core.data.isServerUrl(url, "http://192.168.1.10:8096", sw))
        assertEquals(false, com.wika.wicaby.core.data.isServerUrl("https://example.org/other".toHttpUrl(), "http://192.168.1.10:8096", sw))
        sw.use("srv", "http://192.168.1.10:8096", "http://100.64.0.5:8096", "http://100.64.0.5:8096")
        assertEquals("http://127.0.0.1:41234/tok", sw.forward("http://192.168.1.10:8096"))
        sw.use("srv", "http://192.168.1.10:8096", null, "http://192.168.1.10:8096")
        assertNull(sw.forward("http://192.168.1.10:8096"))
    }

    @Test
    fun probesBypassTheSwitchAndFailuresAreReported() {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().code(200).body("ok").build())
            val stored = "http://127.0.0.1:9" // discard port: nothing answers there
            val sw = AddressSwitch(ServerTransport.Direct) { emptyList() }
            sw.use("srv", stored, origin(server.url("/")), server.url("/").toString())
            val client = OkHttpClient.Builder().addInterceptor(TransportInterceptor { sw }).build()
            client.newCall(Request.Builder().url("$stored/System/Info/Public").build()).execute().use { assertEquals(200, it.code) }
            assertEquals("/System/Info/Public", server.takeRequest().target)
            // A probe of the stored address goes to it, not to the address in use.
            val probe = runCatching { client.newCall(Request.Builder().url("$stored/y").tag(AsAddressed::class.java, AsAddressed).build()).execute().close() }
            assertEquals(true, probe.isFailure)
            assertEquals(1, server.requestCount)
        }
        // A failing call reports its stored origin, a failing probe does not.
        val failed = mutableListOf<String>()
        val t = object : ServerTransport {
            override fun forward(origin: String): String? = null
            override fun failed(origin: String) { failed += origin }
        }
        val c = OkHttpClient.Builder().addInterceptor(TransportInterceptor { t }).build()
        runCatching { c.newCall(Request.Builder().url("http://127.0.0.1:9/x").build()).execute().close() }
        runCatching { c.newCall(Request.Builder().url("http://127.0.0.1:9/y").tag(AsAddressed::class.java, AsAddressed).build()).execute().close() }
        assertEquals(listOf("http://127.0.0.1:9"), failed)
    }
}
