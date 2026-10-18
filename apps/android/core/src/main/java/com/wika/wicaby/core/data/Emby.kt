package com.wika.wicaby.core.data

import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.player.resumeFrom
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.JsonNamingStrategy
import com.wika.wicaby.core.net.ServerTransport
import com.wika.wicaby.core.net.await
import com.wika.wicaby.core.net.origin
import com.wika.wicaby.core.net.probeDispatcher
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.ByteString.Companion.encodeUtf8
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

// Emby and Jellyfin speak PascalCase JSON; Kotlin stays camelCase.
@OptIn(ExperimentalSerializationApi::class)
val json = Json {
    ignoreUnknownKeys = true
    // Emby sends some ids as numbers where Jellyfin sends strings (Studios[].Id): read either.
    isLenient = true
    explicitNulls = false
    coerceInputValues = true
    namingStrategy = JsonNamingStrategy { _, _, name -> name.replaceFirstChar { it.uppercaseChar() } }
}

const val TICKS_PER_MS = 10_000L

// The desktop's SUPPORTED_COMMANDS minus what Android cannot honour (fullscreen, settings, content, queueing).
val REMOTE_COMMANDS = listOf(
    "DisplayMessage", "SetVolume", "VolumeUp", "VolumeDown", "ToggleMute", "Mute", "Unmute",
    "SetAudioStreamIndex", "SetSubtitleStreamIndex", "GoHome", "Play", "Playstate",
)
const val LIST_FIELDS = "PrimaryImageAspectRatio,ProductionYear,ChildCount,RecursiveItemCount,OfficialRating,CommunityRating,Overview,Genres,ProviderIds,DateCreated,Etag"
// RemoteTrailers / LocalTrailerCount feed the "Bande-annonce" button (both servers know them).
// Trickplay: Jellyfin 10.9+ scrub tiles (Emby ignores the field and serves index.bif instead).
const val DETAIL_FIELDS = "$LIST_FIELDS,Taglines,MediaSources,MediaStreams,People,Studios,Chapters,RemoteTrailers,LocalTrailerCount,Trickplay"

@Serializable
data class Server(val id: String, val name: String, val address: String, val kind: String) {
    val isEmby get() = kind == "emby"
    // A file source (core/files): a folder, a WebDAV folder or an SMB share answered by FilesApi, never Jellyfin.
    val isFiles get() = kind == "files"

    // Plain HTTP: the token and the password travel in clear (UI text: R.string.server_insecure).
    // probe() only settles on it when no HTTPS address answered.
    val insecure get() = address.startsWith("http://", ignoreCase = true)

    // "scheme://host:port", as net.origin() writes it; null for an unparsable address.
    val origin: String? get() = address.toHttpUrlOrNull()?.let { com.wika.wicaby.core.net.origin(it) }
}

@Serializable
data class UserData(
    val playbackPositionTicks: Long = 0,
    val playedPercentage: Double? = null,
    val played: Boolean = false,
    val isFavorite: Boolean = false,
    val unplayedItemCount: Int? = null,
    val lastPlayedDate: String? = null,
)

@Serializable
data class MediaStream(
    val index: Int = 0,
    val type: String = "",
    val codec: String? = null,
    val profile: String? = null,
    val language: String? = null,
    val displayTitle: String? = null,
    val title: String? = null,
    val isDefault: Boolean = false,
    val isForced: Boolean = false,
    val isExternal: Boolean = false,
    val deliveryMethod: String? = null,
    val deliveryUrl: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val channels: Int? = null,
    val videoRange: String? = null,
    val videoRangeType: String? = null,
    val extendedVideoType: String? = null,
    // Emby: "DoviProfile81"…, and its human text ("Profile 8.1 (HDR10 compatible)").
    val extendedVideoSubType: String? = null,
    val extendedVideoSubTypeDescription: String? = null,
    val colorTransfer: String? = null,
    // Jellyfin Dolby Vision configuration record.
    val dvProfile: Int? = null,
    val dvVersionMajor: Int? = null,
    val dvBlSignalCompatibilityId: Int? = null,
    val realFrameRate: Float? = null,
    val bitDepth: Int? = null,
    val averageFrameRate: Float? = null,
    // External subtitles: the file next to the media (X-03 finds a downloaded one by it).
    val path: String? = null,
)

// Emby keeps intro/credits markers in Chapters (MarkerType); Jellyfin has none there.
@Serializable
data class Chapter(val startPositionTicks: Long = 0, val name: String? = null, val markerType: String? = null, val imageTag: String? = null) {
    // A real chapter, not an Emby IntroStart/IntroEnd/CreditsStart marker.
    val isChapter get() = markerType == null || markerType == "Chapter"
}

@Serializable
data class MediaSegment(val type: String = "", val startTicks: Long = 0, val endTicks: Long = 0)

@Serializable
data class MediaSegmentsResult(val items: List<MediaSegment> = emptyList())

@Serializable
data class MediaSource(
    val id: String = "",
    val name: String? = null,
    val container: String? = null,
    val supportsDirectPlay: Boolean = false,
    val supportsDirectStream: Boolean = false,
    val supportsTranscoding: Boolean = false,
    val transcodingUrl: String? = null,
    val transcodingSubProtocol: String? = null,
    val mediaStreams: List<MediaStream> = emptyList(),
    val defaultAudioStreamIndex: Int? = null,
    val defaultSubtitleStreamIndex: Int? = null,
    val runTimeTicks: Long? = null,
    val size: Long? = null,
    val path: String? = null,
    // Total bit/s of the file (X-02: the Quality sheet hides presets that would not lower it).
    val bitrate: Int? = null,
)

// A trailer hosted elsewhere, usually YouTube (Item.RemoteTrailers).
@Serializable
data class MediaUrl(val url: String = "", val name: String? = null)

@Serializable
data class Person(val id: String = "", val name: String = "", val role: String? = null, val type: String? = null, val primaryImageTag: String? = null)

