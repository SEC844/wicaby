package com.wika.wicaby.core.net

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalNetworkTest {
    @Test
    fun lanAddresses() {
        listOf("10.0.2.2", "172.16.0.1", "172.31.255.254", "192.168.1.20", "169.254.3.4", "fd7a:115c::1", "[fe80::1%wlan0]", "::ffff:192.168.50.9")
            .forEach { assertTrue(it, LocalNetwork.isLanAddress(it)) }
    }

    @Test
    fun notLanAddresses() {
        // Mesh (100.64/10), loopback forwarders, public addresses and names.
        listOf("100.100.1.1", "127.0.0.1", "::1", "8.8.8.8", "172.32.0.1", "192.169.0.1", "2001:db8::1", "nas.local", "", "999.1.1.1")
            .forEach { assertFalse(it, LocalNetwork.isLanAddress(it)) }
    }

    @Test
    fun hostsByNameAndLookup() {
        val none: (String) -> List<String> = { error("no lookup expected for $it") }
        assertTrue(LocalNetwork.isLanHost("192.168.1.5", none))
        assertTrue(LocalNetwork.isLanHost("nas", none))
        assertTrue(LocalNetwork.isLanHost("Media.local", none))
        assertFalse(LocalNetwork.isLanHost("8.8.8.8", none))
        assertFalse(LocalNetwork.isLanHost("2001:db8::1", none))
        assertTrue(LocalNetwork.isLanHost("nas.home.arpa") { listOf("192.168.1.5") })
        assertFalse(LocalNetwork.isLanHost("media.example.org") { listOf("203.0.113.7") })
        // An unresolvable name is left to the connection (it fails the usual way).
        assertFalse(LocalNetwork.isLanHost("gone.example.org") { throw java.net.UnknownHostException(it) })
    }

    @Test
    fun managementUrls() {
        val none: (String) -> List<String> = { error("no lookup expected for $it") }
        assertTrue(LocalNetwork.isLanUrl("https://192.168.0.10:33073", none))
        assertTrue(LocalNetwork.isLanUrl("http://netbird.local", none))
        assertTrue(LocalNetwork.isLanUrl("https://netbird.example.org") { listOf("192.168.0.10") })
        assertFalse(LocalNetwork.isLanUrl("https://netbird.example.org") { listOf("203.0.113.7") })
        assertTrue(LocalNetwork.isLanUrl("10.0.0.5:443", none))
        assertFalse(LocalNetwork.isLanUrl("https://", none))
    }
}
