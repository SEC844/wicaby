package com.wika.wicaby.core.subsonic

import com.wika.wicaby.core.plex.get
import com.wika.wicaby.core.plex.num
import com.wika.wicaby.core.plex.str
import com.wika.wicaby.core.plex.truthy
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.encodeUtf8
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

// The Navidrome (OpenSubsonic) dialect, pure part (music-feishin-navidrome spec §4.B), the twin of desktop's
// shared/subsonic/map.ts: ids, Subsonic records mapped onto the Emby-shaped music model, the album list a library
// query asks for, the scrobble threshold, lyrics and token auth. Both read tools/checks/fixtures/subsonic/vectors.json
// (SubsonicVectorsTest).
object SubsonicMap {
    private const val TICKS_S = 10_000_000L
    private val KINDS = setOf("ar", "al", "tr", "pl", "mf", "ge", "pe")
    private val PLAIN = Regex("^[A-Za-z0-9-]+$")
    private val ID = Regex("^([a-z]{2})_(_?)(.+)$")

    data class Id(val kind: String, val raw: String)

    // ar_ artist, al_ album, tr_ track, pl_ playlist, mf_ music folder, ge_ genre (its name), pe_ playlist entry (its
    // index). A raw id outside [A-Za-z0-9-] goes as base64url after a second '_' (the cast relay's id alphabet).
    fun encodeId(kind: String, raw: String): String = if (PLAIN.matches(raw)) "${kind}_$raw" else "${kind}__${raw.encodeUtf8().base64Url().trimEnd('=')}"

    fun decodeId(id: String?): Id? {
        val m = ID.matchEntire(id ?: return null) ?: return null
        val (kind, b64, rest) = m.destructured
        if (kind !in KINDS) return null
        if (b64.isEmpty()) return if (PLAIN.matches(rest)) Id(kind, rest) else null
        if (!Regex("^[A-Za-z0-9_-]+$").matches(rest)) return null
        return rest.decodeBase64()?.utf8()?.let { Id(kind, it) }
    }

    // t = md5(password + salt) (OpenSubsonic token auth); never p=.
    fun token(password: String, salt: String): String = (password + salt).encodeUtf8().md5().hex()

    // ---- Records → items ----

    private fun ticks(seconds: JsonElement?) = seconds.num()?.let { (it * TICKS_S).roundToLong() }

    private fun genres(r: JsonElement): List<String> {
        val list = arr(r["genres"]).mapNotNull { it["name"].str()?.takeIf(String::isNotEmpty) }
        return list.ifEmpty { listOfNotNull(r["genre"].str()?.takeIf(String::isNotEmpty)) }
    }

    // A Subsonic list: an array, a lone object (old servers), or nothing.
    fun arr(e: JsonElement?): List<JsonObject> = when (e) {
        is JsonArray -> e.filterIsInstance<JsonObject>()
        is JsonObject -> listOf(e)
        else -> emptyList()
    }

    private fun kotlinx.serialization.json.JsonObjectBuilder.num(key: String, v: JsonElement?) {
        val d = v.num() ?: return
        if (d == Math.floor(d) && !d.isInfinite()) put(key, d.toLong()) else put(key, d)
    }

    private fun kotlinx.serialization.json.JsonObjectBuilder.common(r: JsonElement) {
        putJsonObject("ImageTags") { r["coverArt"].str()?.let { put("Primary", it) } }
        putJsonObject("UserData") {
            put("IsFavorite", r["starred"].truthy())
            val plays = r["playCount"].num()?.toLong() ?: 0L
            put("PlayCount", plays)
            put("Played", plays > 0)
            put("Key", r["id"].str() ?: "")
        }
    }

    private fun kotlinx.serialization.json.JsonObjectBuilder.genreFields(g: List<String>) {
        putJsonArray("Genres") { g.forEach { add(it) } }
        putJsonArray("GenreItems") { g.forEach { n -> addJsonObject { put("Name", n); put("Id", encodeId("ge", n)) } } }
    }

    private fun ref(id: String?, name: String) = buildJsonArray { if (id != null) addJsonObject { put("Id", encodeId("ar", id)); put("Name", name) } }

    fun artist(r: JsonElement): JsonObject = buildJsonObject {
        put("Id", encodeId("ar", r["id"].str() ?: ""))
        put("Name", r["name"].str() ?: "")
        put("Type", "MusicArtist")
        put("IsFolder", true)
        num("ChildCount", r["albumCount"])
        common(r)
    }