@Serializable
data class Item(
    val id: String,
    val name: String = "",
    val type: String = "",
    val collectionType: String? = null,
    val isFolder: Boolean = false,
    val mediaType: String? = null,
    val productionYear: Int? = null,
    val officialRating: String? = null,
    val communityRating: Double? = null,
    val runTimeTicks: Long? = null,
    val overview: String? = null,
    val genres: List<String> = emptyList(),
    val taglines: List<String> = emptyList(),
    val imageTags: Map<String, String?> = emptyMap(),
    val backdropImageTags: List<String> = emptyList(),
    val parentBackdropItemId: String? = null,
    val parentBackdropImageTags: List<String> = emptyList(),
    val parentLogoItemId: String? = null,
    val parentLogoImageTag: String? = null,
    val parentThumbItemId: String? = null,
    val parentThumbImageTag: String? = null,
    val seriesId: String? = null,
    val seriesName: String? = null,
    val seriesPrimaryImageTag: String? = null,
    val seasonId: String? = null,
    val indexNumber: Int? = null,
    val parentIndexNumber: Int? = null,
    // Specials (Fields=SpecialEpisodeNumbers): the season they aired in, which the server interleaves them by.
    val airsBeforeSeasonNumber: Int? = null,
    val airsAfterSeasonNumber: Int? = null,
    val userData: UserData? = null,
    val mediaSources: List<MediaSource> = emptyList(),
    val chapters: List<Chapter> = emptyList(),
    val people: List<Person> = emptyList(),
    val studios: List<NameId> = emptyList(),
    val childCount: Int? = null,
    val recursiveItemCount: Int? = null,
    val primaryImageAspectRatio: Double? = null,
    // Books: the comic reader picks CBZ from these (Fields=Path).
    val path: String? = null,
    val container: String? = null,
    val localTrailerCount: Int? = null,
    val remoteTrailers: List<MediaUrl> = emptyList(),
    // Imdb, Tmdb, Tvdb… (Fields=ProviderIds): the same title across servers.
    val providerIds: Map<String, String?> = emptyMap(),
    val premiereDate: String? = null,
    val dateCreated: String? = null,
    // Fields=Etag (LIST_FIELDS): with dateCreated, the version that keys generated comic covers.
    val etag: String? = null,
    // Jellyfin 10.9+ trickplay manifest, kept raw: {mediaSourceId: {width: info}} or {width: info} (Trickplay.kt).
    val trickplay: JsonObject? = null,
    // TP-06: the server the item comes from (both servers send it; Servers.fanOut fills it when missing).
    val serverId: String? = null,
    // TP-07: a Live TV channel's programme airing now (/LiveTv/Channels?AddCurrentProgram=true).
    val currentProgram: Item? = null,
    // Music (both servers send these on tracks and albums by default).
    val album: String? = null,
    val albumId: String? = null,
    val albumPrimaryImageTag: String? = null,
    val albumArtist: String? = null,
    val artists: List<String> = emptyList(),
    // Music spec MU-01 (§3.1): who the album is filed under and who is credited on the track.
    val albumArtists: List<NameId> = emptyList(),
    val artistItems: List<NameId> = emptyList(),
    // Jellyfin 10.9+ only: loudness gain in dB (−18 LUFS reference) and whether /Audio/{id}/Lyrics has lyrics.
    val normalizationGain: Double? = null,
    val hasLyrics: Boolean? = null,
    // Fields=MediaStreams: Emby's lyrics are an lrc subtitle stream of the audio item (unverified, spec §3.5).
    val mediaStreams: List<MediaStream> = emptyList(),
    // Photos (photos spec §3.1): size and EXIF, same names on both servers. Aperture and ShutterSpeed may be APEX values.
    val width: Int? = null,
    val height: Int? = null,
    val cameraMake: String? = null,
    val cameraModel: String? = null,
    val software: String? = null,
    val exposureTime: Double? = null,
    val focalLength: Double? = null,
    val aperture: Double? = null,
    val shutterSpeed: Double? = null,
    val isoSpeedRating: Int? = null,
    val latitude: Double? = null,
    val longitude: Double? = null,
    val altitude: Double? = null,
    val imageOrientation: String? = null,
    // Jellyfin only: {imageType: {tag: hash}}.
    val imageBlurHashes: Map<String, Map<String, String>>? = null,
) {
    val isEpisode get() = type == "Episode"
    // A music track: no picture of its own, the player shows its album art.
    val isAudio get() = type == "Audio" || (mediaType == "Audio" && !isFolder)
    val artistLine get() = artists.joinToString(", ").ifEmpty { albumArtist.orEmpty() }
    val isSeries get() = type == "Series"
    // Outside 5–90 % a resume point is noise (Emby libraries can change the server's own rule).
    val resumeMs get() = resumeFrom((userData?.playbackPositionTicks ?: 0) / TICKS_PER_MS, (runTimeTicks ?: 0) / TICKS_PER_MS)
    val progress: Float?
        get() {
            val total = runTimeTicks ?: return null
            val pos = userData?.playbackPositionTicks ?: 0
            return if (pos > 0 && total > 0) (pos.toFloat() / total).coerceIn(0f, 1f) else null
        }
}

@Serializable
data class NameId(val name: String = "", val id: String? = null)

@Serializable
data class ItemsResult(val items: List<Item> = emptyList(), val totalRecordCount: Int = 0)

// policy: AuthenticateByName and /Users/{id} send it (TP-11 access schedules); /Users/Public does not.
@Serializable
data class User(val id: String, val name: String = "", val hasPassword: Boolean = true, val primaryImageTag: String? = null, val policy: JsonObject? = null)

@Serializable
data class AuthResult(val accessToken: String, val user: User) {
    override fun toString() = "AuthResult(accessToken=<redacted>, user=$user)"
}

@Serializable
data class SystemInfo(val id: String = "", val serverName: String? = null, val version: String? = null, val productName: String? = null)

