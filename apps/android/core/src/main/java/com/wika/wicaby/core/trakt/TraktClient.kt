package com.wika.wicaby.core.trakt

import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

// Trakt API v2 calls Wicaby needs, as the desktop's src/main/features/trakt-client.ts: the OAuth
// device-code flow, token refresh and revocation, scrobbling, and the watched history.
// Error messages never carry a token.

const val TRAKT_API = "https://api.trakt.tv"

// Trakt speaks snake_case: not the PascalCase naming of the Emby [json].
internal val traktJson = Json { ignoreUnknownKeys = true }

class TraktException(val status: Int) : IOException("Trakt HTTP $status")

@Serializable
data class DeviceCode(
    @kotlinx.serialization.SerialName("device_code") val deviceCode: String,
    @kotlinx.serialization.SerialName("user_code") val userCode: String,
    @kotlinx.serialization.SerialName("verification_url") val verificationUrl: String,
    @kotlinx.serialization.SerialName("expires_in") val expiresIn: Long,
    val interval: Long = 5,
)

@Serializable
data class Tokens(
    @kotlinx.serialization.SerialName("access_token") val accessToken: String = "",
    @kotlinx.serialization.SerialName("refresh_token") val refreshToken: String = "",
    @kotlinx.serialization.SerialName("expires_in") val expiresIn: Long = 0,
    @kotlinx.serialization.SerialName("created_at") val createdAt: Long = 0,
) {
    override fun toString() = "Tokens(<redacted>)"
}

sealed interface Poll {
    data object Pending : Poll
    data object SlowDown : Poll
    class Done(val tokens: Tokens) : Poll
}

// The plain client: no transport, no server credentials (Core.http adds them), and no redirect,
// which must never carry the Bearer token elsewhere.
internal val traktHttp: OkHttpClient by lazy {
    OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(8, TimeUnit.SECONDS).callTimeout(20, TimeUnit.SECONDS).build()
}

class TraktClient(private val base: String, private val clientId: String, private val http: OkHttpClient = traktHttp) {
    private class Res(val status: Int, val body: String)

    private suspend fun call(path: String, body: JsonElement? = null, token: String? = null): Res = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(base.trimEnd('/') + path)
            .header("Content-Type", "application/json")
            .header("trakt-api-version", "2")
            .header("trakt-api-key", clientId)
        token?.let { req.header("Authorization", "Bearer $it") }
        if (body != null) req.post(body.toString().toRequestBody("application/json".toMediaType()))
        http.newCall(req.build()).execute().use { Res(it.code, runCatching { it.body.string() }.getOrDefault("")) }
    }

    private suspend fun ok(path: String, body: JsonElement? = null, token: String? = null): String {
        val r = call(path, body, token)
        if (r.status !in 200..299) throw TraktException(r.status)
        return r.body
    }

    suspend fun deviceCode(): DeviceCode = traktJson.decodeFromString(ok("/oauth/device/code", buildJsonObject { put("client_id", clientId) }))

    // Pending until the user enters the code, SlowDown on 429; 404/409/410/418 (bad, used, expired, denied code) throw.
    suspend fun pollToken(code: String, secret: String): Poll {
        val r = call("/oauth/device/token", buildJsonObject { put("code", code); put("client_id", clientId); put("client_secret", secret) })
        if (r.status == 200) runCatching { traktJson.decodeFromString<Tokens>(r.body) }.getOrNull()?.takeIf { it.accessToken.isNotEmpty() }?.let { return Poll.Done(it) }
        if (r.status == 400) return Poll.Pending
        if (r.status == 429) return Poll.SlowDown
        throw TraktException(r.status)
    }

    suspend fun refresh(refreshToken: String, secret: String): Tokens = traktJson.decodeFromString(
        ok(
            "/oauth/token",
            buildJsonObject {
                put("refresh_token", refreshToken); put("client_id", clientId); put("client_secret", secret)
                put("redirect_uri", "urn:ietf:wg:oauth:2.0:oob"); put("grant_type", "refresh_token")
            },
        ),
    )

    suspend fun revoke(token: String, secret: String) {
        ok("/oauth/revoke", buildJsonObject { put("token", token); put("client_id", clientId); put("client_secret", secret) })
    }

    suspend fun username(token: String): String {
        val body = ok("/users/settings", null, token)
        return runCatching { json.parseToJsonElement(body).jsonObject["user"]?.jsonObject?.get("username")?.jsonPrimitive?.contentOrNull }.getOrNull().orEmpty()
    }

    // 409: Trakt already has this scrobble (a repeat within the hour), not a failure.
    suspend fun scrobble(action: String, token: String, body: JsonObject) {
        val r = call("/scrobble/$action", body, token)
        if (r.status !in 200..299 && r.status != 409) throw TraktException(r.status)
    }

    // A watched mark set by hand: added to the Trakt history.
    suspend fun addHistory(token: String, body: JsonObject) {
        ok("/sync/history", body, token)
    }

    // B25: a watched mark cleared by hand removes the latest play only; /sync/history/remove with the item's ids
    // would erase every play (rewatches and their dates). Nothing when Trakt does not know the item or has no play.
    suspend fun removeLatestPlay(token: String, item: Item) {
        val (kind, ids) = traktIds(item) ?: return
        val (idType, id) = ids.entries.first()
        fun array(body: String) = traktJson.parseToJsonElement(body) as? JsonArray
        val traktId = array(ok("/search/$idType/${id.jsonPrimitive.content}?type=$kind", null, token))
            ?.firstNotNullOfOrNull { (((it as? JsonObject)?.get(kind) as? JsonObject)?.get("ids") as? JsonObject)?.get("trakt").long() } ?: return
        // Newest first.
        val latest = (array(ok("/sync/history/${kind}s/$traktId?limit=1", null, token))?.firstOrNull() as? JsonObject)?.get("id").long() ?: return
        ok("/sync/history/remove", buildJsonObject { put("ids", buildJsonArray { add(latest) }) }, token)
    }
}

