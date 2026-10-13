package com.wika.wicaby.core.music

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ItemsResult
import com.wika.wicaby.core.data.json
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

// Music calls (music spec MU-01, §3), the twin of desktop's renderer/lib/music.ts: the Emby / Jellyfin differences
// in one place. Playlist remove and move live with the other playlist calls (data/Playlists.kt).

private val Api.userKey get() = if (server.isEmby) "UserId" else "userId"

suspend fun Api.albums(parentId: String, startIndex: Int = 0, limit: Int = 100): ItemsResult =
    items("ParentId" to parentId, "IncludeItemTypes" to "MusicAlbum", "Recursive" to true, "SortBy" to "SortName", "StartIndex" to startIndex, "Limit" to limit)

suspend fun Api.songs(parentId: String, startIndex: Int = 0, limit: Int = 100): ItemsResult =
    items("ParentId" to parentId, "IncludeItemTypes" to "Audio", "Recursive" to true, "SortBy" to "Album,ParentIndexNumber,IndexNumber,SortName", "StartIndex" to startIndex, "Limit" to limit)

/** Album artists (whom albums are filed under) or every artist credited on a track (§3.2); Jellyfin 12's /Persons later. */
suspend fun Api.musicArtists(parentId: String, albumArtistsOnly: Boolean): ItemsResult =
    if (albumArtistsOnly) albumArtists("ParentId" to parentId, "SortBy" to "SortName")
    else get("/Artists", userKey to userId, "ParentId" to parentId, "SortBy" to "SortName", "Fields" to listFields, "EnableImageTypes" to "Primary", "ImageTypeLimit" to 1)

/** Emby /MusicGenres; Jellyfin /Genres?IncludeItemTypes=MusicAlbum (its /MusicGenres is deprecated since 10.8). */
suspend fun Api.musicGenres(parentId: String): ItemsResult =
    if (server.isEmby) get("/MusicGenres", "UserId" to userId, "ParentId" to parentId, "SortBy" to "SortName")
    else get("/Genres", "userId" to userId, "ParentId" to parentId, "IncludeItemTypes" to "MusicAlbum", "SortBy" to "SortName")

/** One route for tracks, albums, artists, genres and playlists on both servers (§3.3). */
suspend fun Api.instantMix(id: String, limit: Int = 100): ItemsResult =
    get("/Items/$id/InstantMix", userKey to userId, "Limit" to limit, "Fields" to listFields)

/**
 * Server lyrics (§3.5). Jellyfin: /Audio/{id}/Lyrics when HasLyrics. Emby has no lyrics route: an external lrc / text
 * subtitle stream of the audio item, fetched as Stream.lrc then Stream.txt. That Emby shape is UNVERIFIED (one real
 * Emby 4.8/4.9 observation pending): any failure reads as "no lyrics", never an error. None: lrclib.net when the user
 * turned it on (MU-13, [LrcLib]); off, nothing leaves the app.
 */
suspend fun Api.lyrics(item: Item): Lyrics? = serverLyrics(item) ?: if (MusicPrefs.lyricsOnline) LrcLib.default.lyrics(item) else null

private suspend fun Api.serverLyrics(item: Item): Lyrics? = runCatching {
    if (!server.isEmby && item.hasLyrics == false) return null
    if (!server.isEmby) return json.decodeFromString(JellyfinLyrics.serializer(), raw("GET", "/Audio/${item.id}/Lyrics")).toLyrics()
    val source = item.mediaSources.firstOrNull()
    val stream = (source?.mediaStreams ?: item.mediaStreams).ifEmpty { item.mediaStreams }
        .firstOrNull { it.type == "Subtitle" && it.codec?.lowercase() in setOf("lrc", "text", "txt") } ?: return null
    val base = "/Videos/${item.id}/${source?.id?.ifEmpty { null } ?: item.id}/Subtitles/${stream.index}/Stream"
    val text = runCatching { raw("GET", "$base.lrc") }.getOrElse { raw("GET", "$base.txt") }
    Lrc.parse(text).takeIf { it.lines.isNotEmpty() }
}.getOrNull()

/** "Enregistrer comme playlist": an audio playlist of the queue, in order (both create forms, as Playlists.kt). */
suspend fun Api.saveQueueAsPlaylist(name: String, ids: List<String>): String? {
    val body = buildJsonObject {
        put("Name", name)
        putJsonArray("Ids") { ids.forEach { add(it) } }
        put("UserId", userId)
        put("MediaType", "Audio")
    }
    val res = raw("POST", "/Playlists", body.toString(), "Name" to name, "Ids" to ids.joinToString(","), "UserId" to userId, "MediaType" to "Audio")
    return runCatching { json.parseToJsonElement(res).jsonObject["Id"]?.jsonPrimitive?.contentOrNull }.getOrNull()
}