// X-03: Emby and Jellyfin RemoteSubtitleInfo (common fields plus each server's flags).
@Serializable
data class RemoteSubtitle(
    val id: String = "",
    val providerName: String? = null,
    val name: String? = null,
    val format: String? = null,
    val communityRating: Float? = null,
    val downloadCount: Int? = null,
    val isHashMatch: Boolean = false,
    val isForced: Boolean? = null, // Emby
    val forced: Boolean? = null, // Jellyfin
    val isHearingImpaired: Boolean? = null,
    val hearingImpaired: Boolean? = null, // Jellyfin
    val aiTranslated: Boolean? = null, // Jellyfin
    val machineTranslated: Boolean? = null, // Jellyfin
    val threeLetterISOLanguageName: String? = null,
) {
    val forcedFlag get() = (isForced ?: forced) == true
    val sdhFlag get() = (hearingImpaired ?: isHearingImpaired) == true
    val machineFlag get() = aiTranslated == true || machineTranslated == true
}

// X-03 rules, the same as the desktop's shared/subtitles.ts (vectors: tools/checks/fixtures/subtitles).
object SubtitleRules {
    enum class Failure { NO_PROVIDER, FORBIDDEN, FAILED }

    // 404 = no provider plugin on the server; 401/403 = the account lacks the right.
    fun failure(e: Throwable): Failure = when ((e as? ApiException)?.status) {
        404 -> Failure.NO_PROVIDER
        401, 403 -> Failure.FORBIDDEN
        else -> Failure.FAILED
    }

    // The last language searched, then the preferred subtitle language, then the UI's, then English.
    fun language(last: String?, preferred: String?, ui: String?): String =
        last?.takeIf { it.isNotEmpty() } ?: preferred?.takeIf { it.isNotEmpty() } ?: if (ui?.startsWith("fr") == true) "fre" else "eng"

    // Emby EnableSubtitleDownloading, Jellyfin EnableSubtitleManagement; admins always. false only when known.
    fun canDownload(policy: JsonObject?, jellyfin: Boolean): Boolean {
        if (policy == null || (policy["IsAdministrator"] as? JsonPrimitive)?.booleanOrNull == true) return true
        return (policy[if (jellyfin) "EnableSubtitleManagement" else "EnableSubtitleDownloading"] as? JsonPrimitive)?.booleanOrNull != false
    }

    // The external subtitle a download added: one not in the previous set (by path, indexes can shift),
    // else the highest index when the count grew. null when nothing was added yet.
    fun added(before: List<MediaStream>, after: List<MediaStream>): MediaStream? {
        val oldSubs = before.filter { it.type == "Subtitle" }
        val newSubs = after.filter { it.type == "Subtitle" }
        val ext = newSubs.filter { it.isExternal }
        val seen = oldSubs.map { it.path ?: "#${it.index}" }.toSet()
        ext.filter { (it.path ?: "#${it.index}") !in seen }.maxByOrNull { it.index }?.let { return it }
        return if (newSubs.size > oldSubs.size) ext.maxByOrNull { it.index } else null
    }
}

@Serializable
data class PlaybackInfo(val mediaSources: List<MediaSource> = emptyList(), val playSessionId: String? = null, val errorCode: String? = null)

@Serializable
data class PlayState(
    val positionTicks: Long = 0,
    val isPaused: Boolean = false,
    val isMuted: Boolean = false,
    val volumeLevel: Int? = null,
    val mediaSourceId: String? = null,
    val audioStreamIndex: Int? = null,
    val subtitleStreamIndex: Int? = null,
)

// Another client on the server, as /Sessions lists it (remote control, cast/RemoteTargets).
@Serializable
data class SessionInfo(
    val id: String,
    val deviceId: String? = null,
    val deviceName: String = "",
    val client: String = "",
    val supportsRemoteControl: Boolean = false,
    val playableMediaTypes: List<String> = emptyList(),
    val supportedCommands: List<String> = emptyList(),
    val nowPlayingItem: Item? = null,
    val nowPlayingQueue: List<JsonObject> = emptyList(),
    val playState: PlayState? = null,
)

@Serializable
private data class Login(val username: String, val pw: String)

open class ApiException(message: String, val status: Int) : IOException(message)

// B29: the episode after [ep] in the server's order ([list], as /Shows/{id}/Episodes lists it from [ep] on).
// A special (season 0) follows only where the server placed it by air date (DisplaySpecialsWithinSeasons: it
// carries its aired season), or after another special; otherwise it is skipped.
fun nextInOrder(list: List<Item>, ep: Item): Item? {
    val i = list.indexOfFirst { it.id == ep.id }
    if (i < 0) return null
    return list.drop(i + 1).firstOrNull {
        it.parentIndexNumber != 0 || ep.parentIndexNumber == 0 || it.airsBeforeSeasonNumber != null || it.airsAfterSeasonNumber != null
    }
}

// "Marquer les précédents comme vus": the episodes before [ep] in the series order ([all], as
// episodes(seriesId) lists them). Specials (season 0) only when [ep] is one, as on desktop.
fun previousEpisodes(all: List<Item>, ep: Item): List<Item> {
    val i = all.indexOfFirst { it.id == ep.id }
    return if (i < 0) emptyList() else all.take(i).filter { it.parentIndexNumber != 0 || ep.parentIndexNumber == 0 }
}

// open: a non-Emby source (core/files FilesApi, Plex later) answers the same calls through its own route table.
open class Api(val server: Server, val deviceId: String, val token: String? = null, val userId: String? = null) {
    private val http = Core.http
    val prefix = if (server.isEmby) "/emby" else ""
    val base = server.address + prefix
    // PremiereDate is not an ItemFields value on Jellyfin (it always sends it): named for Emby only (X-01).
    val listFields = if (server.isEmby) "$LIST_FIELDS,PremiereDate" else LIST_FIELDS
    // Music tracks: their MediaSources too, whose id the audio stream names (an Emby source id is not the item id).
    val trackFields get() = "$listFields,MediaSources"

    private fun q(v: String) = "\"" + URLEncoder.encode(v, "UTF-8") + "\""

    open fun authHeaders(): Map<String, String> {
        val parts = mutableListOf("Client=${q("Wicaby")}", "Device=${q(Core.deviceName)}", "DeviceId=${q(deviceId)}", "Version=${q(Core.version)}")
        return if (server.isEmby) {
            if (userId != null) parts.add(0, "UserId=${q(userId)}")
            buildMap {
                put("X-Emby-Authorization", "Emby " + parts.joinToString(", "))
                token?.let { put("X-Emby-Token", it) }
            }
        } else {
            token?.let { parts += "Token=${q(it)}" }
            mapOf("Authorization" to "MediaBrowser " + parts.joinToString(", "))
        }
    }

