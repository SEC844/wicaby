package com.wika.wicaby.core.plex

import com.wika.wicaby.core.BuildConfig
import com.wika.wicaby.core.data.ApiException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URLEncoder

// plex.tv and PMS JSON is camelCase: its own lenient reader (no PascalCase naming), invalid input tolerated (§12).
@OptIn(ExperimentalSerializationApi::class)
internal val plexJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    explicitNulls = false
    coerceInputValues = true
}

// Who this device is, in the X-Plex-* headers every plex.tv and PMS request carries (plex-spec §1.2: truthful, and
// never a Plex first-party product name).
data class PlexClient(val deviceId: String, val deviceName: String, val version: String, val platformVersion: String = android.os.Build.VERSION.RELEASE ?: "") {
    fun headers(token: String? = null): Map<String, String> = buildMap {
        put("Accept", "application/json")
        put("X-Plex-Product", "Wicaby")
        put("X-Plex-Version", version)
        put("X-Plex-Client-Identifier", deviceId)
        put("X-Plex-Device", "Android")
        put("X-Plex-Device-Name", deviceName)
        put("X-Plex-Platform", "Android")
        put("X-Plex-Platform-Version", platformVersion)
        // The token only as a header, never in a URL.
        token?.let { put("X-Plex-Token", it) }
    }
}

@Serializable
data class PlexPin(val id: Long = 0, val code: String = "", val expiresIn: Int? = null, val authToken: String? = null) {
    override fun toString() = "PlexPin(id=$id, code=$code, expiresIn=$expiresIn, authToken=${if (authToken == null) null else "<redacted>"})"
}

@Serializable
data class PlexResource(
    val name: String = "",
    val clientIdentifier: String = "",
    val provides: String? = null,
    val productVersion: String? = null,
    val owned: Boolean = false,
    val sourceTitle: String? = null,
    val accessToken: String? = null,
    val httpsRequired: Boolean = false,
    val connections: List<PlexConnection> = emptyList(),
) {
    override fun toString() = "PlexResource(name=$name, id=$clientIdentifier, owned=$owned, connections=${connections.size})"
}

@Serializable
data class PlexHomeUser(val id: Long? = null, val uuid: String = "", val title: String = "", val admin: Boolean = false, val protected: Boolean = false, val thumb: String? = null)

@Serializable
data class PlexAccountUser(val uuid: String = "", val title: String? = null, val username: String? = null, val subscription: JsonObject? = null, val profile: JsonObject? = null)

// plex.tv (plex-spec §2, §5.1, §5.5): the PIN link ("link with a code"), the account's servers, Home users and the
// switch between them, and the watchlist that stands in for Favorites (D-6). The account and Home user tokens go
// only to plex.tv, clients.plex.tv and discover.provider.plex.tv, never to a PMS. A debug build can point all three
// at the mock (tools/mock-server/mock-plex.mjs on loopback, through adb reverse on an emulator).
// TODO(owner, D-8): a human reads the current plex.tv terms before any public release with Plex.
class PlexTv(private val http: OkHttpClient, private val client: suspend () -> PlexClient) {
    enum class Host(val url: String) { PLEX("https://plex.tv"), CLIENTS("https://clients.plex.tv"), DISCOVER("https://discover.provider.plex.tv") }

