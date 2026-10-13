package com.wika.wicaby.core.mesh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MeshStatusTest {
    @Test
    fun parsesHelperStatus() {
        val s = parseStatus(
            """{"type":"status","state":"needs-login","authUrl":"https://login.tailscale.com/a/abc","ips":[],"peers":[],"future":1}""",
            MeshProvider.Tailscale,
        )
        assertEquals(MeshState.NeedsLogin, s.state)
        assertEquals("https://login.tailscale.com/a/abc", s.authUrl)
        assertEquals(MeshProvider.Tailscale, s.provider)
    }

    @Test
    fun shortNamesBecomePeerFqdns() {
        val peers = listOf(
            MeshPeer(name = "nas", dnsName = "nas.tail1.ts.net.", ips = listOf("100.64.0.2")),
            MeshPeer(name = "pc", dnsName = "pc.netbird.cloud", ips = listOf("100.90.0.3")),
        )
        assertEquals("http://nas.tail1.ts.net:8096", meshOrigin("http://nas:8096", peers))
        assertEquals("https://pc.netbird.cloud:8920", meshOrigin("https://PC:8920", peers))
        // IPs, full names, unknown names and IPv6 literals are passed on as they are.
        for (o in listOf("http://100.64.0.2:8096", "http://nas.tail1.ts.net:8096", "http://tv:8096", "http://fd7a::2:8096")) assertEquals(o, meshOrigin(o, peers))
        // Two peers with the same first label: ambiguous, left to the forwarder (which refuses it).
        val twins = peers + MeshPeer(name = "nas", dnsName = "nas.other.ts.net")
        assertEquals("http://nas:8096", meshOrigin("http://nas:8096", twins))
    }

    @Test
    fun parsesPeers() {
        val s = parseStatus(
            """{"state":"connected","selfName":"wicaby-tv","ips":["100.64.0.9"],
               "peers":[{"name":"nas","dnsName":"nas.tail1.ts.net","ips":["100.64.0.2","fd7a:115c:a1e0::2"],"online":true}]}""",
            MeshProvider.Tailscale,
        )
        assertEquals(MeshState.Connected, s.state)
        assertEquals("nas", s.peers.single().name)
        assertEquals(listOf("100.64.0.2", "fd7a:115c:a1e0::2"), s.peers.single().ips)
        assertNull(s.authUrl)
    }

    @Test
    fun parsesRoutes() {
        val s = parseStatus("""{"state":"connected","ips":["100.92.0.9"],"peers":[],"routes":["192.0.2.0/24","fd00:1::/64"]}""", MeshProvider.NetBird)
        assertEquals(listOf("192.0.2.0/24", "fd00:1::/64"), s.routes)
        // Tailscale (and older helpers) send none.
        assertEquals(emptyList<String>(), parseStatus("""{"state":"connected","ips":[],"peers":[]}""", MeshProvider.Tailscale).routes)
    }

    @Test
    fun blankFieldsAreNull() {
        val s = parseStatus("""{"state":"error","error":"","userCode":""}""", MeshProvider.NetBird)
        assertEquals(MeshState.Error, s.state)
        assertNull(s.error)
        assertNull(s.userCode)
    }

    @Test
    fun garbageIsAnError() {
        assertEquals(MeshState.Error, parseStatus("not json", null).state)
    }

    @Test
    fun hostnameIsADnsLabel() {
        assertEquals("wicaby-nvidia-shield-android-tv", meshHostname("NVIDIA SHIELD Android TV"))
        assertEquals("wicaby-android", meshHostname("  ***  "))
        assertEquals(63, meshHostname("x".repeat(100)).length)
    }
}
