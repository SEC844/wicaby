package com.wika.wicaby.core.scrobble

import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.TICKS_PER_MS
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.FormBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

// Music scrobbling to ListenBrainz and Last.fm, as the desktop's src/main/features/scrobble-client.ts: the scrobble
// rule, the payloads, the Last.fm signature and the few calls Wicaby needs. Error messages never carry a token,
// a session key or a secret.

const val LISTENBRAINZ_API = "https://api.listenbrainz.org"
const val LASTFM_API = "https://ws.audioscrobbler.com/2.0/"
const val LASTFM_AUTH = "https://www.last.fm/api/auth/"

internal val scrobbleJson = Json { ignoreUnknownKeys = true; explicitNulls = false }

// retry: worth sending again later (network, 429, 5xx, Last.fm "try again"); auth: the token or session is refused.
class ScrobbleException(message: String, val retry: Boolean, val auth: Boolean = false, val code: Int = 0) : IOException(message)

@Serializable
data class TrackInfo(
    val artists: List<String>,
    val track: String,
    val album: String? = null,
    val albumArtist: String? = null,
    val durationMs: Long? = null,
    val trackNumber: Int? = null,
    // ListenBrainz additional_info keys (recording_mbid, release_mbid…), validated UUIDs only.
    val mbids: Map<String, String> = emptyMap(),
)

/** The standard rule (Last.fm and ListenBrainz alike): a track of 30 s or more, heard for 4 min or half its length. Unknown length: 4 min. */
fun shouldScrobble(durationMs: Long, listenedMs: Long): Boolean =
    if (durationMs <= 0) listenedMs >= 240_000 else durationMs >= 30_000 && listenedMs >= minOf(240_000, durationMs / 2)

private val UUID_RE = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)
// Server provider id → ListenBrainz additional_info key.
private val MBID_KEYS = mapOf(
    "musicbrainzrecording" to "recording_mbid",
    "musicbrainztrack" to "track_mbid",
    "musicbrainzalbum" to "release_mbid",
    "musicbrainzreleasegroup" to "release_group_mbid",
)

/** What a track says about itself; null when it is not a song with a title and an artist. */
fun trackInfo(item: Item): TrackInfo? {
    if (item.type != "Audio") return null
    val track = item.name.trim()
    val albumArtist = item.albumArtist?.trim()?.ifEmpty { null }
    val artists = item.artists.map { it.trim() }.filter { it.isNotEmpty() }.ifEmpty { listOfNotNull(albumArtist) }
    if (track.isEmpty() || artists.isEmpty()) return null
    val mbids = item.providerIds.mapNotNull { (k, v) -> MBID_KEYS[k.lowercase()]?.takeIf { v != null && UUID_RE.matches(v) }?.let { it to v!!.lowercase() } }.toMap()
    return TrackInfo(
        artists, track, item.album?.trim()?.ifEmpty { null }, albumArtist,
        item.runTimeTicks?.let { it / TICKS_PER_MS }?.takeIf { it > 0 }, item.indexNumber?.takeIf { it > 0 }, mbids,
    )
}

/** One listen ([listenedAt] in Unix seconds) or the playing-now notice ([listenedAt] null). */
fun listenBody(info: TrackInfo, listenedAt: Long?, version: String): JsonObject {
    val meta = buildJsonObject {
        put("artist_name", info.artists.joinToString(", "))
        put("track_name", info.track)
        info.album?.let { put("release_name", it) }
        put(
            "additional_info",
            buildJsonObject {
                info.durationMs?.let { put("duration_ms", it) }
                info.trackNumber?.let { put("tracknumber", it) }
                if (info.artists.size > 1) put("artist_names", buildJsonArray { info.artists.forEach { add(JsonPrimitive(it)) } })
                info.mbids.forEach { (k, v) -> put(k, v) }
                put("media_player", "Wicaby")
                put("submission_client", "Wicaby")
                put("submission_client_version", version)
            },
        )
    }
    return buildJsonObject {
        put("listen_type", if (listenedAt == null) "playing_now" else "single")
        put("payload", buildJsonArray { add(buildJsonObject { listenedAt?.let { put("listened_at", it) }; put("track_metadata", meta) }) })
    }
}

/** api_sig: every parameter but format and callback, sorted by name, as name+value, then the secret, md5 in UTF-8. */
fun lastfmSign(params: Map<String, String>, secret: String): String {
    val s = params.filterKeys { it != "format" && it != "callback" }.toSortedMap().entries.joinToString("") { it.key + it.value } + secret
    return MessageDigest.getInstance("MD5").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}

/** track.updateNowPlaying ([timestamp] null) or track.scrobble parameters, before the key, session and signature. */
fun lastfmTrackParams(info: TrackInfo, timestamp: Long?): Map<String, String> = buildMap {
    put("artist", info.artists[0])
    put("track", info.track)
    info.album?.let { put("album", it) }
    info.albumArtist?.let { put("albumArtist", it) }
    info.trackNumber?.let { put("trackNumber", it.toString()) }
    info.durationMs?.let { put("duration", ((it + 500) / 1000).toString()) }
    info.mbids["recording_mbid"]?.let { put("mbid", it) }
    timestamp?.let { put("timestamp", it.toString()) }
}

