package com.wika.wicaby.core.photos

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.util.Calendar
import java.util.TimeZone

// Immich timeline adapter (photos spec §3.2, PH-13): the ONLY Kotlin code that reads Immich's timeline. Its two
// endpoints, GET /api/timeline/buckets and /api/timeline/bucket (columnar), are marked Internal and may change outside
// a major release, so their shape is parsed here and nowhere else. A bucket that no longer parses switches the load to
// the Stable POST /api/search/metadata (page by page, newest first). Written by hand from the published API reference:
// no Immich code (spec §0). Twin of the desktop's renderer/lib/photos/immich-timeline.ts.
object ImmichTimeline {
    const val PAGE = 1000

    // A shape the adapter does not know: the load falls back to search/metadata.
    class ShapeException(what: String) : Exception("immich timeline: $what")

    data class Filter(val favorites: Boolean = false, val albumId: String? = null, val personId: String? = null)

    // fileCreatedAt (UTC) moved by the asset's own offset: the wall-clock time it was taken, "YYYY-MM-DDTHH:MM:SS".
    fun wallClock(fileCreatedAt: String, offsetHours: Double?): String? {
        val m = Regex("""^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$""").find(fileCreatedAt) ?: return null
        val g = m.groupValues
        val zone = g[7].let { z -> if (z.isEmpty() || z == "Z") 0 else (if (z[0] == '-') -1 else 1) * (z.substring(1, 3).toInt() * 60 + z.takeLast(2).toInt()) }
        val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        cal.clear()
        cal.set(g[1].toInt(), g[2].toInt() - 1, g[3].toInt(), g[4].toInt(), g[5].toInt(), g[6].toInt())
        cal.timeInMillis += -zone * 60_000L + ((offsetHours?.takeIf { it.isFinite() } ?: 0.0) * 3_600_000).toLong()
        fun p(n: Int, w: Int = 2) = n.toString().padStart(w, '0')
        return "${p(cal.get(Calendar.YEAR), 4)}-${p(cal.get(Calendar.MONTH) + 1)}-${p(cal.get(Calendar.DAY_OF_MONTH))}" +
            "T${p(cal.get(Calendar.HOUR_OF_DAY))}:${p(cal.get(Calendar.MINUTE))}:${p(cal.get(Calendar.SECOND))}"
    }

    // "H:MM:SS.ffffff" in milliseconds; null for none or zero.
    fun durationMs(s: String?): Long? {
        val m = Regex("""^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$""").find(s ?: return null) ?: return null
        val g = m.groupValues
        val ms = ((g[1].toLong() * 60 + g[2].toLong()) * 60 + g[3].toLong()) * 1000 + Math.round("0.${g[4].ifEmpty { "0" }}".toDouble() * 1000)
        return ms.takeIf { it > 0 }
    }

    private fun JsonElement?.str() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonElement?.num() = (this as? JsonPrimitive)?.takeUnless { it is JsonNull }?.doubleOrNull
    private fun JsonElement?.bool() = (this as? JsonPrimitive)?.booleanOrNull

    // One bucket's parallel columns as assets. Throws ShapeException when a column Wicaby needs is missing or of
    // another length. visibility: rows of another visibility are dropped (the server filters already).
    fun columns(body: JsonElement, serverId: String, geo: Boolean, visibility: String?): List<PhotoAsset> {
        val c = body as? JsonObject ?: throw ShapeException("bucket")
        val ids = c["id"] as? JsonArray ?: throw ShapeException("id")
        for (k in listOf("ratio", "isImage", "isFavorite", "fileCreatedAt", "localOffsetHours")) {
            if ((c[k] as? JsonArray)?.size != ids.size) throw ShapeException(k)
        }
        fun col(k: String, i: Int): JsonElement? = (c[k] as? JsonArray)?.getOrNull(i)
        return ids.indices.mapNotNull { i ->
            val id = ids[i].str() ?: throw ShapeException("id")
            val vis = col("visibility", i).str()
            if (col("isTrashed", i).bool() == true || (visibility != null && vis != null && vis != visibility)) return@mapNotNull null
            val taken = wallClock(col("fileCreatedAt", i).str() ?: "", col("localOffsetHours", i).num()) ?: throw ShapeException("fileCreatedAt")
            val video = col("isImage", i).bool() == false
            val lat = col("latitude", i).num()
            val lon = col("longitude", i).num()
            PhotoAsset(
                id = id, serverId = serverId, kind = if (video) "video" else "photo", takenAt = taken,
                aspect = col("ratio", i).num()?.takeIf { it > 0 } ?: 1.5,
                durationMs = if (video) durationMs(col("duration", i).str()) else null,
                favorite = col("isFavorite", i).bool() == true,
                lat = if (geo && lon != null) lat else null, lon = if (geo && lat != null) lon else null,
            )
        }
    }

