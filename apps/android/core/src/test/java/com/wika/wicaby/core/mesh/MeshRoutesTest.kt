package com.wika.wicaby.core.mesh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ServerSocket

class MeshRoutesTest {
    private val routes = listOf("192.0.2.0/24", "fd00:1::/64", "0.0.0.0/0", "::/0", "not-a-cidr", "198.51.100.7/32")

    @Test
    fun routeMatching() {
        assertTrue(inRoutedNet("192.0.2.15", routes))
        assertTrue(inRoutedNet("198.51.100.7", routes))
        assertTrue(inRoutedNet("fd00:1::26", routes))
        assertTrue(inRoutedNet("[fd00:1::26]", routes))
        assertFalse(inRoutedNet("198.51.100.8", routes))
        assertFalse("default routes route nothing", inRoutedNet("8.8.8.8", routes))
        assertFalse(inRoutedNet("fd00:2::1", routes))
        assertFalse("names are never matched (no DNS)", inRoutedNet("nas.local", routes))
        assertFalse(inRoutedNet("192.0.2", routes))
        assertFalse(inRoutedNet("192.0.2.256", routes))
        assertFalse(inRoutedNet("192.0.2.15", emptyList()))
    }

    @Test
    fun directFirstThenMeshAndBackToDirectAfterAFailure() {
        var answers = true
        val probes = mutableListOf<String>()
        var clock = 0L
        val d = DirectFirst(reachable = { h, p -> probes += "$h:$p"; answers }, now = { clock })
        val o = "http://192.0.2.15:8080"

        // At home: direct, and the verdict is cached.
        assertTrue(d.goDirect(o, routes, emptyList()))
        assertTrue(d.goDirect(o, routes, emptyList()))
        assertEquals(listOf("192.0.2.15:8080"), probes)

        // Away: a failed call drops the verdict, the next probe fails, the mesh takes over.
        answers = false
        d.failed(o)
        assertFalse(d.goDirect(o, routes, emptyList()))
        assertEquals(2, probes.size)

        // The verdict also expires after a minute.
        answers = true
        assertTrue(d.goDirect(o, routes, emptyList()))
        clock += 61_000
        assertTrue(d.goDirect(o, routes, emptyList()))
        assertEquals(4, probes.size)
    }

    @Test
    fun peersAndOutsideHostsAreNotProbed() {
        val probes = mutableListOf<String>()
        val d = DirectFirst(reachable = { h, _ -> probes += h; true })
        val peer = MeshPeer(name = "nas", ips = listOf("192.0.2.7"))
        assertFalse("a peer goes through the mesh", d.goDirect("http://192.0.2.7:8096", routes, listOf(peer)))
        assertFalse("outside every route: the forwarder decides", d.goDirect("http://203.0.113.5:8080", routes, emptyList()))
        assertFalse(d.goDirect("http://nas.local:8080", routes, emptyList()))
        assertTrue(probes.isEmpty())
    }

    @Test
    fun tcpProbeOnLoopback() {
        ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1")).use { s ->
            assertTrue(tcpReachable("127.0.0.1", s.localPort))
        }
        val closed = ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1")).use { it.localPort }
        assertFalse(tcpReachable("127.0.0.1", closed))
    }
}