// The plain client: no transport, no server credentials (Core.http adds them), and no redirect, which must never carry a token elsewhere.
internal val scrobbleHttp: OkHttpClient by lazy {
    OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(8, TimeUnit.SECONDS).callTimeout(20, TimeUnit.SECONDS).build()
}

private class Res(val status: Int, val body: String)

private suspend fun OkHttpClient.send(req: Request, name: String): Res = withContext(Dispatchers.IO) {
    try {
        newCall(req).execute().use { Res(it.code, runCatching { it.body.string() }.getOrDefault("")) }
    } catch (e: IOException) {
        throw ScrobbleException("$name unreachable: ${e.javaClass.simpleName}", retry = true)
    }
}

class ListenBrainzClient(private val base: String = LISTENBRAINZ_API, private val http: OkHttpClient = scrobbleHttp) {
    private suspend fun call(path: String, token: String, body: JsonObject? = null): String {
        val req = Request.Builder().url(base.trimEnd('/') + path).header("Authorization", "Token $token")
        if (body != null) req.post(body.toString().toRequestBody("application/json".toMediaType()))
        val r = http.send(req.build(), "ListenBrainz")
        if (r.status in 200..299) return r.body
        throw ScrobbleException("ListenBrainz HTTP ${r.status}", retry = r.status == 429 || r.status >= 500, auth = r.status == 401, code = r.status)
    }

    /** The user name of a valid token ("" when ListenBrainz does not say), else null. */
    suspend fun validate(token: String): String? {
        val o = runCatching { scrobbleJson.parseToJsonElement(call("/1/validate-token", token)).jsonObject }.getOrElse { if (it is ScrobbleException) throw it else return null }
        if (o["valid"]?.jsonPrimitive?.contentOrNull != "true") return null
        return o["user_name"]?.jsonPrimitive?.contentOrNull.orEmpty()
    }

    suspend fun submit(token: String, body: JsonObject) {
        call("/1/submit-listens", token, body)
    }
}

// Error codes worth a retry: operation failed, service offline, temporarily unavailable, rate limit.
private val LASTFM_RETRY = setOf(8, 11, 16, 29)
// Invalid service, invalid session key, invalid API key, suspended key.
private val LASTFM_AUTH_CODES = setOf(4, 9, 10, 26)

class LastfmClient(private val apiKey: String, private val secret: String, private val base: String = LASTFM_API, private val http: OkHttpClient = scrobbleHttp) {
    private suspend fun call(method: String, params: Map<String, String>, post: Boolean): JsonObject {
        val all = params + mapOf("method" to method, "api_key" to apiKey)
        val signed = all + mapOf("api_sig" to lastfmSign(all, secret), "format" to "json")
        val req = if (post) {
            Request.Builder().url(base).post(FormBody.Builder().apply { signed.forEach { (k, v) -> add(k, v) } }.build())
        } else {
            Request.Builder().url(base.toHttpUrl().newBuilder().apply { signed.forEach { (k, v) -> addQueryParameter(k, v) } }.build())
        }
        val r = http.send(req.build(), "Last.fm")
        val o = runCatching { scrobbleJson.parseToJsonElement(r.body).jsonObject }.getOrNull()
        o?.get("error")?.jsonPrimitive?.intOrNull?.let { code ->
            val msg = o["message"]?.jsonPrimitive?.contentOrNull?.let { ": $it" }.orEmpty()
            throw ScrobbleException("Last.fm error $code$msg", retry = code in LASTFM_RETRY, auth = code in LASTFM_AUTH_CODES, code = code)
        }
        if (r.status !in 200..299 || o == null) throw ScrobbleException("Last.fm HTTP ${r.status}", retry = r.status == 429 || r.status >= 500)
        return o
    }

    suspend fun getToken(): String =
        call("auth.getToken", emptyMap(), false)["token"]?.jsonPrimitive?.contentOrNull ?: throw ScrobbleException("Last.fm sent no token", retry = false)

    fun authUrl(token: String): String = LASTFM_AUTH.toHttpUrl().newBuilder().addQueryParameter("api_key", apiKey).addQueryParameter("token", token).build().toString()

    /** The session (key, name) once the user allowed the token on last.fm; null while they have not yet (error 14). */
    suspend fun getSession(token: String): Pair<String, String>? {
        val o = try {
            call("auth.getSession", mapOf("token" to token), false)
        } catch (e: ScrobbleException) {
            if (e.code == 14) return null
            throw e
        }
        val s = o["session"]?.jsonObject
        val key = s?.get("key")?.jsonPrimitive?.contentOrNull ?: throw ScrobbleException("Last.fm sent no session", retry = false)
        return key to s["name"]?.jsonPrimitive?.contentOrNull.orEmpty()
    }

    suspend fun nowPlaying(sk: String, info: TrackInfo) {
        call("track.updateNowPlaying", lastfmTrackParams(info, null) + ("sk" to sk), true)
    }

    suspend fun scrobble(sk: String, info: TrackInfo, timestamp: Long) {
        call("track.scrobble", lastfmTrackParams(info, timestamp) + ("sk" to sk), true)
    }
}