    fun album(r: JsonElement): JsonObject = buildJsonObject {
        val artist = r["artist"].str() ?: r["displayArtist"].str() ?: ""
        val g = genres(r)
        put("Id", encodeId("al", r["id"].str() ?: ""))
        put("Name", r["name"].str() ?: r["title"].str() ?: "")
        put("Type", "MusicAlbum")
        put("IsFolder", true)
        put("AlbumArtist", artist)
        put("AlbumArtists", ref(r["artistId"].str(), artist))
        put("ArtistItems", ref(r["artistId"].str(), artist))
        putJsonArray("Artists") { if (artist.isNotEmpty()) add(artist) }
        num("ProductionYear", r["year"])
        genreFields(g)
        num("ChildCount", r["songCount"])
        ticks(r["duration"])?.let { put("RunTimeTicks", it) }
        r["created"].str()?.let { put("DateCreated", it) }
        common(r)
        num("NormalizationGain", r["replayGain"]["albumGain"])
    }

    // [entry]: the song's index in a playlist (its PlaylistItemId).
    fun song(r: JsonElement, entry: Int? = null): JsonObject = buildJsonObject {
        val artist = r["artist"].str() ?: ""
        val albumArtist = r["displayAlbumArtist"].str() ?: arr(r["albumArtists"]).firstOrNull()?.get("name").str() ?: artist
        val id = encodeId("tr", r["id"].str() ?: "")
        val codec = r["suffix"].str()?.lowercase()
        val g = genres(r)
        put("Id", id)
        put("Name", r["title"].str() ?: "")
        put("Type", "Audio")
        put("MediaType", "Audio")
        put("IsFolder", false)
        r["album"].str()?.let { put("Album", it) }
        r["albumId"].str()?.let { put("AlbumId", encodeId("al", it)) }
        put("AlbumArtist", albumArtist)
        put("AlbumArtists", ref(arr(r["albumArtists"]).firstOrNull()?.get("id").str(), albumArtist))
        put("ArtistItems", ref(r["artistId"].str(), artist))
        putJsonArray("Artists") { if (artist.isNotEmpty()) add(artist) }
        num("IndexNumber", r["track"])
        if (r["discNumber"].num() != null) num("ParentIndexNumber", r["discNumber"]) else put("ParentIndexNumber", 1)
        num("ProductionYear", r["year"])
        genreFields(g)
        ticks(r["duration"])?.let { put("RunTimeTicks", it) }
        codec?.let { put("Container", it) }
        r["coverArt"].str()?.let { put("AlbumPrimaryImageTag", it) }
        common(r)
        num("NormalizationGain", r["replayGain"]["trackGain"])
        if (entry != null) put("PlaylistItemId", encodeId("pe", "$entry"))
        putJsonArray("MediaSources") {
            addJsonObject {
                put("Id", id)
                put("Protocol", "File")
                codec?.let { put("Container", it) }
                num("Size", r["size"])
                r["bitRate"].num()?.let { put("Bitrate", (it * 1000).toLong()) }
                ticks(r["duration"])?.let { put("RunTimeTicks", it) }
                put("SupportsDirectPlay", true)
                put("SupportsDirectStream", true)
                put("SupportsTranscoding", false)
                putJsonArray("MediaStreams") {
                    addJsonObject {
                        put("Type", "Audio")
                        put("Index", 0)
                        codec?.let { put("Codec", it) }
                        num("Channels", r["channelCount"])
                        num("SampleRate", r["samplingRate"])
                        num("BitDepth", r["bitDepth"])
                        put("IsDefault", true)
                    }
                }
            }
        }
    }

    fun playlist(r: JsonElement): JsonObject = buildJsonObject {
        put("Id", encodeId("pl", r["id"].str() ?: ""))
        put("Name", r["name"].str() ?: "")
        put("Type", "Playlist")
        put("MediaType", "Audio")
        put("IsFolder", true)
        num("ChildCount", r["songCount"])
        ticks(r["duration"])?.let { put("RunTimeTicks", it) }
        r["created"].str()?.let { put("DateCreated", it) }
        common(r)
    }

