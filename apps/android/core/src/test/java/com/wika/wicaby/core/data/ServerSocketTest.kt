package com.wika.wicaby.core.data

import com.wika.wicaby.core.Core
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

// ServerSocket against mockwebserver3: capabilities before every connect, keep-alive at half the
// server's timeout, reconnect after a drop (server restart), and nothing delivered after close().
class ServerSocketTest {
    private lateinit var server: MockWebServer
    private val events = CopyOnWriteArrayList<String>() // "caps", "ws", "keepalive"
    private val capsBodies = CopyOnWriteArrayList<String>()
    private val serverSockets = CopyOnWriteArrayList<WebSocket>()

    @Volatile private var keepAliveSeconds = 60

    private val serverListener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            serverSockets += webSocket
            webSocket.send("""{"MessageType":"ForceKeepAlive","Data":$keepAliveSeconds}""")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (text.contains("\"KeepAlive\"")) events += "keepalive"
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }
    }

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                "/Sessions/Capabilities/Full" -> {
                    events += "caps"
                    capsBodies += request.body?.utf8().orEmpty()
                    MockResponse.Builder().code(204).build()
                }
                "/socket" -> {
                    events += "ws:" + request.url.queryParameter("ApiKey") + ":" + request.url.queryParameter("deviceId")
                    MockResponse.Builder().webSocketUpgrade(serverListener).build()
                }
                else -> MockResponse.Builder().code(404).build()
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        server.close()
    }

    private val api get() = Api(Server("srv", "Mock", server.url("/").toString().trimEnd('/'), "jellyfin"), "dev-1", "tok", "u1")

    private fun socket(mediaControl: Boolean, got: MutableList<SocketMessage>, backoff: List<Long> = listOf(50)): ServerSocket {
        val a = api
        return ServerSocket(Core.http, a.socketUrl(), { a.capabilities(mediaControl) }, { got += it }, backoff)
    }

    private fun waitFor(ms: Long = 5_000, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + ms
        while (!cond() && System.currentTimeMillis() < end) Thread.sleep(20)
        assertTrue("timed out; events=$events", cond())
    }

    @Test
    fun capabilitiesBeforeConnectThenKeepAlive() {
        keepAliveSeconds = 2 // KeepAlive every second
        val got = CopyOnWriteArrayList<SocketMessage>()
        val s = socket(mediaControl = true, got)
        s.open()
        waitFor { events.count { it == "keepalive" } >= 2 }
        assertEquals("caps", events[0])
        assertEquals("ws:tok:dev-1", events[1])
        val caps = Json.parseToJsonElement(capsBodies[0]).jsonObject
        assertEquals(JsonPrimitive(true), caps["SupportsMediaControl"])
        assertTrue((caps["SupportedCommands"] as JsonArray).contains(JsonPrimitive("Playstate")))
        // ForceKeepAlive and KeepAlive stay inside the socket; the rest is delivered.
        serverSockets.last().send("""{"MessageType":"LibraryChanged","Data":{"ItemsAdded":["a"]}}""")
        waitFor { got.isNotEmpty() }
        assertEquals(listOf("LibraryChanged"), got.map { it.type })
        s.close()
    }

    @Test
    fun reconnectsAndPostsCapabilitiesAgain() {
        val got = CopyOnWriteArrayList<SocketMessage>()
        val s = socket(mediaControl = true, got)
        s.open()
        waitFor { serverSockets.size == 1 }
        // The server goes away (restart): the socket drops.
        serverSockets[0].close(1001, "restart")
        waitFor { serverSockets.size == 2 }
        assertEquals(listOf("caps", "ws", "caps", "ws"), events.filter { it != "keepalive" }.map { it.substringBefore(':') })
        s.close()
    }

    @Test
    fun remoteControlOffPostsNoMediaControl() {
        val s = socket(mediaControl = false, CopyOnWriteArrayList())
        s.open()
        waitFor { serverSockets.size == 1 }
        val caps = Json.parseToJsonElement(capsBodies[0]).jsonObject
        assertEquals(JsonPrimitive(false), caps["SupportsMediaControl"])
        // Messages still reach the device: they are a notification, not control.
        assertEquals(JsonArray(listOf(JsonPrimitive("DisplayMessage"))), caps["SupportedCommands"])
        s.close()
    }

    @Test
    fun closedSocketDeliversNothingAndStaysClosed() {
        val old = CopyOnWriteArrayList<SocketMessage>()
        val s = socket(mediaControl = true, old)
        s.open()
        waitFor { serverSockets.size == 1 }
        // A user switch: the old socket is closed before the new one opens.
        s.close()
        serverSockets[0].send("""{"MessageType":"Play","Data":{"ItemIds":["x"]}}""")
        val fresh = CopyOnWriteArrayList<SocketMessage>()
        val next = socket(mediaControl = true, fresh)
        next.open()
        waitFor { serverSockets.size == 2 }
        serverSockets[1].send("""{"MessageType":"Play","Data":{"ItemIds":["y"]}}""")
        waitFor { fresh.isNotEmpty() }
        Thread.sleep(200)
        assertTrue("old socket delivered $old", old.isEmpty())
        assertEquals(2, events.count { it.startsWith("ws") }) // no reconnect of the closed one
        next.close()
    }
}
