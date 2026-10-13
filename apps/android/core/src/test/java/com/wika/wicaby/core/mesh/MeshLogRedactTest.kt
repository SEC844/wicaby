package com.wika.wicaby.core.mesh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class MeshLogRedactTest {
    @Test
    fun urlsAndKeysAreRedacted() {
        val line = "To authenticate, visit: https://login.tailscale.com/a/1b2c3d4e5f6a7b"
        assertEquals("To authenticate, visit: <url>", redactMeshLog(line))
        assertEquals("proxy <url> up", redactMeshLog("proxy http://127.0.0.1:41234/AbCdEf0123456789 up"))
        val keyed = redactMeshLog("using key tskey-auth-kAbCdEf1CNTRL-0123456789abcdef")
        assertFalse(keyed.contains("0123456789abcdef"))
        assertFalse(redactMeshLog("setup key 1B2C3D4E-5F6A-7B8C-9D0E-1F2A3B4C5D6E").contains("5F6A"))
        // Scheme-less login links and short device-flow user codes.
        assertEquals("visit <url> now", redactMeshLog("visit login.tailscale.com/a/ab12 now"))
        assertEquals("enter code <redacted>", redactMeshLog("enter code ABCD-EFGH"))
        // Ordinary words stay readable.
        assertEquals("peer-down, wireguard-go v1.2.3", redactMeshLog("peer-down, wireguard-go v1.2.3"))
        assertEquals("state Running, 3 peers", redactMeshLog("state Running, 3 peers"))
    }
}
