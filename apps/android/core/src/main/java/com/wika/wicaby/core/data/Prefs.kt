package com.wika.wicaby.core.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private val Context.store by preferencesDataStore("wicaby")

// Onboarding (OB-C1). No device id = a fresh install: the wizard runs. An id without the flag = an install
// from before onboarding existed, which never sees it. current() applies this in one edit; the snapshot reads
// the same rule until then.
private val firstRunDeviceKey = stringPreferencesKey("device_id")
internal val onboardedKey = booleanPreferencesKey("onboarded")

internal fun firstRun(p: MutablePreferences) {
    if (p[onboardedKey] == null) p[onboardedKey] = p[firstRunDeviceKey] != null
    if (p[firstRunDeviceKey] == null) p[firstRunDeviceKey] = UUID.randomUUID().toString().replace("-", "")
}

internal fun onboarded(p: Preferences): Boolean = p[onboardedKey] ?: (p[firstRunDeviceKey] != null)

// shared: the token was handed over by the phone (TV pairing) and is still the phone's own, so
// signing out here must not revoke it on the server.
data class Session(val server: Server, val userId: String, val userName: String, val token: String, val shared: Boolean = false) {
    // Logs and crash reports never see the token.
    override fun toString() = "Session(server=$server, userId=$userId, userName=$userName, token=<redacted>)"
}

// A stored token is only reused for the very same server: the decoded server Id AND the
// address origin (scheme://host:port) must match. A substring match on the JSON, or the Id
// alone (which any host can claim in /System/Info/Public), would hand the token to an impostor.
internal fun keepsSession(storedJson: String?, next: Server): Boolean {
    val prev = storedJson?.let { runCatching { json.decodeFromString(Server.serializer(), it) }.getOrNull() } ?: return false
    val origin = next.origin ?: return false
    return prev.id == next.id && prev.origin == origin
}

data class Snapshot(
    val deviceId: String,
    val server: Server?,
    val session: Session?,
    val accent: Int,
    val maxMbps: Int, // 0 = auto
    val displayMode: Int, // 0 = off, 1 = refresh rate, 2 = refresh rate + resolution
    val wifiOnlyDownloads: Boolean = true,
    // Sideloaded APK updates: the manifest URL typed in Réglages ("" = UpdateLogic.DEFAULT_URL).
    val updateUrl: String = "",
    // Mobile Réglages > "Autoriser le contrôle à distance" (CA-05; the TV keeps its own in TvSettings).
    val remoteControl: Boolean = true,
    // TP-06: the other signed-in servers (Réglages > Comptes), beside [session].
    val extras: List<Session> = emptyList(),
    // TP-10: the accounts saved on this device ("Who is watching?"), and whether a lone one skips the picker.
    val profiles: List<Profile> = emptyList(),
    val skipPicker: Boolean = true,
    // Onboarding: false only on a fresh install until the first-run wizard is done or skipped.
    val onboarded: Boolean = true,
    // Mobile Réglages > Thème: pure black (the TV keeps its own in TvSettings).
    val oled: Boolean = false,
)

// One extra account as stored: the token sealed by Vault, like the primary one.
@kotlinx.serialization.Serializable
private data class StoredAccount(val server: Server, val userId: String, val userName: String = "", val token: String)

// TP-10: one saved profile: the token sealed by Vault, the PIN as Pin.hash (never the PIN).
@kotlinx.serialization.Serializable
// fails / retryAt: the PIN rate limit (Pin.waitMs), kept here so a restart does not reset it.
internal data class StoredProfile(val server: Server, val userId: String, val userName: String = "", val token: String, val shared: Boolean = false, val pin: String? = null, val fails: Int = 0, val retryAt: Long = 0)

// TP-10: one PIN try on [p] at [now]: not even checked while it must wait; a miss counts and may start a wait.
// shortcut: wall clock, so setting the TV clock forward skips a wait; a household lock (see Pin), not a vault.
internal fun pinAttempt(p: StoredProfile, pin: String, now: Long): Pair<PinCheck, StoredProfile> {
    if (now < p.retryAt) return PinCheck(false, p.retryAt - now) to p
    if (Pin.matches(pin, p.pin)) return PinCheck(true) to p.copy(fails = 0, retryAt = 0)
    val fails = p.fails + 1
    val wait = Pin.waitMs(fails)
    return PinCheck(false, wait) to p.copy(fails = fails, retryAt = now + wait)
}