    open fun url(path: String, vararg query: Pair<String, Any?>): String {
        val b = (base + path).toHttpUrl().newBuilder()
        for ((k, v) in query) if (v != null && v != "") b.addQueryParameter(k, v.toString())
        return b.build().toString()
    }

    // Server URLs (TranscodingUrl, DeliveryUrl) are relative to the API base, prefix included.
    // An absolute one on another host loses any api_key/ApiKey: the token stays with the server.
    open fun resolve(u: String): String {
        if (u.startsWith("http://", true) || u.startsWith("https://", true)) return stripForeignKey(u, server.origin)
        val rel = if (u.startsWith("/")) u else "/$u"
        return if (prefix.isNotEmpty() && rel.lowercase().startsWith("$prefix/")) server.address + rel else base + rel
    }

    open suspend fun raw(method: String, path: String, body: String? = null, vararg query: Pair<String, Any?>): String =
        stream(method, path, body, query.asList()) { it.body.string() }

    // One call with the open response handed to [read] (Live TV decodes guide answers from the byte
    // stream and reads the Date header). [timeoutMs] > 0 bounds the whole call. Non-2xx: ApiException.
    open suspend fun <T> stream(method: String, path: String, body: String?, query: List<Pair<String, Any?>>, timeoutMs: Long = 0, read: (Response) -> T): T = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(url(path, *query.toTypedArray())).header("Accept", "application/json")
        authHeaders().forEach { (k, v) -> req.header(k, v) }
        val rb = body?.toRequestBody("application/json".toMediaType()) ?: if (method == "POST") ByteArray(0).toRequestBody() else null
        req.method(method, rb)
        val call = http.newCall(req.build())
        if (timeoutMs > 0) call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
        call.execute().use { res ->
            if (!res.isSuccessful) throw ApiException(res.body.string().take(200).ifBlank { "HTTP ${res.code}" }, res.code)
            read(res)
        }
    }

    suspend inline fun <reified T> get(path: String, vararg query: Pair<String, Any?>): T = json.decodeFromString(raw("GET", path, null, *query))

    suspend inline fun <reified T> post(path: String, body: String?, vararg query: Pair<String, Any?>): T = json.decodeFromString(raw("POST", path, body, *query))

    open fun image(id: String, type: String, tag: String?, maxWidth: Int? = null, maxHeight: Int? = null) =
        url("/Items/$id/Images/$type", "tag" to tag, "maxWidth" to maxWidth, "maxHeight" to maxHeight, "quality" to 90)

    // Endpoints the app uses.
    suspend fun publicUsers(): List<User> = get("/Users/Public")

    suspend fun login(name: String, pw: String): AuthResult =
        post("/Users/AuthenticateByName", json.encodeToString(Login.serializer(), Login(name, pw)))

    // Jellyfin 10.9 moved these to /UserViews and /UserItems/Resume (?userId=); the per-user routes are obsolete.
    // A music library's album artists (both servers: /Artists/AlbumArtists, a plain item query).
    suspend fun albumArtists(vararg query: Pair<String, Any?>): ItemsResult =
        get("/Artists/AlbumArtists", "UserId" to userId, "Fields" to listFields, "EnableImageTypes" to "Primary", "ImageTypeLimit" to 1, *query)

    suspend fun views(): List<Item> =
        if (server.isEmby) get<ItemsResult>("/Users/$userId/Views").items
        else jellyfinOrLegacy({ get<ItemsResult>("/UserViews", "userId" to userId) }) { get("/Users/$userId/Views") }.items

    suspend fun resume(): List<Item> {
        val query = arrayOf<Pair<String, Any?>>(
            "Limit" to 24, "MediaTypes" to "Video", "Fields" to listFields, "EnableImageTypes" to "Primary,Backdrop,Thumb,Logo", "ImageTypeLimit" to 1,
        )
        return if (server.isEmby) get<ItemsResult>("/Users/$userId/Items/Resume", *query).items
        else jellyfinOrLegacy({ get<ItemsResult>("/UserItems/Resume", "userId" to userId, *query) }) { get("/Users/$userId/Items/Resume", *query) }.items
    }

    suspend fun nextUp(seriesId: String? = null, limit: Int = 24): List<Item> = get<ItemsResult>(
        "/Shows/NextUp", "UserId" to userId, "SeriesId" to seriesId, "Limit" to limit, "Fields" to listFields,
        "EnableImageTypes" to "Primary,Backdrop,Thumb,Logo", "ImageTypeLimit" to 1,
    ).items

    // TP-07: Home's "Live TV" row, desktop live.channels(24): channels with the programme airing now.
    suspend fun liveChannels(limit: Int = 24): List<Item> = get<ItemsResult>(
        "/LiveTv/Channels", "UserId" to userId, "AddCurrentProgram" to true, "EnableFavoriteSorting" to true, "Limit" to limit,
        "Fields" to "PrimaryImageAspectRatio", "EnableImageTypes" to "Primary,Thumb,Backdrop", "ImageTypeLimit" to 1,
    ).items

    // Episodes airing soon, soonest first (the same route and query on Emby and Jellyfin).
    suspend fun upcoming(limit: Int = 24): List<Item> = get<ItemsResult>(
        "/Shows/Upcoming", "UserId" to userId, "Limit" to limit, "Fields" to listFields,
        "EnableImageTypes" to "Primary,Backdrop,Thumb,Logo", "ImageTypeLimit" to 1,
    ).items.sortedBy { it.premiereDate ?: "" }

    // No parentId: every library (the launcher's "Recently Added" channel). Jellyfin 10.9 moved the
    // route to /Items/Latest?userId= (the per-user one is obsolete); older Jellyfin only has the old one.
    suspend fun latest(parentId: String? = null): List<Item> {
        val query = arrayOf<Pair<String, Any?>>(
            "ParentId" to parentId, "Limit" to 24, "Fields" to listFields,
            "EnableImageTypes" to "Primary,Backdrop,Thumb,Logo", "ImageTypeLimit" to 1,
        )
        if (server.isEmby) return get("/Users/$userId/Items/Latest", *query)
        return runCatching { get<List<Item>>("/Items/Latest", "userId" to userId, *query) }
            .getOrElse { get("/Users/$userId/Items/Latest", *query) }
    }

    // Jellyfin has always taken /Items?userId= (the per-user route is obsolete since 10.9). A "Fields" in [query]
    // replaces the list fields.
    // A default the query names is left out (desktop's object spread): Emby 4.10 joins a repeated name, so ImageTypeLimit
    // twice reads "1,1" and the call answers 500 (every music cover lookup of 0.10.4).
    suspend fun items(vararg query: Pair<String, Any?>): ItemsResult {
        val named = query.map { it.first.lowercase() }.toSet()
        val defaults = listOf("Fields" to listFields, "EnableImageTypes" to "Primary,Backdrop,Thumb,Logo", "ImageTypeLimit" to 1).filter { it.first.lowercase() !in named }
        return get(if (server.isEmby) "/Users/$userId/Items" else "/Items", "userId" to userId.takeUnless { server.isEmby }, *defaults.toTypedArray(), *query)
    }

    // Jellyfin 10.9 moved it to /Items/{id}?userId= (the per-user route is obsolete); older Jellyfin only has the old one.
    suspend fun item(id: String): Item =
        if (server.isEmby) get("/Users/$userId/Items/$id", "Fields" to DETAIL_FIELDS)
        else jellyfinOrLegacy({ get("/Items/$id", "userId" to userId, "Fields" to DETAIL_FIELDS) }) { get("/Users/$userId/Items/$id", "Fields" to DETAIL_FIELDS) }

    suspend fun seasons(seriesId: String): List<Item> =
        get<ItemsResult>("/Shows/$seriesId/Seasons", "UserId" to userId, "Fields" to listFields).items

    // No [seasonId]: every episode of the series, in order (specials included).
    suspend fun episodes(seriesId: String, seasonId: String? = null): List<Item> =
        get<ItemsResult>("/Shows/$seriesId/Episodes", "UserId" to userId, "SeasonId" to seasonId, "Fields" to listFields).items

    // The episode after this one, across seasons; missing (virtual) episodes skipped, specials as nextInOrder says.
    // Limit 8: room for a few skipped specials.
    suspend fun nextEpisode(ep: Item): Item? {
        val series = ep.seriesId ?: return null
        val list = get<ItemsResult>(
            "/Shows/$series/Episodes", "UserId" to userId, "StartItemId" to ep.id, "Limit" to 8, "IsMissing" to false,
            "Fields" to "$listFields,SpecialEpisodeNumbers", "EnableImageTypes" to "Primary,Backdrop,Thumb", "ImageTypeLimit" to 1,
        ).items
        return nextInOrder(list, ep)
    }

    // Jellyfin 10.10+ media segments (Intro Skipper, chapter providers): intro/outro plus the
    // recap, preview and commercial ranges player/Segments.kt skips. Emby has no such route.
    suspend fun mediaSegments(id: String): List<MediaSegment> = get<MediaSegmentsResult>(
        "/MediaSegments/$id", *listOf("Intro", "Outro", "Recap", "Preview", "Commercial").map { "includeSegmentTypes" to it }.toTypedArray(),
    ).items

    // Trailer files stored with the film. Jellyfin 10.9 moved the route; the old one is the fallback.
    suspend fun localTrailers(id: String): List<Item> =
        if (server.isEmby) get("/Users/$userId/Items/$id/LocalTrailers", "Fields" to DETAIL_FIELDS)
        else runCatching { get<List<Item>>("/Items/$id/LocalTrailers", "userId" to userId) }
            .getOrElse { get("/Users/$userId/Items/$id/LocalTrailers") }

    // Bonus videos stored with a film or a show (making-of, deleted scenes, interviews), the same
    // route shape as localTrailers (Jellyfin 10.9 moved it). Empty when the server has none or
    // answers the route with an HTTP error; network failures still throw.
    suspend fun specialFeatures(id: String): List<Item> = try {
        if (server.isEmby) get<List<Item>>("/Users/$userId/Items/$id/SpecialFeatures")
        else runCatching { get<List<Item>>("/Items/$id/SpecialFeatures", "userId" to userId) }
            .getOrElse { get("/Users/$userId/Items/$id/SpecialFeatures") }
    } catch (_: ApiException) {
        emptyList()
    }

    suspend fun similar(id: String, limit: Int = 16): List<Item> =
        get<ItemsResult>("/Items/$id/Similar", "UserId" to userId, "Limit" to limit, "Fields" to listFields).items

    fun personImage(p: Person, maxHeight: Int): String? = p.primaryImageTag?.let { image(p.id, "Primary", it, maxHeight = maxHeight) }

    // Jellyfin 10.9 moved user avatars to /UserImage?userId= (desktop images.ts userImageUrl).
    fun userImage(u: User, maxHeight: Int): String? = u.primaryImageTag?.let {
        if (server.isEmby) url("/Users/${u.id}/Images/Primary", "tag" to it, "maxHeight" to maxHeight, "quality" to 90)
        else url("/UserImage", "userId" to u.id, "tag" to it, "maxHeight" to maxHeight, "quality" to 90)
    }

    // The original file, as stored on the server (needs the user's download permission). With several
    // versions: Emby takes the MediaSourceId; on Jellyfin each version is its own item, so its id is the path.
    fun downloadUrl(id: String, mediaSourceId: String? = null): String {
        val ms = mediaSourceId?.takeIf { it.isNotBlank() && it != id }
        // No api_key in the URL: callers send authHeaders() (ServerAuthInterceptor adds them for the active server).
        return if (server.isEmby) url("/Items/$id/Download", "MediaSourceId" to ms)
        else url("/Items/${ms ?: id}/Download")
    }

    // Emby's scrub thumbnails in one Roku BIF file (see Trickplay.kt).
    fun bifUrl(id: String, width: Int = 320): String = url("/Videos/$id/index.bif", "Width" to width)

    // Jellyfin's scrub thumbnails: one JPEG sheet of tiles per [sheet] (see Trickplay.kt).
    fun trickplayUrl(id: String, width: Int, sheet: Int, mediaSourceId: String?): String =
        url("/Videos/$id/Trickplay/$width/$sheet.jpg", "MediaSourceId" to mediaSourceId)

    // A chapter's still, [index] in the item's full Chapters list (Emby markers included).
    fun chapterImage(id: String, index: Int, tag: String?, maxWidth: Int = 320): String = image(id, "Chapter/$index", tag, maxWidth)

    // Makes this session a remote-control target ("Play on"). Posted before every socket connect: Emby only
    // routes commands and LibraryChanged to a session whose capabilities arrived first (X-01).
    suspend fun capabilities(mediaControl: Boolean) {
        val body = buildJsonObject {
            putJsonArray("PlayableMediaTypes") { add("Audio"); add("Video") }
            // Off: messages only (a notification, not control; the desktop lists them too).
            putJsonArray("SupportedCommands") { (if (mediaControl) REMOTE_COMMANDS else listOf("DisplayMessage")).forEach { add(it) } }
            put("SupportsMediaControl", mediaControl)
            put("SupportsPersistentIdentifier", true)
        }
        raw("POST", "/Sessions/Capabilities/Full", body.toString())
    }

    // The realtime channel: Emby /embywebsocket?api_key=, Jellyfin /socket?ApiKey= (12 refuses api_key). Never logged.
    // At the server root on both (no /emby prefix).
    fun socketUrl(): String = (server.address + if (server.isEmby) "/embywebsocket" else "/socket").toHttpUrl().newBuilder()
        .addQueryParameter(if (server.isEmby) "api_key" else "ApiKey", token.orEmpty())
        .addQueryParameter("deviceId", deviceId)
        .build().toString().replaceFirst(Regex("^http", RegexOption.IGNORE_CASE), "ws")

    // Writes a watch state recorded offline. Emby and Jellyfin < 10.9 use the user route,
    // newer Jellyfin the /UserItems one (the old route is only kept as obsolete).
    suspend fun updateUserData(id: String, positionTicks: Long, played: Boolean, lastPlayedIso: String) {
        val body = """{"PlaybackPositionTicks":$positionTicks,"Played":$played,"LastPlayedDate":"$lastPlayedIso"}"""
        if (server.isEmby) raw("POST", "/Users/$userId/Items/$id/UserData", body)
        else raw("POST", "/UserItems/$id/UserData", body, "userId" to userId)
    }

    // Series last played, for the Continue Watching order (X-01): one call for up to 24 series; null dates left out.
    suspend fun seriesUserData(ids: Collection<String>): Map<String, String> = if (ids.isEmpty()) emptyMap() else
        get<ItemsResult>("/Users/$userId/Items", "Ids" to ids.take(24).joinToString(","), "Fields" to "UserData", "EnableImages" to false)
            .items.mapNotNull { i -> i.userData?.lastPlayedDate?.let { i.id to it } }.toMap()

    // "Retirer de Continuer à regarder": Emby only (Jellyfin has no equivalent; a 404 means unsupported).
    suspend fun hideFromResume(id: String, hide: Boolean) {
        raw("POST", "/Users/$userId/Items/$id/HideFromResume", null, "Hide" to hide)
    }

    suspend fun setFavorite(id: String, on: Boolean) {
        raw(if (on) "POST" else "DELETE", "/Users/$userId/FavoriteItems/$id")
    }

    // Jellyfin 10.9 moved it to /UserPlayedItems (the per-user route is obsolete); older Jellyfin only has the old one.
    suspend fun setPlayed(id: String, on: Boolean) {
        val method = if (on) "POST" else "DELETE"
        if (server.isEmby) raw(method, "/Users/$userId/PlayedItems/$id")
        else jellyfinOrLegacy({ raw(method, "/UserPlayedItems/$id", null, "userId" to userId) }) { raw(method, "/Users/$userId/PlayedItems/$id") }
    }

    // "Saison vue", "Marquer les précédents comme vus": one call per item not already in that state.
    // Returns how many changed; stops at the first failure. progress(done, total) after each call.
    suspend fun markPlayed(items: List<Item>, on: Boolean, progress: (Int, Int) -> Unit = { _, _ -> }): Int {
        val todo = items.filter { (it.userData?.played == true) != on }
        progress(0, todo.size)
        todo.forEachIndexed { i, it ->
            setPlayed(it.id, on)
            progress(i + 1, todo.size)
        }
        return todo.size
    }

    // The modern Jellyfin route, then the obsolete one only when the server does not know the new one:
    // 404, or 405 when the path exists for other methods (10.8 routes DELETE/POST /Items/{id}, not GET).
    private suspend fun <T> jellyfinOrLegacy(modern: suspend () -> T, legacy: suspend () -> T): T = try {
        modern()
    } catch (e: ApiException) {
        if (e.status != 404 && e.status != 405) throw e
        legacy()
    }

    // Checks a token handed over by another device (TV pairing): 401 when it is not valid. Jellyfin
    // serves /Users/{id} for any user to any token, so ask it whose token this is (/Users/Me). Emby
    // has no /Users/Me: there a token allowed to read other users (an admin's) could name another
    // user, who is then shown with the token's own rights, no more.
    suspend fun user(id: String): User = get(if (server.isEmby) "/Users/$id" else "/Users/Me")

    // X-03 remote subtitles. MediaSourceId is sent but is not a declared parameter on either server.
    suspend fun searchSubtitles(id: String, lang: String, sourceId: String?): List<RemoteSubtitle> =
        get("/Items/$id/RemoteSearch/Subtitles/${URLEncoder.encode(lang, "UTF-8")}", "MediaSourceId" to sourceId)

    suspend fun downloadSubtitle(id: String, subId: String, sourceId: String?) {
        raw("POST", "/Items/$id/RemoteSearch/Subtitles/${URLEncoder.encode(subId, "UTF-8")}", null, "MediaSourceId" to sourceId)
    }

    // The user's subtitle language preference and whether the policy allows downloads (one /Users/{id}).
    suspend fun subtitleUser(): Pair<String?, Boolean> {
        val u = get<JsonObject>("/Users/$userId")
        val lang = (u["Configuration"] as? JsonObject)?.get("SubtitleLanguagePreference")?.let { (it as? JsonPrimitive)?.contentOrNull }
        return lang to SubtitleRules.canDownload(u["Policy"] as? JsonObject, jellyfin = !server.isEmby)
    }

    companion object {
        // The one way to build a client for a stored session: a file source's id gives its FilesApi (core/files).
        // A plex server's is its PlexApi (core/plex), with what its account says (owner, remote, watchlist).
        @Volatile
        var forKind: (Server, String, String?, String?) -> Api? = { _, _, _, _ -> null }

        fun of(server: Server, deviceId: String, token: String? = null, userId: String? = null): Api =
            forKind(server, deviceId, token, userId)
                ?: when (server.kind) {
                    "plex" -> com.wika.wicaby.core.plex.Plex.api(server, deviceId, token, userId)
                    // token: the password (Subsonic token+salt needs it), userId: the user name.
                    "navidrome" -> com.wika.wicaby.core.subsonic.SubsonicApi(server, deviceId, token, userId)
                    else -> Api(server, deviceId, token, userId)
                }

        fun candidates(input: String): List<String> {
            var raw = input.trim().trimEnd('/')
            if (raw.isEmpty()) return emptyList()
            if (raw.startsWith("http://", true) || raw.startsWith("https://", true)) return listOf(raw)
            raw = raw.trimStart('/')
            val host = raw.substringBefore('/')
            if (Regex(":\\d+$").containsMatchIn(host)) return listOf("https://$raw", "http://$raw")
            val tail = raw.substringAfter('/', "").let { if (it.isEmpty()) "" else "/$it" }
            // 8920 / 8096: the Emby and Jellyfin default HTTPS / HTTP ports.
            return listOf("https://$raw", "https://$host:8920$tail", "http://$host:8096$tail", "http://$raw")
        }

        // [timeoutMs]: per request; MeshServers probes peers with a shorter one.
        internal suspend fun probeOne(address: String, timeoutMs: Long = 6000): Server = withContext(Dispatchers.IO) {
            val client = Core.http.newBuilder().dispatcher(probeDispatcher).callTimeout(timeoutMs, TimeUnit.MILLISECONDS).build()
            var answered = false
            for (prefix in listOf("/emby", "")) {
                val req = Request.Builder().url("$address$prefix/System/Info/Public").header("Accept", "application/json").build()
                // No HTTP answer at all (refused, dropped, TLS failure): the root path won't do better,
                // so a host that silently drops the port costs one timeout, not two.
                val res = try { client.newCall(req).await() } catch (e: IOException) { break }
                answered = true
                val info = res.use { r -> if (r.isSuccessful) runCatching { json.decodeFromString<SystemInfo>(r.body.string()) }.getOrNull() else null } ?: continue
                if (info.id.isBlank()) continue
                val product = info.productName.orEmpty()
                val kind = when {
                    product.contains("jellyfin", true) -> "jellyfin"
                    prefix == "/emby" || product.contains("emby", true) -> "emby"
                    else -> "jellyfin"
                }
                return@withContext Server(info.id, info.serverName ?: address, address, kind)
            }
            // A Navidrome (or any OpenSubsonic) server: /rest/ping answers a subsonic-response even without auth.
            if (answered) subsonicPing(client, address)?.let { return@withContext it }
            throw IOException(Core.str(R.string.not_a_server))
        }

        // Subsonic has no server id: one derived from the origin (the same address, the same server).
        private suspend fun subsonicPing(client: okhttp3.OkHttpClient, address: String): Server? {
            val req = Request.Builder().url("$address/rest/ping.view?v=1.16.1&c=Wicaby&f=json").header("Accept", "application/json").build()
            val r = runCatching {
                client.newBuilder().followRedirects(false).build().newCall(req).await().use { res ->
                    if (res.isSuccessful) (json.parseToJsonElement(res.body.string()) as? JsonObject)?.get("subsonic-response") as? JsonObject else null
                }
            }.getOrNull() ?: return null
            val type = (r["type"] as? JsonPrimitive)?.contentOrNull?.replaceFirstChar { it.uppercase() } ?: "Subsonic"
            val origin = address.toHttpUrlOrNull()?.let { com.wika.wicaby.core.net.origin(it) } ?: address
            return Server("nd" + origin.encodeUtf8().sha256().hex().take(16), type, address, "navidrome")
        }

        // Races the given addresses and keeps the first that answers; null when none does.
        private suspend fun race(list: List<String>): Server? = if (list.isEmpty()) null else coroutineScope {
            val result = CompletableDeferred<Server?>()
            val jobs = list.map { a -> launch { runCatching { probeOne(a) }.onSuccess { result.complete(it) } } }
            launch {
                jobs.joinAll()
                result.complete(null)
            }
            try {
                result.await()
            } finally {
                coroutineContext.cancelChildren()
            }
        }

        // HTTPS first; plain HTTP only when no HTTPS address answers, and the Server then says
        // so (Server.insecure) for the UI to warn. A faster HTTP answer never wins over HTTPS:
        // both groups are probed at once (only the anonymous /System/Info/Public), so a host that
        // drops 443/8920 costs no extra wait, but the HTTP result is read only once every HTTPS
        // candidate has failed.
        suspend fun probe(input: String): Server = coroutineScope {
            val (secure, plain) = candidates(input).partition { it.startsWith("https://", true) }
            val s = async { race(secure) }
            val p = async { race(plain) }
            s.await()?.also { p.cancel() } ?: p.await() ?: throw IOException(Core.str(R.string.server_unreachable_probe))
        }
    }
}

