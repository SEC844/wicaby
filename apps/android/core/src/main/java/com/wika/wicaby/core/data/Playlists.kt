package com.wika.wicaby.core.data

import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

// "Ajouter à une playlist / collection", as desktop's lib/playlists.ts: Emby and Jellyfin share the
// routes; Jellyfin reads the playlist create call from a JSON body, Emby from the query, so both go.
enum class ListKind { Playlist, Collection }

object Playlists {
    // Which items the menu offers each entry for (desktop's ItemMenu lists).
    private val PLAYLISTABLE = setOf("Movie", "Episode", "Series", "Season", "Video", "MusicVideo", "Audio", "MusicAlbum", "Trailer")
    private val COLLECTABLE = setOf("Movie", "Series", "Video", "MusicVideo", "MusicAlbum", "Book", "Trailer")

    fun accepts(kind: ListKind, item: Item) = item.type in (if (kind == ListKind.Playlist) PLAYLISTABLE else COLLECTABLE)

    // Playlists hold one media type; music goes to audio playlists.
    fun mediaTypeOf(item: Item) = if (item.type in setOf("Audio", "MusicAlbum", "MusicArtist") || item.mediaType == "Audio") "Audio" else "Video"

    // A playlist keeps one media type; one with no type is offered anyway.
    fun targetsFor(kind: ListKind, item: Item, all: List<Item>): List<Item> =
        if (kind == ListKind.Collection) all else all.filter { it.mediaType == null || it.mediaType == mediaTypeOf(item) }
}

suspend fun Api.lists(kind: ListKind): List<Item> =
    items("IncludeItemTypes" to if (kind == ListKind.Playlist) "Playlist" else "BoxSet", "Recursive" to true, "SortBy" to "SortName").items

suspend fun Api.createList(kind: ListKind, name: String, item: Item) {
    if (kind == ListKind.Collection) {
        raw("POST", "/Collections", null, "Name" to name, "Ids" to item.id)
        return
    }
    val type = Playlists.mediaTypeOf(item)
    val body = buildJsonObject {
        put("Name", name)
        putJsonArray("Ids") { add(item.id) }
        put("UserId", userId)
        put("MediaType", type)
    }
    raw("POST", "/Playlists", body.toString(), "Name" to name, "Ids" to item.id, "UserId" to userId, "MediaType" to type)
}

suspend fun Api.addToList(kind: ListKind, listId: String, item: Item) {
    if (kind == ListKind.Playlist) raw("POST", "/Playlists/$listId/Items", null, "Ids" to item.id, "UserId" to userId)
    else raw("POST", "/Collections/$listId/Items", null, "Ids" to item.id)
}
