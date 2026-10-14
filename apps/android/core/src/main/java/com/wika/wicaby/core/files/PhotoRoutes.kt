package com.wika.wicaby.core.files

import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ItemsResult
import com.wika.wicaby.core.data.UserData
import com.wika.wicaby.core.data.isoUtc
import com.wika.wicaby.core.data.json
import com.wika.wicaby.core.files.pure.ExifReader
import com.wika.wicaby.core.files.pure.Ids

// A photo source's answers to the calls the photo screens already make on Emby (core photos/PhotoSource.kt, Memories.kt):
// the timeline (Recursive Photo,Video under the source or an album, favourites, a premiere-date range, Random), the
// albums (every folder that holds photos), /Years, favourites (kept in the index), and a photo's EXIF for the info
// panel. Same item shape as the desktop's files-client. null: not a photo route, FilesApi answers it.
internal suspend fun FilesApi.photoRoute(method: String, p: String, parts: List<String>, query: List<Pair<String, Any?>>): String? {
    val index = photos ?: return null
    return when {
        // No ParentId (the home row's memories): the whole source.
        method == "GET" && p == "/Items" -> encode(photoList(index, arg(query, "ParentId")?.let(::relOf).orEmpty(), query))
        method == "GET" && p == "/Years" -> {
            val under = arg(query, "ParentId")?.let(::relOf).orEmpty()
            val years = index.records().filter { (r, rec) -> inside(r, under) && !rec.v }.values.mapNotNull { takenKey(it).take(4).toIntOrNull() }.distinct().sortedDescending()
            encode(ItemsResult(years.map { Item(id = "$it", name = "$it", productionYear = it) }, years.size))
        }
        method == "GET" && parts.size == 2 && parts[0] == "Items" -> {
            val rel = relOf(parts[1])
            index.records()[rel]?.takeIf { !it.v }?.let { json.encodeToString(Item.serializer(), photoItem(index, rel, it)) }
        }
        (method == "POST" || method == "DELETE") && parts.size == 2 && parts[0] == "FavoriteItems" -> {
            index.setFavorite(relOf(parts[1]), method == "POST")
            ""
        }
        else -> null
    }
}

// The picture Coil loads for [px] (the long side asked, 0: unknown): a cached thumbnail (PhotoThumbs) up to its last
// bucket, else the file itself (the viewer, its zoom); an album shows its newest photo.
internal fun FilesApi.photoImage(id: String, px: Int = 0): String? {
    val index = photos ?: return null
    val rel = Ids.decode(id) ?: return null
    val rec = index.cached(rel)?.takeIf { !it.v } ?: return albumCover(index, rel)?.let { photoImage(it, px) }
    PhotoThumbs.bucket(px)?.let { return PhotoThumbs.uri(source.id, it, "${rec.s}-${rec.m / 1000}", id) }
    return runCatching { backend.uri(rel, FileEntry(Ids.name(rel), false, rec.s, rec.m, rec.u)) }.getOrNull()
}

private fun inside(rel: String, parent: String) = parent.isEmpty() || rel.startsWith("$parent/")

// The timeline key: the EXIF wall clock, else the mtime (UTC) for files without one.
private fun takenKey(r: PhotoRecord) = r.t ?: isoUtc(r.m).take(19)

private fun albumCover(index: PhotoIndex, folder: String): String? = index.cachedAll().filter { (r, rec) -> !rec.v && Ids.parent(r) == folder }
    .maxByOrNull { takenKey(it.value) }?.key?.let(Ids::encode)

private suspend fun FilesApi.photoList(index: PhotoIndex, parent: String, query: List<Pair<String, Any?>>): ItemsResult {
    val all = index.records()
    val types = arg(query, "IncludeItemTypes").orEmpty()
    if ("PhotoAlbum" in types) {
        // Albums are folders (every folder below [parent] that directly holds a photo or a clip), by name.
        val albums = all.keys.mapNotNull { Ids.parent(it) }.filter { it.isNotEmpty() && it != parent && inside(it, parent) }.distinct()
            .sortedWith(compareBy(com.wika.wicaby.core.files.pure.NatSort) { it })
        val items = albums.mapNotNull { a ->
            val id = Ids.encode(a) ?: return@mapNotNull null
            val cover = albumCover(index, a)
            // A nested album names its path (as the desktop does): "Famille › Anniversaires".
            Item(id = id, name = a.removePrefix(if (parent.isEmpty()) "" else "$parent/").replace("/", " › "), type = "PhotoAlbum", isFolder = true, serverId = source.id, childCount = all.keys.count { Ids.parent(it) == a }, imageTags = cover?.let { mapOf("Primary" to it) }.orEmpty())
        }
        return ItemsResult(items, items.size)
    }
    val wantPhotos = "Photo" in types || types.isEmpty()
    val wantVideos = "Video" in types || types.isEmpty()
    val favs = if (arg(query, "Filters")?.contains("IsFavorite") == true) index.favorites() else null
    val min = arg(query, "MinPremiereDate")?.take(19)
    val max = arg(query, "MaxPremiereDate")?.take(19)
    var hits = all.entries.filter { (r, rec) ->
        inside(r, parent) && (if (rec.v) wantVideos else wantPhotos) && (favs == null || r in favs) &&
            (min == null || takenKey(rec) >= min) && (max == null || takenKey(rec) <= max)
    }
    hits = if (arg(query, "SortBy")?.startsWith("Random") == true) hits.shuffled()
    else hits.sortedBy { takenKey(it.value) }.let { if (arg(query, "SortOrder") == "Descending") it.reversed() else it }
    val start = arg(query, "StartIndex")?.toIntOrNull()?.coerceAtLeast(0) ?: 0
    val limit = arg(query, "Limit")?.toIntOrNull() ?: hits.size
    val favorites = index.favorites()
    return ItemsResult(hits.drop(start).take(limit).map { (r, rec) -> photoItem(index, r, rec, favorites) }, hits.size)
}

internal fun FilesApi.photoItem(index: PhotoIndex, rel: String, r: PhotoRecord, favorites: Set<String> = index.favorites()): Item {
    val kind = if (r.v) "Video" else "Photo"
    return Item(
        id = Ids.encode(rel).orEmpty(), name = Ids.name(rel), type = kind, mediaType = kind, serverId = source.id,
        premiereDate = r.t?.let { it + r.z.orEmpty() }, dateCreated = isoUtc(r.m),
        width = r.w, height = r.h, imageOrientation = ExifReader.orientationName(r.o),
        cameraMake = r.mk, cameraModel = r.md, exposureTime = r.ex, aperture = r.fn, focalLength = r.fl, isoSpeedRating = r.iso?.toInt(),
        // No coordinates: the apps have no photo map, and GPS is only for an opt-in map (photo file sources privacy).
        imageTags = if (r.v) emptyMap() else mapOf("Primary" to "${r.s}-${r.m / 1000}"),
        userData = UserData(isFavorite = rel in favorites),
    )
}