// Query keys the servers read the access token from (Emby api_key / X-Emby-Token, Jellyfin
// ApiKey / api_key, the old X-MediaBrowser-Token), compared after decoding, any case.
private val KEY_PARAMS = setOf("api_key", "apikey", "x-emby-token", "x-mediabrowser-token")

// Lenient form decoding, as the servers do it: "+" is a space, %XX and %uXXXX are decoded,
// malformed escapes stay as they are. "api%5Fkey" and "ApiKe%79" are both the token key.
internal fun decodeQueryName(raw: String): String {
    val out = java.io.ByteArrayOutputStream()
    fun put(str: String) = out.write(str.toByteArray(Charsets.UTF_8))
    var i = 0
    while (i < raw.length) {
        val c = raw[i]
        when {
            c == '+' -> { out.write(' '.code); i++ }
            c == '%' && i + 6 <= raw.length && (raw[i + 1] == 'u' || raw[i + 1] == 'U') && raw.substring(i + 2, i + 6).all { it.isHex() } -> {
                put(raw.substring(i + 2, i + 6).toInt(16).toChar().toString()); i += 6
            }
            c == '%' && i + 3 <= raw.length && raw[i + 1].isHex() && raw[i + 2].isHex() -> {
                out.write(raw.substring(i + 1, i + 3).toInt(16)); i += 3
            }
            else -> { put(c.toString()); i++ }
        }
    }
    return out.toString(Charsets.UTF_8.name())
}

