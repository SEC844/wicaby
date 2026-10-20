package com.wika.wicaby.core.data

import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

// Api.quickConnect against mockwebserver3 as a Jellyfin: the code is shown, polled until approved, then exchanged for a
// token; an expired code (Connect 404) gets a fresh one; Emby and Quick Connect off are never offered; Authorize sends the code.
class QuickConnectTest {
    private lateinit var server: MockWebServer
    private val calls = CopyOnWriteArrayList<RecordedRequest>()
    @Volatile private var enabled = true
    @Volatile private var initiated = 0
    @Volatile private var polls = 0

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                calls += request
                val ok = { body: String -> MockResponse.Builder().body(body).build() }
                return when (request.url.encodedPath) {
                    "/QuickConnect/Enabled" -> ok("$enabled")
                    "/QuickConnect/Initiate" -> { initiated++; ok("""{"Code":"00000$initiated","Secret":"s$initiated","Authenticated":false}""") }
                    // The first code expires; the second is approved on its second poll.
                    "/QuickConnect/Connect" -> when (request.url.queryParameter("secret")) {
                        "s1" -> MockResponse.Builder().code(404).build()
                        "s2" -> ok("""{"Code":"000002","Secret":"s2","Authenticated":${++polls >= 2}}""")
                        else -> MockResponse.Builder().code(404).build()
                    }
                    "/Users/AuthenticateWithQuickConnect" ->
                        if (request.body!!.utf8() == """{"Secret":"s2"}""") ok("""{"AccessToken":"tok","User":{"Id":"u1","Name":"Wika"}}""")
                        else MockResponse.Builder().code(401).build()
                    "/QuickConnect/Authorize" -> ok("true")
                    else -> MockResponse.Builder().code(404).build()
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() = server.close()

    private fun api(kind: String = "jellyfin", token: String? = null) = Api(Server("srv1", "NAS", server.url("/").toString().trimEnd('/'), kind), "tv", token, token?.let { "u1" })

    @Test
    fun signsInOnceApproved() = runBlocking {
        val codes = mutableListOf<String>()
        val r = api().quickConnect(everyMs = 1) { codes += it }
        assertEquals(listOf("000001", "000002"), codes)
        assertEquals("tok", r.accessToken)
        assertEquals("u1", r.user.id)
        // Anonymous, as this device: no token on any call.
        assertTrue(calls.all { it.headers["Authorization"]!!.contains("DeviceId=\"tv\"") && !it.headers["Authorization"]!!.contains("Token=") })
    }

    @Test
    fun offeredOnJellyfinWithItOn() = runBlocking {
        assertTrue(api().quickConnectEnabled())
        enabled = false
        assertFalse(api().quickConnectEnabled())
        enabled = true
        assertFalse(api("emby").quickConnectEnabled())
        // Emby is never asked.
        assertEquals(2, calls.count { it.url.encodedPath == "/QuickConnect/Enabled" })
    }

    @Test
    fun authorizesACode() = runBlocking {
        api(token = "user-token").authorizeQuickConnect(" 123456 ")
        val r = calls.single { it.url.encodedPath == "/QuickConnect/Authorize" }
        assertEquals("POST", r.method)
        assertEquals("123456", r.url.queryParameter("code"))
        assertTrue(r.headers["Authorization"]!!.contains("Token=\"user-token\""))
    }
}