// TP-10: the profile list after [next] signs in. [next] replaces its own entry and keeps a PIN set earlier; the
// [outgoing] session (same server) stays a profile when it was not one yet (signed in before profiles existed, or
// without remember): Profiles.saved showed it as an account that opens without a password, so a switch must not lose it.
internal fun signedInProfiles(all: List<StoredProfile>, outgoing: StoredProfile?, next: StoredProfile): List<StoredProfile> {
    val same = { a: StoredProfile, b: StoredProfile -> a.server.id == b.server.id && a.userId == b.userId }
    val kept = if (outgoing == null || same(outgoing, next) || all.any { same(it, outgoing) }) all else all + outgoing
    val pin = next.pin ?: kept.firstOrNull { same(it, next) }?.pin
    return kept.filterNot { same(it, next) } + next.copy(pin = pin)
}

class Prefs(private val context: Context) {
    private val deviceKey = stringPreferencesKey("device_id")
    private val serverKey = stringPreferencesKey("server")
    private val userKey = stringPreferencesKey("user_id")
    private val userNameKey = stringPreferencesKey("user_name")
    private val tokenKey = stringPreferencesKey("token")
    private val sharedKey = booleanPreferencesKey("token_shared")
    private val accentKey = intPreferencesKey("accent")
    private val mbpsKey = intPreferencesKey("max_mbps")
    private val displayModeKey = intPreferencesKey("display_mode")
    private val wifiOnlyKey = booleanPreferencesKey("wifi_only_downloads")
    private val updateUrlKey = stringPreferencesKey("update_url")
    private val updateCheckedKey = longPreferencesKey("update_checked_at")
    private val remoteControlKey = booleanPreferencesKey("remote_control")
    private val oledKey = booleanPreferencesKey("oled")

    val data: Flow<Snapshot> = context.store.data.map { p -> snapshot(p) }

    private fun snapshot(p: Preferences): Snapshot {
        val server = p[serverKey]?.let { runCatching { json.decodeFromString(Server.serializer(), it) }.getOrNull() }
        val token = p[tokenKey]?.let(Vault::decrypt)
        val user = p[userKey]
        val session = if (server != null && user != null && token != null) Session(server, user, p[userNameKey].orEmpty(), token, p[sharedKey] == true) else null
        return Snapshot(p[deviceKey].orEmpty(), server, session, p[accentKey] ?: 0, p[mbpsKey] ?: 0, p[displayModeKey] ?: 0, p[wifiOnlyKey] ?: true, p[updateUrlKey].orEmpty(), p[remoteControlKey] ?: true, extras(p),
            profiles = storedProfiles(p).mapNotNull { a -> Vault.decrypt(a.token)?.let { Profile(Session(a.server, a.userId, a.userName, it, a.shared), a.pin != null) } },
            skipPicker = p[skipPickerKey] ?: true,
            onboarded = onboarded(p),
            oled = p[oledKey] ?: false,
        )
    }

    suspend fun current(): Snapshot {
        val p = context.store.data.first()
        if (p[deviceKey] == null || p[onboardedKey] == null) {
            // Checked again inside the edit (DataStore runs edits one at a time): two first-launch callers keep one id.
            context.store.edit { firstRun(it) }
        }
        return data.first()
    }

    suspend fun setServer(server: Server) = context.store.edit {
        if (!keepsSession(it[serverKey], server)) {
            it.remove(userKey); it.remove(tokenKey); it.remove(userNameKey); it.remove(sharedKey)
        }
        it[serverKey] = json.encodeToString(Server.serializer(), server)
    }