    fun genre(r: JsonElement): JsonObject = buildJsonObject {
        val name = r["value"].str() ?: r["name"].str() ?: ""
        put("Id", encodeId("ge", name))
        put("Name", name)
        put("Type", "MusicGenre")
        put("IsFolder", true)
        num("ChildCount", r["albumCount"])
        putJsonObject("ImageTags") {}
    }

    fun folder(r: JsonElement): JsonObject = buildJsonObject {
        put("Id", encodeId("mf", r["id"].str() ?: ""))
        put("Name", r["name"].str() ?: "Music")
        put("Type", "CollectionFolder")
        put("CollectionType", "music")
        put("IsFolder", true)
        putJsonObject("ImageTags") {}
    }

    // ---- Library queries → getAlbumList2 ----

    // The album list a /Items?IncludeItemTypes=MusicAlbum query asks for; [q] keys with the first letter upper.
    fun albumListArgs(q: Map<String, String>): Map<String, String> {
        val sort = (q["SortBy"] ?: "").substringBefore(',')
        val desc = q["SortOrder"]?.startsWith("desc", ignoreCase = true) == true
        val genre = q["Genres"]?.substringBefore('|') ?: q["GenreIds"]?.let { decodeId(it.substringBefore(','))?.raw }
        val years = q["Years"]?.split(',')?.mapNotNull { it.trim().toIntOrNull() }.orEmpty()
        return when {
            q["Filters"]?.contains("IsFavorite") == true || q["IsFavorite"] == "true" -> mapOf("type" to "starred")
            genre != null -> mapOf("type" to "byGenre", "genre" to genre)
            years.isNotEmpty() -> mapOf("type" to "byYear", "fromYear" to "${if (desc) years.max() else years.min()}", "toYear" to "${if (desc) years.min() else years.max()}")
            sort == "ProductionYear" || sort == "PremiereDate" -> mapOf("type" to "byYear", "fromYear" to if (desc) "9999" else "0", "toYear" to if (desc) "0" else "9999")
            sort == "DateCreated" -> mapOf("type" to "newest")
            sort == "PlayCount" -> mapOf("type" to "frequent")
            sort == "DatePlayed" -> mapOf("type" to "recent")
            sort == "Random" -> mapOf("type" to "random")
            sort == "AlbumArtist" || sort == "Artist" -> mapOf("type" to "alphabeticalByArtist")
            else -> mapOf("type" to "alphabeticalByName")
        }
    }

    // A play counts once it reached half the track or 4 minutes (the Last.fm rule).
    fun scrobbleDue(positionTicks: Long?, runTimeTicks: Long?): Boolean {
        val pos = positionTicks ?: 0L
        val half = if (runTimeTicks != null && runTimeTicks > 0) runTimeTicks / 2.0 else Double.POSITIVE_INFINITY
        return pos > 0 && pos >= min(half, 240.0 * TICKS_S)
    }

    // OpenSubsonic structuredLyrics (ms; offset positive = sooner) or getLyrics text → Jellyfin's lyrics JSON (ticks).
    fun lyricsToJellyfin(structured: List<JsonObject>?, legacy: String? = null): JsonObject? {
        val list = structured.orEmpty()
        val pick = list.firstOrNull { it["synced"].truthy() && arr(it["line"]).isNotEmpty() } ?: list.firstOrNull { arr(it["line"]).isNotEmpty() }
        if (pick != null) {
            val synced = pick["synced"].truthy()
            val offset = pick["offset"].num() ?: 0.0
            return buildJsonObject {
                putJsonObject("Metadata") { put("IsSynced", synced) }
                putJsonArray("Lyrics") {
                    for (l in arr(pick["line"])) addJsonObject {
                        put("Text", l["value"].str() ?: "")
                        if (synced) put("Start", (max(0.0, (l["start"].num() ?: 0.0) - offset) * 10_000).roundToLong())
                    }
                }
            }
        }
        val text = legacy?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return buildJsonObject {
            putJsonObject("Metadata") { put("IsSynced", false) }
            putJsonArray("Lyrics") { text.split(Regex("\\r?\\n")).forEach { t -> addJsonObject { put("Text", t) } } }
        }
    }

    fun plainText(html: String?): String? = html?.replace(Regex("<[^>]*>"), "")?.replace("&amp;", "&")?.replace("&quot;", "\"")?.replace("&#39;", "'")
        ?.replace("&lt;", "<")?.replace("&gt;", ">")?.trim()?.takeIf { it.isNotEmpty() }
}
