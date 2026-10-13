package com.wika.wicaby.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// TP-10: the "Who is watching?" list, the skip-at-start rule and the local PIN hash.
class ProfilesTest {
    private val home = Server("abc123", "Home", "https://nas.lan:8920", "emby")
    private fun session(user: String, server: Server = home) = Session(server, user, user.uppercase(), "tok-$user")

    @Test
    fun savedKeepsThisServerAtThisOriginOnly() {
        val other = Profile(session("x", home.copy(id = "zzz")))
        val elsewhere = Profile(session("y", home.copy(address = "https://evil.example:8920")))
        val mine = Profile(session("a"), hasPin = true)
        assertEquals(listOf(mine), Profiles.saved(listOf(other, elsewhere, mine), null, home))
        // Unparsable address: nothing is handed out.
        assertTrue(Profiles.saved(listOf(mine), null, home.copy(address = "nas")).isEmpty())
    }

    @Test
    fun currentSessionCountsOnceEvenWhenNotSavedYet() {
        val cur = session("a")
        assertEquals(listOf(Profile(cur)), Profiles.saved(emptyList(), cur, home))
        val saved = Profile(cur, hasPin = true)
        assertEquals(listOf(saved), Profiles.saved(listOf(saved), cur, home))
        // A session on another server is not this picker's.
        assertTrue(Profiles.saved(emptyList(), session("b", home.copy(id = "zzz")), home).isEmpty())
    }

    @Test
    fun entriesFollowTheServerThenHiddenSavedUsers() {
        val public = listOf(User("a", "A", primaryImageTag = "t"), User("b", "B", hasPassword = false))
        val savedA = Profile(session("a"))
        val hidden = Profile(session("h"))
        val e = Profiles.entries(public, listOf(hidden, savedA))
        assertEquals(listOf("a", "b", "h"), e.map { it.user.id })
        assertEquals(savedA, e[0].saved)
        assertNull(e[1].saved)
        assertEquals("H", e[2].user.name)
        assertEquals(hidden, e[2].saved)
    }

    @Test
    fun skipOnlyWithOneAccountWithoutPin() {
        val a = Profile(session("a"))
        assertTrue(Profiles.skipPicker(true, listOf(a)))
        assertFalse(Profiles.skipPicker(false, listOf(a)))
        assertFalse(Profiles.skipPicker(true, listOf(a, Profile(session("b")))))
        assertFalse(Profiles.skipPicker(true, listOf(a.copy(hasPin = true))))
        assertFalse(Profiles.skipPicker(true, emptyList()))
    }

    // Prefs.setSession(remember = true): switching user never drops the account it replaces.
    @Test
    fun switchingUserKeepsTheOutgoingSession() {
        fun stored(user: String, pin: String? = null) = StoredProfile(home, user, user.uppercase(), "sealed-$user", pin = pin)
        // Signed in before profiles existed: no entry yet, the switch saves it beside the new one.
        assertEquals(listOf(stored("a"), stored("b")), signedInProfiles(emptyList(), stored("a"), stored("b")))
        // Already a profile: kept as it is (its PIN too), not added twice.
        val a = stored("a", pin = "s:h")
        assertEquals(listOf(a, stored("b")), signedInProfiles(listOf(a), stored("a"), stored("b")))
        // Signing in again as the same user replaces the entry and keeps its PIN.
        assertEquals(listOf(stored("b"), stored("a").copy(token = "new", pin = "s:h")), signedInProfiles(listOf(a, stored("b")), stored("a"), stored("a").copy(token = "new")))
        // No session before (first sign-in, or setServer dropped it for another server).
        assertEquals(listOf(stored("b")), signedInProfiles(emptyList(), null, stored("b")))
    }

    @Test
    fun pinIsSaltedAndChecked() {
        val h1 = Pin.hash("1234")
        val h2 = Pin.hash("1234")
        assertNotEquals("a new salt each time", h1, h2)
        assertFalse("never the PIN itself", h1.contains("1234"))
        assertTrue(Pin.matches("1234", h1))
        assertTrue(Pin.matches("1234", h2))
        assertFalse(Pin.matches("1235", h1))
        assertFalse(Pin.matches("1234", null))
        assertFalse(Pin.matches("1234", "garbage"))
        assertFalse(Pin.matches("1234", "zz:zz"))
        // Same salt, same hash: deterministic.
        val salt = ByteArray(16) { it.toByte() }
        assertEquals(Pin.hash("0000", salt), Pin.hash("0000", salt))
    }

    @Test
    fun pinIsFourDigits() {
        assertTrue(Pin.valid("0000"))
        assertFalse(Pin.valid("123"))
        assertFalse(Pin.valid("12345"))
        assertFalse(Pin.valid("12a4"))
        assertFalse(Pin.matches("12a4", Pin.hash("1234")))
    }

    // TP-10: no session is usable until "Who is watching?" opens it.
    @Test
    fun gateOpensOnlyTheSessionThePickerOpened() {
        val a = session("a")
        SessionGate.lock()
        assertNull(SessionGate.active(a))
        SessionGate.unlock(a)
        assertEquals(a, SessionGate.active(a))
        assertNull("another account stays locked", SessionGate.active(session("b")))
        assertNull("the same id elsewhere stays locked", SessionGate.active(session("a", home.copy(address = "https://evil.example:8920"))))
        SessionGate.lock()
        assertNull(SessionGate.active(a))
        assertNull(SessionGate.active(null))
    }

    @Test
    fun skipPickerFromASnapshot() {
        val a = session("a")
        fun snap(profiles: List<Profile>, skip: Boolean = true) = Snapshot("dev", home, a, 0, 0, 0, profiles = profiles, skipPicker = skip)
        assertTrue(Profiles.skipPicker(snap(emptyList())))
        assertFalse(Profiles.skipPicker(snap(listOf(Profile(a, hasPin = true)))))
        assertFalse(Profiles.skipPicker(snap(listOf(Profile(session("b"))))))
        assertFalse(Profiles.skipPicker(snap(emptyList(), skip = false)))
        assertFalse(Profiles.skipPicker(Snapshot("dev", home, null, 0, 0, 0)))
    }

    @Test
    fun pinTriesAreRateLimited() {
        var p = StoredProfile(home, "a", "A", "sealed", pin = Pin.hash("1234"))
        val now = 1_000_000L
        // The first misses answer at once, then a wait that doubles.
        repeat(Pin.FREE_TRIES - 1) {
            val (r, next) = pinAttempt(p, "0000", now)
            assertEquals(PinCheck(false, 0), r)
            p = next
        }
        val (fifth, locked) = pinAttempt(p, "0000", now)
        assertEquals(PinCheck(false, 30_000), fifth)
        // While it waits, even the right PIN is not checked.
        val (early, same) = pinAttempt(locked, "1234", now + 29_000)
        assertEquals(PinCheck(false, 1_000), early)
        assertEquals(locked, same)
        val (sixth, longer) = pinAttempt(locked, "9999", now + 30_000)
        assertEquals(PinCheck(false, 60_000), sixth)
        val (ok, reset) = pinAttempt(longer, "1234", now + 90_000)
        assertTrue(ok.ok)
        assertEquals(0, reset.fails)
        assertEquals(0L, reset.retryAt)
        assertEquals(3_600_000L, Pin.waitMs(40))
        assertEquals(0L, Pin.waitMs(0))
    }
}
