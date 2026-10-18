package com.wika.wicaby.core.files

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.ServerAuthInterceptor
import com.wika.wicaby.core.net.ServerTransport
import com.wika.wicaby.core.net.TransportInterceptor
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test

// FS-09 RoutingDataSourceTest: FileSources.calls (what Media3 and Coil use) sends a WebDAV source's URLs through that
// source's client, with Basic auth for its origin and base path only; everything else keeps the shared client
// (Core.http's chain here: transport + per-hop credentials), which never carries a source's password. A redirect off
// the source's host drops Authorization (OkHttp's own rule, locked in), and a loopback gateway URL gets no server auth.
class RoutingTest {
    private lateinit var dav: MockWebServer
    private lateinit var other: MockWebServer
    private val creds = FileCredentials("demo", "demo")
    private val basic = okhttp3.Credentials.basic("demo", "demo")

    @Before
    fun setUp() {
        dav = MockWebServer().apply { start() }
        other = MockWebServer().apply { start() }
    }

    @After
    fun tearDown() {
        dav.close()
        other.close()
    }

    // Core.http's interceptors, with an Emby server active somewhere else (192.0.2.10 is never contacted).
    private val shared = OkHttpClient.Builder()
        .addInterceptor(TransportInterceptor { ServerTransport.Direct })
        .addNetworkInterceptor(ServerAuthInterceptor({ ServerTransport.Direct }) { Api(Server("srv", "Server", "http://192.0.2.10:8096", "emby"), "dev", "server-token", "u1") })
        .build()

    private fun ok() = MockResponse.Builder().code(200).body("ok").build()

    private fun get(url: String) {
        val source = FilesTestKit.source(dav.url("/media").toString().trimEnd('/'))
        val client = davClient(shared, source, creds)
        val routed = FileSources.route(url.toHttpUrl(), listOf(source.url.toHttpUrl() to client), shared)
        routed.newCall(Request.Builder().url(url).build()).execute().use { assertEquals(200, it.code) }
    }

    @Test
    fun basicAuthGoesToTheSourceOnly() {
        dav.enqueue(ok())
        get(dav.url("/media/Films/a.mkv").toString())
        val r = dav.takeRequest()
        assertEquals(basic, r.headers["Authorization"])
        assertNull(r.headers["X-Emby-Token"])
        // The same host outside the source's base path: no password.
        dav.enqueue(ok())
        get(dav.url("/other/x").toString())
        assertNull(dav.takeRequest().headers["Authorization"])
        // Another host (a trailer, a server image): the shared client, nothing of the source.
        other.enqueue(ok())
        get(other.url("/img.jpg").toString())
        val o = other.takeRequest()
        assertNull(o.headers["Authorization"])
        assertNull(o.headers["X-Emby-Token"])
    }

    @Test
    fun basicAuthSurvivesTheMeshForwarder() {
        // A source on a mesh address (192.0.2.50 is never contacted) reached through the local forwarder at [dav].
        val forwarder = dav.url("/tok").toString()
        val mesh = OkHttpClient.Builder()
            .addInterceptor(TransportInterceptor { object : ServerTransport { override fun forward(origin: String) = forwarder.takeIf { origin == "http://192.0.2.50:8080" } } })
            .build()
        val source = FilesTestKit.source("http://192.0.2.50:8080/media")
        dav.enqueue(ok())
        davClient(mesh, source, creds).newCall(Request.Builder().url("http://192.0.2.50:8080/media/a.mkv").build()).execute().use { assertEquals(200, it.code) }
        val r = dav.takeRequest()
        assertEquals("/tok/media/a.mkv", r.target)
        assertEquals(basic, r.headers["Authorization"])
    }

    @Test
    fun aRedirectOffTheHostDropsAuthorization() {
        dav.enqueue(MockResponse.Builder().code(302).addHeader("Location", other.url("/elsewhere.mkv")).build())
        other.enqueue(ok())
        get(dav.url("/media/redirect.mkv").toString())
        assertEquals(basic, dav.takeRequest().headers["Authorization"])
        assertNull("the password stays on the source's host", other.takeRequest().headers["Authorization"])
    }

    @Test
    fun routingPicksTheSourceClientByOriginAndPath() {
        val a = OkHttpClient()
        val fallback = OkHttpClient()
        val sources = listOf("https://dav.example/media".toHttpUrl() to a)
        assertSame(a, FileSources.route("https://dav.example/media/x.mkv".toHttpUrl(), sources, fallback))
        assertSame(a, FileSources.route("https://dav.example/media".toHttpUrl(), sources, fallback))
        assertSame(fallback, FileSources.route("https://dav.example/media-private/x.mkv".toHttpUrl(), sources, fallback))
        assertSame(fallback, FileSources.route("http://dav.example/media/x.mkv".toHttpUrl(), sources, fallback))
        assertSame(fallback, FileSources.route("https://dav.example:8443/media/x.mkv".toHttpUrl(), sources, fallback))
        assertSame(fallback, FileSources.route("http://127.0.0.1:41234/tok/f/x.mkv".toHttpUrl(), sources, fallback))
    }

    @Test
    fun theLoopbackGatewayGetsNoServerAuth() {
        // An SMB file through the gateway (http://127.0.0.1:<port>/<token>/f/...) plays through the shared client.
        dav.enqueue(ok())
        shared.newCall(Request.Builder().url(dav.url("/tok/f/Films/a.mkv")).build()).execute().use { assertEquals(200, it.code) }
        val r = dav.takeRequest()
        assertNull(r.headers["Authorization"])
        assertNull(r.headers["X-Emby-Token"])
        assertEquals("/tok/f/Films/a.mkv", r.url.encodedPath)
    }
}
