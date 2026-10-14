package com.wika.wicaby.mobile.music

import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ListKind
import com.wika.wicaby.core.data.lists
import com.wika.wicaby.core.data.poster

/**
 * Android Auto's browse tree (music spec MU-12; served by PlaybackService in the gplay flavour only): the root lists
 * Récents, Playlists, Albums and Artistes; an album or a playlist lists its tracks (playable), an artist their albums.
 * Node ids: "root", "recent", "playlists", "albums", "artists", "album/<id>", "playlist/<id>", "artist/<id>"; a track
 * is "<node>|<track id>", so playing it plays its node's list from that track. [load] fetches a node's items
 * ([autoNode] in the app, a fake in AutoBrowseTreeTest); [label] names the four top nodes.
 */
class AutoBrowseTree(
    private val label: (String) -> String,
    private val load: suspend (node: String) -> List<Item>,
    private val art: (Item) -> Uri? = { null },
) {
    fun root(): MediaItem = folder(ROOT, label(ROOT), null)

    suspend fun children(node: String): List<MediaItem> =
        if (node == ROOT) TOP.map { folder(it, label(it), null) }
        else if (node in TOP || node.substringBefore('/') in KINDS) load(node).mapNotNull { child(node, it) }
        else emptyList()

    /** The tracks a played media id belongs to and its index there; null for anything else. */
    suspend fun queueFor(mediaId: String): Pair<List<Item>, Int>? {
        val node = mediaId.substringBeforeLast('|', "")
        if (node.isEmpty() || node == ROOT) return null
        val id = mediaId.substringAfterLast('|')
        val tracks = load(node).filter { it.type == "Audio" }
        return tracks.indexOfFirst { it.id == id }.takeIf { it >= 0 }?.let { tracks to it }
    }

    private fun child(node: String, it: Item): MediaItem? = when (it.type) {
        "Audio" -> MediaItem.Builder().setMediaId("$node|${it.id}").setMediaMetadata(
            meta(it.name, it).setArtist(it.artistLine).setAlbumTitle(it.album).setIsPlayable(true).setIsBrowsable(false)
                .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC).build(),
        ).build()
        "MusicAlbum" -> folder("album/${it.id}", it.name, it, MediaMetadata.MEDIA_TYPE_ALBUM)
        "Playlist" -> folder("playlist/${it.id}", it.name, it, MediaMetadata.MEDIA_TYPE_PLAYLIST)
        "MusicArtist" -> folder("artist/${it.id}", it.name, it, MediaMetadata.MEDIA_TYPE_ARTIST)
        else -> null
    }

    private fun meta(title: String, item: Item?) = MediaMetadata.Builder().setTitle(title).apply { item?.let(art)?.let(::setArtworkUri) }

    private fun folder(id: String, title: String, item: Item?, type: Int = MediaMetadata.MEDIA_TYPE_FOLDER_MIXED) =
        MediaItem.Builder().setMediaId(id).setMediaMetadata(meta(title, item).setIsBrowsable(true).setIsPlayable(false).setMediaType(type).build()).build()

    companion object {
        const val ROOT = "root"
        const val RECENT = "recent"
        const val PLAYLISTS = "playlists"
        const val ALBUMS = "albums"
        const val ARTISTS = "artists"
        val TOP = listOf(RECENT, PLAYLISTS, ALBUMS, ARTISTS)
        private val KINDS = setOf("album", "playlist", "artist")

        // Android Auto (phone projection; the Desktop Head Unit connects through it too).
        private val AUTO_PACKAGES = setOf("com.google.android.projection.gearhead")

        /** Who may browse: Android Auto only, and only in the gplay flavour (foss never lists itself to Auto). */
        fun allowed(packageName: String, flavor: String) = flavor == "gplay" && packageName in AUTO_PACKAGES
    }
}

/** A node's items from the server: recently played tracks, audio playlists, newest albums, album artists, and below. */
suspend fun Api.autoNode(node: String): List<Item> {
    val id = node.substringAfter('/')
    return when {
        node == AutoBrowseTree.RECENT -> items("IncludeItemTypes" to "Audio", "Recursive" to true, "Filters" to "IsPlayed", "SortBy" to "DatePlayed", "SortOrder" to "Descending", "Limit" to 50, "Fields" to trackFields).items
        node == AutoBrowseTree.PLAYLISTS -> lists(ListKind.Playlist).filter { it.mediaType == null || it.mediaType == "Audio" }
        node == AutoBrowseTree.ALBUMS -> items("IncludeItemTypes" to "MusicAlbum", "Recursive" to true, "SortBy" to "DateCreated,SortName", "SortOrder" to "Descending", "Limit" to 100).items
        node == AutoBrowseTree.ARTISTS -> albumArtists("SortBy" to "SortName", "Limit" to 200).items
        node.startsWith("album/") -> tracksOf(this, id, "MusicAlbum", "")
        node.startsWith("playlist/") -> tracksOf(this, id, "Playlist", "")
        node.startsWith("artist/") -> {
            // As the artist page: Emby's AlbumArtistIds is unverified on 4.8+ (spec §3.2).
            val by = if (server.isEmby) arrayOf("ArtistIds" to id, "ArtistType" to "AlbumArtist") else arrayOf<Pair<String, Any?>>("AlbumArtistIds" to id)
            items(*by, "IncludeItemTypes" to "MusicAlbum", "Recursive" to true, "SortBy" to "ProductionYear,SortName", "SortOrder" to "Descending").items
        }
        else -> emptyList()
    }
}

/** The tree on [api], with art through the server's image URLs (Media3 loads them via Core.http). */
fun autoTree(api: Api, label: (String) -> String) = AutoBrowseTree(label, { api.autoNode(it) }, { api.poster(it, 300)?.let(Uri::parse) })
