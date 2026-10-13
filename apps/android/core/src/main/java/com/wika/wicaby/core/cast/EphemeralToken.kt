package com.wika.wicaby.core.cast

import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.json
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import java.util.Collections
import java.util.UUID

// A disposable Jellyfin token for what a renderer gets (cast spec CA-11): minted through Quick Connect, kept sealed in
// Prefs (Logout needs the token itself, not a hash) until it is revoked. [origin]: the server address it was minted
// on; it is only ever sent back there.
@Serializable
data class Disposable(val token: String, val deviceId: String, val kind: String, val serverId: String, val origin: String, val name: String) {
    override fun toString() = "Disposable(kind=$kind, serverId=$serverId, deviceId=$deviceId, token=<redacted>)"
}

// Quick Connect on Jellyfin only (Emby has no equivalent: its renderers keep the user token, §2.6.3). The token still
// carries the user's full rights; it is limited in time, not in scope.
// - SENDER: a cast this phone reports for (DLNA, the Default Media Receiver); revoked when the cast ends.
// - RECEIVER: Jellyfin's Cast receiver plays on after the phone lets go; revoked on Stop, or at a cleanup once
//   GET /Sessions?DeviceId= no longer lists the token's device.
// cleanup() runs whenever a session starts (Core.api), so a crash leaves nothing behind for more than one app start.
class EphemeralTokens(
    private val load: suspend () -> String = { Core.prefs.castTokens() },
    private val save: suspend (String) -> Unit = { Core.prefs.setCastTokens(it) },
) {
    private val lock = Mutex()
    // Sender tokens of casts alive in this process: a cleanup leaves them alone (a receiver's is judged by its session).
    private val live: MutableSet<String> = Collections.synchronizedSet(HashSet())

    @Serializable
    private data class Initiated(val code: String? = null, val secret: String? = null)

    @Serializable
    private data class Authenticated(val accessToken: String? = null)

    private val serializer = ListSerializer(Disposable.serializer())

    suspend fun list(): List<Disposable> = runCatching { json.decodeFromString(serializer, load().ifEmpty { "[]" }) }.getOrDefault(emptyList())

    private suspend fun edit(f: (List<Disposable>) -> List<Disposable>) = lock.withLock {
        val next = f(list())
        save(if (next.isEmpty()) "" else json.encodeToString(serializer, next))
    }

    // A fresh token for a cast to [name], stored before it is used; null on Emby, with Quick Connect off, or on any
    // failure (the caller falls back to the user token, without an error).
    suspend fun mint(api: Api, name: String, kind: String): Disposable? {
        val origin = api.server.origin
        if (api.server.isEmby || api.token == null || origin == null) return null
        return try {
            if (!api.get<Boolean>("/QuickConnect/Enabled")) return null
            val dev = Disposable("", UUID.randomUUID().toString().replace("-", ""), kind, api.server.id, origin, name.take(64).ifBlank { "Cast" })
            val init = json.decodeFromString(Initiated.serializer(), call(api, dev, "/QuickConnect/Initiate"))
            val code = init.code ?: return null
            val secret = init.secret ?: return null
            // [UNVERIFIED] without userId the server authorizes the code for the caller (RequestHelpers.GetUserId).
            api.raw("POST", "/QuickConnect/Authorize", null, "code" to code)
            val auth = json.decodeFromString(Authenticated.serializer(), call(api, dev, "/Users/AuthenticateWithQuickConnect", buildJsonObject { put("Secret", secret) }.toString()))
            val d = dev.copy(token = auth.accessToken?.takeIf { it.isNotBlank() } ?: return null)
            edit { it + d }
            if (kind == SENDER) live += d.token
            d
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
    }

    // Logout with the token itself revokes it; a 401 means it is gone already. Otherwise it stays for a later cleanup.
    suspend fun revoke(d: Disposable, api: Api): Boolean {
        if (api.server.id != d.serverId || api.server.origin != d.origin) return false
        try {
            call(api, d, "/Sessions/Logout")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if ((e as? ApiException)?.status != 401) return false
        }
        live -= d.token
        edit { l -> l.filterNot { it.token == d.token } }
        return true
    }

    // The leftovers on [api]'s server: a crash, a cast whose revoke failed, a receiver whose session is gone.
    suspend fun cleanup(api: Api) {
        for (d in list()) {
            if (d.serverId != api.server.id || d.origin != api.server.origin || d.token in live) continue
            // [UNVERIFIED] the receiver may report under its own DeviceId; this is the token's device session.
            if (d.kind == RECEIVER && runCatching { api.get<JsonArray>("/Sessions", "DeviceId" to d.deviceId).isNotEmpty() }.getOrDefault(true)) continue
            revoke(d, api)
        }
    }

    // A POST as the cast's own device (Client "Wicaby Cast", the renderer's name, a random DeviceId), with its token
    // once it has one. Not Api.raw: that one speaks as this phone.
    private suspend fun call(api: Api, d: Disposable, path: String, body: String? = null): String = withContext(Dispatchers.IO) {
        fun q(v: String) = "\"" + URLEncoder.encode(v, "UTF-8").replace("+", "%20") + "\""
        val auth = buildList {
            add("Client=${q("Wicaby Cast")}"); add("Device=${q(d.name)}"); add("DeviceId=${q(d.deviceId)}"); add("Version=${q(Core.version.ifEmpty { "0" })}")
            if (d.token.isNotEmpty()) add("Token=${q(d.token)}")
        }
        val req = Request.Builder().url(api.url(path)).header("Accept", "application/json").header("Authorization", "MediaBrowser " + auth.joinToString(", "))
            .post((body ?: "").toRequestBody("application/json".toMediaType())).build()
        Core.http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw ApiException("HTTP ${res.code}", res.code)
            res.body.string()
        }
    }

    companion object {
        const val SENDER = "sender"
        const val RECEIVER = "receiver"
        val shared by lazy { EphemeralTokens() }
    }
}
