package com.wika.wicaby.core.mesh

import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ServerSocket

class MeshServersTest {
    @Test
    fun onlyThePeerThatAnswersIsAServer() = runBlocking {
        val emby = MockWebServer()
        emby.enqueue(MockResponse.Builder().body("""{"Id":"srv1","ServerName":"Media","ProductName":"Emby Server","Version":"4.9"}""").build())
        emby.start()
        // Accepts the connection and never answers: the probe times out.
        val silent = ServerSocket(0)
        try {
            val media = MeshPeer(name = "media", ips = listOf("100.64.0.2"), online = true)
            val stuck = MeshPeer(name = "stuck", ips = listOf("100.64.0.3"), online = true)
            val offline = MeshPeer(name = "phone", ips = listOf("100.64.0.4"), online = false)
            val urls = mapOf("media" to emby.url("/").toString().trimEnd('/'), "stuck" to "http://127.0.0.1:${silent.localPort}", "phone" to emby.url("/").toString().trimEnd('/'))
            val t0 = System.nanoTime()
            val found = MeshServers.find(listOf(media, stuck, offline), addresses = { listOf(urls.getValue(it.name)) }, timeoutMs = 500)
            assertEquals(listOf("media"), found.map { it.peer.name })
            assertEquals("srv1", found.single().server.id)
            assertEquals("emby", found.single().server.kind)
            assertTrue("bounded by the timeout", (System.nanoTime() - t0) / 1_000_000 < 5_000)
        } finally {
            silent.close()
            emby.close()
        }
    }

    @Test
    fun defaultAddressesPreferHttpsAndIpv4() {
        assertEquals(listOf("https://100.64.0.2:8920", "http://100.64.0.2:8096"), MeshServers.addresses(MeshPeer(ips = listOf("fd7a:115c:a1e0::2", "100.64.0.2"))))
        assertEquals(listOf("https://[fd7a::2]:8920", "http://[fd7a::2]:8096"), MeshServers.addresses(MeshPeer(ips = listOf("fd7a::2"))))
        assertEquals(emptyList<String>(), MeshServers.addresses(MeshPeer()))
    }
}