private fun JsonElement?.long() = (this as? JsonPrimitive)?.longOrNull

// The ids Trakt matches a movie or an episode on (imdb/tmdb/tvdb); null when there is nothing to match.
private fun traktIds(item: Item): Pair<String, JsonObject>? {
    val kind = when (item.type) {
        "Movie" -> "movie"
        "Episode" -> "episode"
        else -> return null
    }
    val ids = buildMap<String, JsonPrimitive> {
        for ((k, v) in item.providerIds) {
            val key = k.lowercase()
            val value = v.orEmpty().trim()
            if (key == "imdb" && Regex("^tt\\d+$").matches(value)) put("imdb", JsonPrimitive(value))
            else if ((key == "tmdb" || key == "tvdb") && Regex("^\\d+$").matches(value)) value.toLongOrNull()?.let { put(key, JsonPrimitive(it)) }
        }
    }
    if (ids.isEmpty()) return null
    return kind to JsonObject(ids)
}

// The scrobble body, as the desktop's scrobbleBody: progress in percent, clamped, two decimals.
fun scrobbleBody(item: Item, progress: Double): JsonObject? {
    val (kind, ids) = traktIds(item) ?: return null
    val pct = if (progress.isFinite()) progress.coerceIn(0.0, 100.0) else 0.0
    return buildJsonObject {
        put(kind, buildJsonObject { put("ids", ids) })
        put("progress", Math.round(pct * 100) / 100.0)
    }
}

// The /sync/history body for one movie or episode: {"movies":[{"ids":…}]} or {"episodes":[…]}.
fun historyBody(item: Item): JsonObject? {
    val (kind, ids) = traktIds(item) ?: return null
    return buildJsonObject { put("${kind}s", buildJsonArray { add(buildJsonObject { put("ids", ids) }) }) }
}

// The server's plugin list (GET /Plugins, admin only) holds an active Trakt plugin.
// Emby lists loaded plugins only; Jellyfin adds a Status.
fun hasTraktPlugin(list: JsonElement): Boolean = (list as? JsonArray).orEmpty().any { p ->
    val o = p as? JsonObject ?: return@any false
    val name = (o["Name"] as? JsonPrimitive)?.contentOrNull.orEmpty()
    val status = (o["Status"] as? JsonPrimitive)?.contentOrNull
    name.contains("trakt", ignoreCase = true) && (status == null || status == "Active" || status == "Restart")
}