    // [remember]: also save it as a picker profile (TV only; mobile has no picker and no way to clear the list).
    suspend fun setSession(userId: String, userName: String, token: String, shared: Boolean = false, remember: Boolean = false) = context.store.edit {
        // TP-10: a remembered sign-in keeps a PIN set earlier, and the session it replaces (setServer already
        // dropped it if the server changed, so it belongs to this server).
        val server = if (remember) it[serverKey]?.let { s -> runCatching { json.decodeFromString(Server.serializer(), s) }.getOrNull() } else null
        val outUser = it[userKey]
        val outToken = it[tokenKey]
        val outgoing = if (server != null && outUser != null && outToken != null) StoredProfile(server, outUser, it[userNameKey].orEmpty(), outToken, it[sharedKey] == true) else null
        it[userKey] = userId
        it[userNameKey] = userName
        val sealed = Vault.encrypt(token)
        it[tokenKey] = sealed
        it[sharedKey] = shared
        if (server != null) it[profilesKey] = json.encodeToString(profileList, signedInProfiles(storedProfiles(it), outgoing, StoredProfile(server, userId, userName, sealed, shared)))
    }

    suspend fun signOut() {
        context.store.edit {
            it.remove(userKey); it.remove(tokenKey); it.remove(userNameKey); it.remove(sharedKey)
        }
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { runCatching { clearImages() } }
    }

    // Photos spec §6.1: cached thumbnails are that account's personal images; they leave with it. Set by each app,
    // which owns Coil's image loader.
    var clearImages: () -> Unit = {}

    // TP-06: extra accounts. A token that no longer opens (Keystore reset) drops its account.
    private val extrasKey = stringPreferencesKey("extra_accounts")
    private val accounts = kotlinx.serialization.builtins.ListSerializer(StoredAccount.serializer())

    private fun stored(p: Preferences): List<StoredAccount> =
        p[extrasKey]?.let { runCatching { json.decodeFromString(accounts, it) }.getOrNull() }.orEmpty()

    private fun extras(p: Preferences): List<Session> =
        stored(p).mapNotNull { a -> Vault.decrypt(a.token)?.let { Session(a.server, a.userId, a.userName, it) } }

    // One account per server: signing in again replaces it.
    suspend fun addAccount(s: Session) = context.store.edit {
        it[extrasKey] = json.encodeToString(accounts, stored(it).filter { a -> a.server.id != s.server.id } + StoredAccount(s.server, s.userId, s.userName, Vault.encrypt(s.token)))
    }

    // Plex (plex spec §5.3): the same signed-in server at another of the connections plex.tv listed for it, the token
    // kept. One edit, so the shell never sees the session gone between the address and the token (setServer drops it).
    suspend fun moveSession(serverId: String, address: String) = context.store.edit {
        val main = it[serverKey]?.let { s -> runCatching { json.decodeFromString(Server.serializer(), s) }.getOrNull() }
        if (main?.id == serverId) it[serverKey] = json.encodeToString(Server.serializer(), main.copy(address = address))
        val extra = stored(it)
        if (extra.any { a -> a.server.id == serverId }) {
            it[extrasKey] = json.encodeToString(accounts, extra.map { a -> if (a.server.id == serverId) a.copy(server = a.server.copy(address = address)) else a })
        }
    }

    suspend fun removeAccount(serverId: String) {
        context.store.edit {
            it[extrasKey] = json.encodeToString(accounts, stored(it).filter { a -> a.server.id != serverId })
        }
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { runCatching { clearImages() } }
    }

    // TP-10: saved profiles.
    private val profilesKey = stringPreferencesKey("profiles")
    private val skipPickerKey = booleanPreferencesKey("skip_profile_picker")
    private val profileList = kotlinx.serialization.builtins.ListSerializer(StoredProfile.serializer())

    private fun storedProfiles(p: Preferences): List<StoredProfile> =
        p[profilesKey]?.let { runCatching { json.decodeFromString(profileList, it) }.getOrNull() }.orEmpty()

    private fun same(a: StoredProfile, serverId: String, userId: String) = a.server.id == serverId && a.userId == userId

    // Sign out (not switch user): the account and its PIN leave this device.
    suspend fun removeProfile(serverId: String, userId: String) = context.store.edit {
        it[profilesKey] = json.encodeToString(profileList, storedProfiles(it).filterNot { a -> same(a, serverId, userId) })
    }

