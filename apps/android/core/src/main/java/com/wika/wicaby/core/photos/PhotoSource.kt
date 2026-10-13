package com.wika.wicaby.core.photos

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ItemsResult
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.wika.wicaby.core.livetv.DeviceClass
import kotlinx.coroutines.CancellationException
import java.util.Calendar
import java.util.Locale

// Photos (spec §3.1, PH-05/PH-06): the Emby/Jellyfin queries, paging and image sizes the mobile and TV photo screens
// share. Kotlin side of the desktop's source.svelte.ts.

// A timeline entry: the asset the UI lays out, and the server item it came from (orientation, EXIF, playback).
data class Photo(val asset: PhotoAsset, val item: Item)

// /Items with what a photo timeline needs: size for the layout, one Primary image, the favourite flag.
suspend fun Api.photoItems(vararg query: Pair<String, Any?>): ItemsResult = get(
    if (server.isEmby) "/Users/$userId/Items" else "/Items", "userId" to userId.takeUnless { server.isEmby },
    "Fields" to "$listFields,Width,Height", "EnableImageTypes" to "Primary", "ImageTypeLimit" to 1, "EnableUserData" to true, *query,
)

// The skeleton query (spec §3.1): every photo and clip under [parentId], newest DateCreated first. Albums are folders,
// so an album is the same query with its id; favourites add Filters=IsFavorite.
fun Api.timelineQuery(parentId: String, favorites: Boolean = false): suspend (Int, Int) -> ItemsResult = { start, limit ->
    photoItems(
        "ParentId" to parentId, "Recursive" to true, "IncludeItemTypes" to "Photo,Video",
        "SortBy" to "DateCreated,SortName", "SortOrder" to "Descending", "Filters" to if (favorites) "IsFavorite" else null,
        "StartIndex" to start, "Limit" to limit,
    )
}

suspend fun Api.photoAlbums(libraryId: String): List<Item> = photoItems(
    "ParentId" to libraryId, "IncludeItemTypes" to "PhotoAlbum", "Recursive" to false, "SortBy" to "SortName", "SortOrder" to "Ascending",
).items

// The TV screensaver's photo source (spec §4.4): random stills under an album or library, or every library.
suspend fun Api.randomPhotos(parentId: String?, limit: Int = 60): List<Item> = photoItems(
    "ParentId" to parentId, "Recursive" to true, "IncludeItemTypes" to "Photo", "SortBy" to "Random", "Limit" to limit,
).items.filter { it.imageTags["Primary"] != null }

// Pages through [fetch] (1,000 a page), re-sorting each page by takenAt (the server sorts by DateCreated, UTC).
// shortcut: one page in flight and no cache across screens; add a second request and a per-library cache if a 20k
// library takes over 5 s on LAN.
class PhotoSource(private val fetch: suspend (start: Int, limit: Int) -> ItemsResult, private val pageSize: Int = 1000, private val offsetMin: Int? = null) {
    suspend fun load(onPage: (photos: List<Photo>, total: Int) -> Unit = { _, _ -> }): List<Photo> {
        val out = ArrayList<Photo>()
        while (true) {
            val r = fetch(out.size, pageSize)
            out += r.items.map { Photo(toAsset(it, offsetMin), it) }.sortedWith { a, b -> BY_TAKEN_DESC.compare(a.asset, b.asset) }
            onPage(out.toList(), r.totalRecordCount)
            if (r.items.isEmpty() || out.size >= r.totalRecordCount) return out
        }
    }
}

// A loaded timeline, kept in each app's screen cache for the session (spec §3.1). complete: every page arrived. A load
// cut short (the screen left while a large library was still paging) starts over next time instead of passing for
// the whole library; meanwhile the pages already in stay on screen.
class TimelineState {
    var photos by mutableStateOf<List<Photo>>(emptyList())
    // -1 until the first page answers.
    var total by mutableIntStateOf(-1)
    var failed by mutableStateOf(false)
    var complete by mutableStateOf(false)
        private set

    // force: reload a complete timeline too (pull to refresh, retry).
    suspend fun load(source: PhotoSource, force: Boolean = false) {
        if (complete && !force) return
        try {
            val all = source.load { p, n ->
                if (p.size >= photos.size) photos = p
                total = n
            }
            photos = all
            total = all.size
            failed = false
            complete = true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failed = photos.isEmpty()
        }
    }
}

// Image sizes (spec §3.1, §4.3, §4.4): grid heights in a few buckets so the server's resize cache is shared, and a
// viewer cap per device class. Emby rotates on request (AutoOrient); Jellyfin never does, the client turns the pixels.
object PhotoSizes {
    // Mobile row target heights (dp) per density, and the thumbnail height each one asks for.
    val ROW_DP = intArrayOf(90, 140, 220)
    val THUMB_DP = intArrayOf(120, 180, 270)
    const val TV_LOW_TILE = 240
    const val ZOOM_CAP = 4096

    fun viewerCap(c: DeviceClass): Int = when (c) {
        DeviceClass.TV_LOW -> 1280
        DeviceClass.TV -> 1920
        DeviceClass.MOBILE_LOW -> 1600
        else -> 2560
    }

    // The TV grid's tile width: 240 px at most on tv-low.
    fun tvTile(c: DeviceClass, px: Int): Int = if (c == DeviceClass.TV_LOW) minOf(px, TV_LOW_TILE) else px
}

fun Api.photoImage(a: PhotoAsset, maxWidth: Int? = null, maxHeight: Int? = null): String = url(
    "/Items/${a.id}/Images/Primary", "tag" to a.thumbTag, "maxWidth" to maxWidth, "maxHeight" to maxHeight, "quality" to 90,
    "AutoOrient" to true.takeIf { server.isEmby },
)

// "2019-10-12T…" as "12 octobre 2019" (pattern "d MMMM yyyy") or "Octobre 2019" ("LLLL yyyy"): wall-clock fields,
// no zone conversion.
fun photoDate(takenAt: String, locale: Locale, pattern: String = "d MMMM yyyy"): String {
    val cal = Calendar.getInstance()
    cal.clear()
    cal.set(takenAt.take(4).toIntOrNull() ?: 1, (takenAt.substring(5, 7).toIntOrNull() ?: 1) - 1, takenAt.substring(8, 10).toIntOrNull() ?: 1)
    return java.text.SimpleDateFormat(pattern, locale).format(cal.time).replaceFirstChar { it.titlecase(locale) }
}
