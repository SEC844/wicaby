package com.wika.wicaby.core.pair

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeNotNull
import org.junit.Test
import java.io.IOException
import java.io.InputStream
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.Socket

class PairingTest {
    private var clock = 1_000_000L
    private fun token() = PairToken(now = { clock })

    @Test
    fun tokenIs128RandomBits() {
        val a = token()
        assertTrue(Regex("[0-9a-f]{32}").matches(a.value))
        assertNotEquals(a.value, token().value)
    }

    @Test
    fun tokenIsSingleUse() {
        val t = token()
        assertTrue(t.consume(t.value))
        assertFalse(t.consume(t.value))
    }

    @Test
    fun wrongTokenIsRefusedAndDoesNotSpendIt() {
        val t = token()
        assertFalse(t.consume(""))
        assertFalse(t.consume(t.value.dropLast(1)))
        assertFalse(t.consume(t.value.uppercase()))
        assertFalse(t.consume(t.value.replaceRange(0, 1, if (t.value[0] == 'a') "b" else "a")))
        assertTrue(t.consume(t.value))
    }

    @Test
    fun tokenExpiresAfterFiveMinutes() {
        val t = token()
        clock += PAIR_TTL_MS - 1
        assertFalse(t.expired)
        clock += 1
        assertTrue(t.expired)
        assertFalse(t.consume(t.value))
    }

    @Test
    fun lanAddressesOnly() {
        for (a in listOf("192.168.1.20", "10.0.0.5", "172.16.3.4", "169.254.1.1", "fd12::1", "fe80::1")) {
            assertTrue(a, isLanAddress(InetAddress.getByName(a)))
        }
        for (a in listOf("8.8.8.8", "127.0.0.1", "172.32.0.1", "100.64.1.1", "2001:db8::1", "0.0.0.0")) {
            assertFalse(a, isLanAddress(InetAddress.getByName(a)))
        }
    }

    @Test
    fun navidromePasswordNeverGoesOverThePairChannel() {
        assertTrue(pairable("emby"))
        assertTrue(pairable("jellyfin"))
        assertFalse(pairable("navidrome"))
        assertFalse(pairable("plex"))
    }

    @Test
    fun parsesOnlyLanPairingUrls() {
        val tok = "0123456789abcdef0123456789abcdef"
        val ok = parsePairUrl(" http://192.168.1.20:41234/wicaby/pair?t=$tok ")
        assertNotNull(ok)
        assertEquals("http://192.168.1.20:41234/wicaby/pair", ok!!.url)
        assertEquals("192.168.1.20", ok.host)
        assertEquals(tok, ok.token)
        // Not LAN, not http, a host name, another path, a bad token, not a URL.
        assertNull(parsePairUrl("http://8.8.8.8:41234/wicaby/pair?t=$tok"))
        assertNull(parsePairUrl("https://192.168.1.20:41234/wicaby/pair?t=$tok"))
        assertNull(parsePairUrl("http://tv.lan:41234/wicaby/pair?t=$tok"))
        assertNull(parsePairUrl("http://192.168.1.20:41234/other?t=$tok"))
        assertNull(parsePairUrl("http://192.168.1.20:41234/wicaby/pair?t=${tok.drop(2)}"))
        assertNull(parsePairUrl("http://192.168.1.20:41234/wicaby/pair"))
        assertNull(parsePairUrl("WIFI:S:home;T:WPA;P:secret;;"))
    }

    private fun req(raw: String) = readRequest(raw.byteInputStream())

    @Test
    fun readsOneSmallPost() {
        val body = """{"Token":"x"}"""
        val r = req("POST /wicaby/pair?x=1 HTTP/1.1\r\nHost: tv\r\ncontent-length: ${body.length}\r\n\r\n$body")
        assertNotNull(r)
        assertEquals("POST", r!!.method)
        assertEquals("/wicaby/pair", r.path)
        assertEquals(body, r.body)
    }

    @Test
    fun refusesMalformedOrOversizedRequests() {
        assertNull(req("POST /wicaby/pair HTTP/1.1\r\nContent-Length: 10\r\n\r\nshort"))
        assertNull(req("POST /wicaby/pair HTTP/1.1\r\nContent-Length: 99999\r\n\r\n"))
        assertNull(req("POST /wicaby/pair HTTP/1.1\r\nContent-Length: -1\r\n\r\n"))
        assertNull(req("GARBAGE\r\n\r\n"))
        assertNull(req("POST /wicaby/pair HTTP/1.1\r\nX: " + "a".repeat(9000) + "\r\n\r\n"))
        assertNull(req("POST /wicaby/pair HTTP/1.1\r\n"))
    }

    @Test
    fun aTricklingPeerIsCutAtTheDeadline() {
        val trickle = object : InputStream() {
            override fun read(): Int = 'a'.code.also { Thread.sleep(20) }
        }
        val start = System.currentTimeMillis()
        assertNull(readRequest(trickle, deadline = start + 200))
        assertTrue(System.currentTimeMillis() - start < 2000) // not 8192 bytes x 20 ms
    }

    // The sheet closing (cancellation) must end run() and close the port even while a LAN peer
    // holds the connection open without sending its request. Needs a LAN IPv4 on this machine.
    @Test
    fun cancellingRunClosesTheEndpointDespiteAStalledPeer() = runBlocking {
        val ip = NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp }
            .flatMap { it.inetAddresses.toList() }.filterIsInstance<Inet4Address>().firstOrNull(::isLanAddress)
        assumeNotNull(ip)
        val server = PairServer(ip!!) { true }
        val port = server.url.substringAfterLast(':').substringBefore('/').toInt()
        val run = async(Dispatchers.Default) { server.run() }
        Socket(ip, port).use { stalled ->
            stalled.getOutputStream().write("POST ".toByteArray())
            delay(200) // the server is now blocked reading this peer (2 s read timeout)
            run.cancel()
            withTimeout(1000) { run.join() }
        }
        assertTrue(runCatching { Socket(ip, port).close() }.exceptionOrNull() is IOException)
    }
}
