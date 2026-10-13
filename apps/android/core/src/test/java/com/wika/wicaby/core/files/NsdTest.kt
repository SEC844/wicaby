package com.wika.wicaby.core.files

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// §6.2: an NsdManager reply as an Add-form entry. Documentation addresses only.
class NsdTest {
    @Test
    fun webdavRepliesGiveTheirBasePathAndUser() {
        assertEquals(
            FoundShare("NAS", FileSource.WEBDAV, "https://192.0.2.4/media", "demo"),
            Nsd.entry("_webdavs._tcp", "NAS", "192.0.2.4", 443, mapOf("path" to "media/", "u" to "demo")),
        )
        assertEquals(FoundShare("NAS", FileSource.WEBDAV, "http://192.0.2.4:5005"), Nsd.entry("_webdav._tcp.", "NAS", "192.0.2.4", 5005, emptyMap()))
        assertEquals("http://[2001:db8::4]/dav", Nsd.entry("_webdav._tcp", "", "2001:db8::4%wlan0", 80, mapOf("path" to "/dav"))?.url)
    }

    @Test
    fun smbRepliesLeaveTheShareToType() {
        assertEquals(FoundShare("STORAGE", FileSource.SMB, "\\\\192.0.2.5\\"), Nsd.entry("_smb._tcp", "STORAGE", "192.0.2.5", 445, emptyMap()))
    }

    @Test
    fun otherTypesAndBadPortsAreDropped() {
        assertNull(Nsd.entry("_http._tcp", "x", "192.0.2.4", 80, emptyMap()))
        assertNull(Nsd.entry("_webdav._tcp", "x", "192.0.2.4", 0, emptyMap()))
        assertNull(Nsd.entry("_webdav._tcp", "x", "", 80, emptyMap()))
    }
}
