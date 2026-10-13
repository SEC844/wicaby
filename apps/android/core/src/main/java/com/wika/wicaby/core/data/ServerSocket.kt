package com.wika.wicaby.core.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

// One frame from the server: {"MessageType": "...", "Data": ...}.
class SocketMessage(val type: String, val data: JsonElement?) {
    companion object {
        fun parse(text: String): SocketMessage? {
            val o = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return null
            val type = (o["MessageType"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
            return SocketMessage(type, o["Data"])
        }
    }
}

// The server's realtime channel (remote control, library, user data and timer events), one per
// Api session. Capabilities are posted before every connect (5 s at most), keep-alives follow the
// server's ForceKeepAlive, and a dropped socket reconnects after 1, 2, 5, 10, then every 30 s.
// [client] is Core.http's, so ServerTransport (mesh) and the auth interceptor apply; the URL
// carries the token and is never logged. close() is final: no message is delivered after it.
class ServerSocket(
    private val client: OkHttpClient,
    private val url: String,
    private val capabilities: suspend () -> Unit,
    private val deliver: (SocketMessage) -> Unit,
    private val backoffMs: List<Long> = listOf(1_000, 2_000, 5_000, 10_000, 30_000),
    private val capabilitiesTimeoutMs: Long = 5_000,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var closed = false
    @Volatile private var ws: WebSocket? = null
    @Volatile private var attempts = 0
    private var keepAlive: Job? = null

    fun open() {
        scope.launch { connect() }
    }

    // A frame to the server (cast mirror: SessionsStart / SessionsStop). false while no socket is open.
    fun send(type: String, data: JsonElement? = null): Boolean = ws?.send(
        buildJsonObject {
            put("MessageType", type)
            data?.let { put("Data", it) }
        }.toString(),
    ) ?: false

    fun close() {
        closed = true
        scope.cancel()
        ws?.close(1000, null)
        ws = null
    }

    private suspend fun connect() {
        if (closed) return
        withTimeoutOrNull(capabilitiesTimeoutMs) { runCatching { capabilities() } }
        if (closed) return
        val s = client.newWebSocket(Request.Builder().url(url).build(), Listener())
        ws = s
        // close() may have run since the check above: it saw no socket, so this one goes now.
        if (closed) { s.cancel(); ws = null }
    }

    private fun reconnect(from: WebSocket) {
        if (closed || ws !== from) return
        ws = null
        keepAlive?.cancel()
        val wait = backoffMs[attempts.coerceAtMost(backoffMs.lastIndex)]
        attempts++
        scope.launch {
            delay(wait)
            connect()
        }
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (ws === webSocket) attempts = 0
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (closed || ws !== webSocket) return
            val m = SocketMessage.parse(text) ?: return
            when (m.type) {
                "ForceKeepAlive" -> {
                    // Data: the server's idle timeout in seconds; answer at half of it.
                    val every = (((m.data as? JsonPrimitive)?.doubleOrNull ?: 60.0) * 500).toLong().coerceAtLeast(1_000)
                    keepAlive?.cancel()
                    keepAlive = scope.launch {
                        while (isActive && ws === webSocket) {
                            webSocket.send("""{"MessageType":"KeepAlive"}""")
                            delay(every)
                        }
                    }
                }
                "KeepAlive" -> Unit
                else -> deliver(m)
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            reconnect(webSocket)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = reconnect(webSocket)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = reconnect(webSocket)
    }
}