    // [pin] null removes it. Saves [s] as a profile if it was not one yet (signed in before profiles existed).
    suspend fun setPin(s: Session, pin: String?) {
        val hash = pin?.let { kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { Pin.hash(it) } }
        context.store.edit {
            val old = storedProfiles(it).firstOrNull { a -> same(a, s.server.id, s.userId) }
            val base = old ?: StoredProfile(s.server, s.userId, s.userName, Vault.encrypt(s.token), s.shared)
            it[profilesKey] = json.encodeToString(profileList, storedProfiles(it).filterNot { a -> same(a, s.server.id, s.userId) } + base.copy(pin = hash, fails = 0, retryAt = 0))
        }
    }

    // Rate-limited (pinAttempt); inside the edit, so two tries at once still count twice.
    suspend fun checkPin(s: Session, pin: String): PinCheck {
        var out = PinCheck(false)
        context.store.edit {
            val all = storedProfiles(it)
            val p = all.firstOrNull { a -> same(a, s.server.id, s.userId) } ?: return@edit
            val (check, next) = pinAttempt(p, pin, System.currentTimeMillis())
            out = check
            if (next != p) it[profilesKey] = json.encodeToString(profileList, all.map { a -> if (a === p) next else a })
        }
        return out
    }

    suspend fun setSkipPicker(v: Boolean) = context.store.edit { it[skipPickerKey] = v }

    suspend fun setOnboarded(v: Boolean) = context.store.edit { it[onboardedKey] = v }

    suspend fun setAccent(i: Int) = context.store.edit { it[accentKey] = i }

    suspend fun setMaxMbps(v: Int) = context.store.edit { it[mbpsKey] = v }

    suspend fun setDisplayMode(v: Int) = context.store.edit { it[displayModeKey] = v }

    suspend fun setWifiOnlyDownloads(v: Boolean) = context.store.edit { it[wifiOnlyKey] = v }

    suspend fun setRemoteControl(v: Boolean) = context.store.edit { it[remoteControlKey] = v }

    suspend fun setOled(v: Boolean) = context.store.edit { it[oledKey] = v }

    // A new URL is checked at the next start, whatever the 6 h rule says.
    suspend fun setUpdateUrl(v: String) = context.store.edit {
        it[updateUrlKey] = v.trim()
        it.remove(updateCheckedKey)
    }

    suspend fun updateCheckedAt(): Long = context.store.data.first()[updateCheckedKey] ?: 0L

    suspend fun setUpdateCheckedAt(v: Long) = context.store.edit { it[updateCheckedKey] = v }

    // X-01: the cards removed from Continue Watching (ContinueWatching.kt), JSON.
    private val continueHiddenKey = stringPreferencesKey("continue_hidden")

    suspend fun continueHidden(): String = context.store.data.first()[continueHiddenKey].orEmpty()

    suspend fun setContinueHidden(v: String) = context.store.edit { it[continueHiddenKey] = v }

    // CA-11: the disposable cast tokens not revoked yet (cast/EphemeralToken.kt), JSON sealed like the session token.
    private val castTokensKey = stringPreferencesKey("cast_tokens")

    suspend fun castTokens(): String = context.store.data.first()[castTokensKey]?.let(Vault::decrypt).orEmpty()

    suspend fun setCastTokens(v: String) = context.store.edit { if (v.isEmpty()) it.remove(castTokensKey) else it[castTokensKey] = Vault.encrypt(v) }
}

// Access tokens are sealed with an AES-GCM key that never leaves the Android Keystore.
// Internal: the qBittorrent password (core.torrents) is sealed with it too.
internal object Vault {
    private const val ALIAS = "wicaby_token"

    // Synchronized: two first-launch callers would each generate a key, and the second replaces the
    // first under the same alias, so whatever the first sealed no longer opens (silent sign-out).
    @Synchronized
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return gen.generateKey()
    }

    fun encrypt(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        return Base64.encodeToString(c.iv + c.doFinal(plain.toByteArray()), Base64.NO_WRAP)
    }

    fun decrypt(sealed: String): String? = runCatching {
        val b = Base64.decode(sealed, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, b, 0, 12))
        String(c.doFinal(b, 12, b.size - 12))
    }.getOrNull()
}