private fun Char.isHex() = this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'

private fun isKeyParam(rawName: String) = decodeQueryName(rawName).trim().lowercase() in KEY_PARAMS

// An absolute URL on a host other than [serverOrigin] keeps everything but the token. The query
// is rebuilt from its raw pairs: removeAllQueryParameters() re-encodes the name it is given and
// misses an encoded "api%5Fkey" that the server would still decode to api_key.
internal fun stripForeignKey(u: String, serverOrigin: String?): String {
    val url = u.toHttpUrlOrNull() ?: return u
    if (serverOrigin != null && origin(url) == serverOrigin) return u
    val query = url.encodedQuery ?: return u
    val pairs = query.split('&')
    // Some parsers also split on ';': a pair hiding a key behind one is dropped whole.
    val kept = pairs.filterNot { pair -> pair.split(';').any { isKeyParam(it.substringBefore('=')) } }
    if (kept.size == pairs.size) return u
    return url.newBuilder().encodedQuery(kept.joinToString("&").ifEmpty { null }).build().toString()
}

// True when [url] is the server at [serverOrigin], directly or through its mesh forwarder
// (TransportInterceptor rewrites server URLs onto "http://127.0.0.1:<port>/<token>/...").
internal fun isServerUrl(url: HttpUrl, serverOrigin: String, transport: ServerTransport): Boolean {
    if (origin(url) == serverOrigin) return true
    val base = transport.forward(serverOrigin)?.trimEnd('/')?.toHttpUrlOrNull() ?: return false
    if (origin(url) != origin(base)) return false
    val prefix = base.encodedPath.trimEnd('/')
    return prefix.isEmpty() || url.encodedPath == prefix || url.encodedPath.startsWith("$prefix/")
}