    // A Stable AssetResponseDto (search/metadata, memories) as an asset. localDateTime carries the wall clock with a "Z".
    fun searchAsset(x: JsonObject, serverId: String, geo: Boolean = false): PhotoAsset {
        val e = x["exifInfo"] as? JsonObject
        val w = e?.get("exifImageWidth").num() ?: 0.0
        val h = e?.get("exifImageHeight").num() ?: 0.0
        // EXIF orientations 5 to 8 are quarter turns: Immich's thumbnails are upright, so the shown shape is swapped.
        val turned = (e?.get("orientation") as? JsonPrimitive)?.contentOrNull in setOf("5", "6", "7", "8")
        val video = x["type"].str() == "VIDEO"
        val lat = e?.get("latitude").num()
        val lon = e?.get("longitude").num()
        return PhotoAsset(
            id = x["id"].str() ?: throw ShapeException("id"), serverId = serverId, kind = if (video) "video" else "photo",
            takenAt = x["localDateTime"].str()?.take(19)?.takeIf { it.length == 19 } ?: wallClock(x["fileCreatedAt"].str() ?: "", 0.0) ?: "0001-01-01T00:00:00",
            aspect = if (w > 0 && h > 0) (if (turned) h / w else w / h) else 1.5,
            durationMs = if (video) durationMs(x["duration"].str()) else null,
            favorite = x["isFavorite"].bool() == true,
            lat = if (geo && lon != null) lat else null, lon = if (geo && lat != null) lon else null,
        )
    }

    class Result(val assets: List<PhotoAsset>, val fallback: Boolean)

    // The whole timeline of a source (or an album, a person, the favourites), newest month first. onPage gets every
    // asset so far and the expected total. A 401/403 (ImmichException) is not a shape problem: it propagates.
    suspend fun load(
        get: suspend (path: String, query: Map<String, String?>) -> JsonElement,
        post: suspend (path: String, body: JsonObject) -> JsonElement,
        serverId: String, filter: Filter, geo: Boolean,
        onPage: (List<PhotoAsset>, Int) -> Unit = { _, _ -> },
    ): Result {
        // Album pages show what the album holds; everywhere else archived assets stay out (spec §3.2: sent explicitly).
        val visibility = if (filter.albumId != null) null else "timeline"
        val query = mapOf("visibility" to visibility, "isFavorite" to "true".takeIf { filter.favorites }, "albumId" to filter.albumId, "personId" to filter.personId)
        return try {
            val raw = get("/timeline/buckets", query) as? JsonArray ?: throw ShapeException("buckets")
            val buckets = raw.map { b ->
                val o = b as? JsonObject ?: throw ShapeException("bucket")
                val key = o["timeBucket"].str()?.takeIf { Regex("""^\d{4}-\d{2}""").containsMatchIn(it) } ?: throw ShapeException("timeBucket")
                key to (o["count"].num()?.toInt() ?: 0)
            }.sortedByDescending { it.first }
            val total = buckets.sumOf { it.second }
            val out = ArrayList<PhotoAsset>()
            // shortcut: one month in flight (the desktop runs two); add a second if a large library pages slowly.
            for ((key, _) in buckets) {
                out += columns(get("/timeline/bucket", query + ("timeBucket" to key)), serverId, geo, visibility).sortedWith(BY_TAKEN_DESC)
                onPage(out.toList(), total)
            }
            Result(out, false)
        } catch (e: ImmichException) {
            throw e
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            // shortcut: any other failure of the Internal endpoints (shape, 404, 5xx) tries the Stable search once.
            Result(searchAll(post, serverId, filter, visibility, geo, onPage), true)
        }
    }

    private suspend fun searchAll(
        post: suspend (String, JsonObject) -> JsonElement, serverId: String, filter: Filter, visibility: String?, geo: Boolean,
        onPage: (List<PhotoAsset>, Int) -> Unit,
    ): List<PhotoAsset> {
        val out = ArrayList<PhotoAsset>()
        var page: String? = "1"
        while (page != null) {
            val body = buildJsonObject {
                put("page", page.toInt())
                put("size", PAGE)
                put("order", "desc")
                put("withExif", true)
                visibility?.let { put("visibility", it) }
                if (filter.favorites) put("isFavorite", true)
                filter.albumId?.let { id -> putJsonArray("albumIds") { add(JsonPrimitive(id)) } }
                filter.personId?.let { id -> putJsonArray("personIds") { add(JsonPrimitive(id)) } }
            }
            val assets = (post("/search/metadata", body) as? JsonObject)?.get("assets") as? JsonObject ?: throw ShapeException("search")
            val items = assets["items"] as? JsonArray ?: throw ShapeException("search")
            out += items.map { searchAsset(it as? JsonObject ?: throw ShapeException("search"), serverId, geo) }
            onPage(out.toList(), assets["total"].num()?.toInt() ?: out.size)
            page = if (items.isEmpty()) null else assets["nextPage"].str()
        }
        return out
    }
}
