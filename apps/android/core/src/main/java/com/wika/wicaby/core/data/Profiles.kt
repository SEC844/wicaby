package com.wika.wicaby.core.data

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

// TP-10 "Who is watching?": the accounts saved on this device (Prefs, each token sealed by Vault) and their
// optional local PIN. The desktop picker (Login.svelte) lists the server's public users; a family TV also keeps
// everyone signed in, so picking a saved account needs no password, only its PIN when one was set here.
data class Profile(val session: Session, val hasPin: Boolean = false)

object Profiles {
    // One tile: a user of the server, and the account saved here for it (null: password sign-in).
    data class Entry(val user: User, val saved: Profile?)

    // [server]'s saved accounts. As for the session token (keepsSession), only for the very same server Id at the
    // same origin: a host claiming the Id elsewhere never gets them. The current session counts even when it was
    // signed in before profiles existed.
    fun saved(profiles: List<Profile>, current: Session?, server: Server): List<Profile> {
        val origin = server.origin ?: return emptyList()
        val here = { s: Session -> s.server.id == server.id && s.server.origin == origin }
        val mine = profiles.filter { here(it.session) }
        return if (current != null && here(current) && mine.none { it.session.userId == current.userId }) mine + Profile(current) else mine
    }

    // The public users in the server's order with their saved account, then the saved accounts the server does
    // not list (hidden users).
    fun entries(public: List<User>, saved: List<Profile>): List<Entry> {
        val byId = saved.associateBy { it.session.userId }
        val ids = public.mapTo(HashSet()) { it.id }
        return public.map { Entry(it, byId[it.id]) } + saved.filter { it.session.userId !in ids }.map { Entry(User(it.session.userId, it.session.userName), it) }
    }

    // Straight to the home screen at start: the setting is on and this device has one account, without a PIN.
    fun skipPicker(enabled: Boolean, saved: List<Profile>): Boolean = enabled && saved.size == 1 && !saved[0].hasPin

    fun skipPicker(snap: Snapshot): Boolean = snap.session?.let { skipPicker(snap.skipPicker, saved(snap.profiles, it, it.server)) } ?: false
}

// TP-10: the stored session is used only once "Who is watching?" opened it in this process (its PIN accepted), or
// when the picker is skipped. Until then the TV has no session: MainActivity leaves Core.api null (no socket, no remote
// control, no launcher link), and the screensaver stays black. Snapshot state: screens recompose when it changes.
object SessionGate {
    private var open by mutableStateOf<String?>(null)

    private fun key(s: Session) = "${s.server.id}|${s.server.origin}|${s.userId}"

    fun unlock(s: Session) {
        open = key(s)
    }

    fun lock() {
        open = null
    }

    // [s] once it was opened, else null.
    fun active(s: Session?): Session? = s?.takeIf { open == key(it) }
}

// One PIN try: ok, or wrong with how long the next try must wait (0: at once).
data class PinCheck(val ok: Boolean, val waitMs: Long = 0)

// A 4-digit PIN, stored as "salt:hash" (hex). PBKDF2-HMAC-SHA1: the only PBKDF2 below API 26 (TV minSdk 23).
// shortcut: 10^4 PINs stay brute-forceable from the app's private storage; it is a household lock, not a secret.
object Pin {
    const val LENGTH = 4
    private const val ROUNDS = 20_000

    // Wrong PINs in a row allowed at once; then each further try waits 30 s, doubling, at most 1 h (10^4 PINs: months).
    const val FREE_TRIES = 5

    fun waitMs(fails: Int): Long = if (fails < FREE_TRIES) 0 else minOf(30_000L shl minOf(fails - FREE_TRIES, 7), 3_600_000L)

    fun valid(pin: String): Boolean = pin.length == LENGTH && pin.all { it in '0'..'9' }

    fun hash(pin: String, salt: ByteArray = ByteArray(16).also(SecureRandom()::nextBytes)): String {
        require(valid(pin)) { "PIN must be $LENGTH digits" }
        return "${hex(salt)}:${hex(derive(pin, salt))}"
    }

    fun matches(pin: String, stored: String?): Boolean {
        val parts = stored?.split(':') ?: return false
        if (parts.size != 2 || !valid(pin)) return false
        val salt = unhex(parts[0]) ?: return false
        val want = unhex(parts[1]) ?: return false
        return MessageDigest.isEqual(derive(pin, salt), want)
    }

    private fun derive(pin: String, salt: ByteArray): ByteArray =
        SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1").generateSecret(PBEKeySpec(pin.toCharArray(), salt, ROUNDS, 256)).encoded

    private fun hex(b: ByteArray) = b.joinToString("") { Integer.toHexString((it.toInt() and 0xff) or 0x100).substring(1) }

    private fun unhex(s: String): ByteArray? =
        if (s.isEmpty() || s.length % 2 != 0) null else runCatching { ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() } }.getOrNull()
}
