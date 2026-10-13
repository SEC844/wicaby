package com.wika.wicaby.core.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Prefs.setServer keeps the stored token only for the same server Id at the same origin.
class PrefsSessionTest {
    private fun stored(s: Server) = json.encodeToString(Server.serializer(), s)

    private val home = Server("abc123", "Home", "https://nas.lan:8920", "emby")

    @Test
    fun sameIdAndOriginKeepsTheToken() {
        assertTrue(keepsSession(stored(home), home))
        // A path or a trailing slash is not part of the origin; the default port is explicit.
        assertTrue(keepsSession(stored(home), home.copy(address = "https://nas.lan:8920/", name = "Renamed")))
        assertTrue(keepsSession(stored(home.copy(address = "https://nas.lan")), home.copy(address = "https://nas.lan:443")))
    }

    @Test
    fun sameIdElsewhereDropsTheToken() {
        // Any host can claim the Id in /System/Info/Public.
        assertFalse(keepsSession(stored(home), home.copy(address = "https://evil.example:8920")))
        assertFalse(keepsSession(stored(home), home.copy(address = "http://nas.lan:8920")))
        assertFalse(keepsSession(stored(home), home.copy(address = "https://nas.lan:8921")))
    }

    @Test
    fun otherIdDropsTheToken() {
        assertFalse(keepsSession(stored(home), home.copy(id = "other")))
        // The old substring check matched "\"abc123\"" anywhere in the JSON, the name included.
        assertFalse(keepsSession(stored(home.copy(id = "zzz", name = "\"abc123\"")), home))
    }

    @Test
    fun nothingOrGarbageStoredDropsTheToken() {
        assertFalse(keepsSession(null, home))
        assertFalse(keepsSession("not json", home))
        assertFalse(keepsSession(stored(home.copy(address = "nas.lan")), home.copy(address = "nas.lan")))
    }
}