private val AUTH_HEADERS = listOf("Authorization", "X-Emby-Authorization", "X-Emby-Token", "X-MediaBrowser-Token", "X-Plex-Token")

// A redirect that only moves a plain-HTTP call to HTTPS on the same host, as Emby's "require
// HTTPS" does (http://h:8096 -> https://h:8920). Whoever could read the token on [from] could
// already read it in clear, so it may follow.
internal fun isHttpsUpgrade(hop: HttpUrl, from: HttpUrl) = hop.isHttps && !from.isHttps && hop.host == from.host

// May a hop of a call that started at [start] keep the credentials it carries? Only on the
// start's own origin (or its mesh forwarder), or an HTTPS upgrade of it.
internal fun hopKeepsCredentials(hop: HttpUrl, start: HttpUrl, transport: ServerTransport) =
    isServerUrl(hop, origin(start), transport) || isHttpsUpgrade(hop, start)

// Does a hop get the active server's credentials added? Only when it is that server (or its
// forwarder), or an HTTPS upgrade of a call that started there.
internal fun hopGetsServerAuth(hop: HttpUrl, start: HttpUrl, serverOrigin: String, transport: ServerTransport) =
    isServerUrl(hop, serverOrigin, transport) || (origin(start) == serverOrigin && isHttpsUpgrade(hop, start))