    private suspend fun call(host: Host, method: String, path: String, token: String? = null): String = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(base(host) + path)
        client().headers(token).forEach { (k, v) -> req.header(k, v) }
        req.method(method, if (method == "GET") null else ByteArray(0).toRequestBody("application/json".toMediaType()))
        // No redirect: a token never follows one off plex.tv.
        http.newBuilder().followRedirects(false).followSslRedirects(false).build().newCall(req.build()).execute().use { res ->
            if (!res.isSuccessful) throw ApiException("plex.tv ${res.code}", res.code)
            res.body.string()
        }
    }

    suspend fun createPin(): PlexPin = plexJson.decodeFromString(PlexPin.serializer(), call(Host.PLEX, "POST", "/api/v2/pins?strong=false"))

    // null once the PIN expired (plex.tv answers 404).
    suspend fun pin(id: Long): PlexPin? = try {
        plexJson.decodeFromString(PlexPin.serializer(), call(Host.PLEX, "GET", "/api/v2/pins/$id"))
    } catch (e: ApiException) {
        if (e.status == 404) null else throw e
    }

    suspend fun user(token: String): PlexAccountUser = plexJson.decodeFromString(PlexAccountUser.serializer(), call(Host.PLEX, "GET", "/api/v2/user", token))

    // The servers this user can reach (players and other resources left out), each with its own accessToken.
    suspend fun servers(token: String): List<PlexResource> {
        val all = runCatching { plexJson.decodeFromString<List<PlexResource>>(call(Host.CLIENTS, "GET", "/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1", token)) }
            .getOrElse { if (it is IOException) throw it else emptyList() }
        return all.filter { r -> "server" in (r.provides ?: "").split(',') && MACHINE_ID.matches(r.clientIdentifier) }
    }

    suspend fun homeUsers(token: String): List<PlexHomeUser> {
        val r = plexJson.parseToJsonElement(call(Host.PLEX, "GET", "/api/v2/home/users", token))
        return r["users"].list().mapNotNull { runCatching { plexJson.decodeFromJsonElement(PlexHomeUser.serializer(), it) }.getOrNull() }
            .filter { it.uuid.isNotEmpty() && it.title.isNotEmpty() }
    }

    // The Home user's own token. A protected user needs their PIN: 401 when it is wrong.
    suspend fun switchUser(token: String, uuid: String, pin: String? = null): String {
        val q = if (pin.isNullOrEmpty()) "" else "?pin=" + URLEncoder.encode(pin, "UTF-8")
        val r = plexJson.parseToJsonElement(call(Host.PLEX, "POST", "/api/v2/home/users/${URLEncoder.encode(uuid, "UTF-8")}/switch$q", token))
        return r["authToken"].str()?.takeIf { it.isNotEmpty() } ?: throw ApiException("plex.tv switch without a token", 502)
    }

    // The watchlist's plex:// GUIDs (D-6: the Favorites of a plex server).
    suspend fun watchlist(token: String): List<String> {
        val r = plexJson.parseToJsonElement(call(Host.DISCOVER, "GET", "/library/sections/watchlist/all?includeFields=guid&X-Plex-Container-Size=300", token))
        return r["MediaContainer"]["Metadata"].list().mapNotNull { it["guid"]?.takeIf { g -> g.isStr() }?.str() }
    }

    // Discover's ratingKey is the id at the end of a plex:// GUID.
    suspend fun setWatchlisted(token: String, guid: String, on: Boolean) {
        val key = WATCH_GUID.find(guid)?.groupValues?.get(1) ?: throw PlexUnmapped("watchlist without a plex:// guid")
        call(Host.DISCOVER, "PUT", "/actions/${if (on) "addToWatchlist" else "removeFromWatchlist"}?ratingKey=$key", token)
    }

    companion object {
        val MACHINE_ID = Regex("^[0-9a-f]{40}$", RegexOption.IGNORE_CASE)
        private val WATCH_GUID = Regex("^plex://\\w+/([0-9a-z]+)$", RegexOption.IGNORE_CASE)
        private val LOOPBACK = Regex("^http://(127\\.0\\.0\\.1|localhost):\\d+$")

        // Debug builds only: every plex.tv host at the mock. A release build ignores it.
        @Volatile
        var devBase: String? = null

        fun base(host: Host): String = devBase?.trimEnd('/')?.takeIf { BuildConfig.DEBUG && LOOPBACK.matches(it) } ?: host.url

        fun linkUrl(code: String) = "https://plex.tv/link?code=" + URLEncoder.encode(code, "UTF-8")
    }
}