// Network interceptor: runs on every hop, redirects included, after TransportInterceptor.
// - A hop that left the origin the call started on loses every credential header
//   (OkHttp drops Authorization on cross-origin redirects, but not X-Emby-Token), unless the
//   hop is an HTTPS upgrade on the same host.
// - A hop to the active server (or its mesh forwarder) that carries no credentials gets
//   [active]'s auth headers, so ExoPlayer, Coil and downloads need no api_key in the URL.
// Nothing is ever added for any other host. Clients derived from Core.http (QbitClient, Updates)
// inherit this, which only matters if their target is the server's exact scheme://host:port.
class ServerAuthInterceptor(
    private val transport: () -> ServerTransport,
    // TP-06: the other signed-in servers; a hop gets the credentials of the server it goes to.
    private val others: () -> List<Api> = { emptyList() },
    private val active: () -> Api?,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val start = chain.call().request().url
        val t = transport()
        val b = req.newBuilder()
        if (!hopKeepsCredentials(req.url, start, t)) {
            AUTH_HEADERS.forEach { b.removeHeader(it) }
        } else if (AUTH_HEADERS.none { req.header(it) != null }) {
            val api = (listOfNotNull(active()) + others()).firstOrNull { a -> a.server.origin?.let { hopGetsServerAuth(req.url, start, it, t) } == true }
            api?.authHeaders()?.forEach { (k, v) -> b.header(k, v) }
        }
        return chain.proceed(b.build())
    }
}

fun runtimeText(ticks: Long?): String? {
    val min = ((ticks ?: return null) / 600_000_000L).toInt()
    if (min <= 0) return null
    // "1 h 05" / "45 min" (French), "1h 05m" / "45 min" (English).
    return if (min >= 60) Core.str(R.string.duration_hours_minutes, min / 60, min % 60) else Core.str(R.string.duration_minutes, min)
}

fun clock(ms: Long): String {
    val s = (ms.coerceAtLeast(0) / 1000).toInt()
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}
