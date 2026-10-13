package com.wika.wicaby.core.plex

import kotlinx.serialization.json.JsonElement

// Plex image paths ↔ Emby image routes (plex-spec §2, §4), the twin of desktop shared/plex/images.ts. The apps keep
// building /Items/{id}/Images/{type}?tag=…; imagePaths() gives the adapter '{id}/{type}' → the PMS path, and
// transcodePath() turns a request back into a PMS /photo/:/transcode URL. The tag is the PMS path's last segment.
object PlexImages {
    val TYPES = listOf("Primary", "Backdrop", "Thumb", "Logo", "Banner")
    private val TAG = Regex("^[A-Za-z0-9._-]{1,64}$")
    private val ROUTE = Regex("^/Items/([A-Za-z0-9-]{1,64})/Images/(Primary|Backdrop|Thumb|Logo|Banner)(?:/\\d+)?$")
    private val ABSOLUTE = Regex("^https?://", RegexOption.IGNORE_CASE)

    // A PMS path's timestamp segment; a URL (people's thumbs on the Plex CDN) gets a short stable FNV-1a hash.
    fun imageTag(path: String?): String? {
        if (path.isNullOrEmpty()) return null
        if (ABSOLUTE.containsMatchIn(path)) {
            var h = 0x811c9dc5.toInt()
            for (c in path) h = (h xor c.code) * 0x01000193
            return (h.toLong() and 0xffffffffL).toString(16).padStart(8, '0')
        }
        val seg = path.split('?')[0].split('/').lastOrNull { it.isNotEmpty() }
        return seg?.takeIf { TAG.matches(it) }
    }

    private fun imageOf(meta: JsonElement?, type: String): String? = meta["Image"].list().firstOrNull { it["type"].str() == type }?.get("url").str()

    // '{itemId}/{ImageType}' → PMS path, for the item and the parents its card or page shows.
    fun imagePaths(meta: JsonElement?): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        fun set(id: String?, type: String, path: String?) {
            if (!id.isNullOrEmpty() && !path.isNullOrEmpty()) out["$id/$type"] = path
        }
        val id = meta["ratingKey"].str()
        set(id, "Primary", imageOf(meta, "coverPoster") ?: imageOf(meta, "snapshot") ?: meta["thumb"].str())
        set(id, "Backdrop", imageOf(meta, "background") ?: meta["art"].str())
        set(id, "Logo", imageOf(meta, "clearLogo"))
        set(meta["parentRatingKey"].str(), "Primary", meta["parentThumb"].str())
        set(meta["grandparentRatingKey"].str(), "Primary", meta["grandparentThumb"].str())
        set(meta["grandparentRatingKey"].str(), "Backdrop", meta["grandparentArt"].str())
        for (p in meta["Role"].list() + meta["Director"].list() + meta["Writer"].list()) {
            p["id"].str()?.let { set("person-$it", "Primary", p["thumb"].str()) }
        }
        return out
    }

    data class ImageRoute(val id: String, val type: String)

    // Emby image route → its parts, or null. An index is accepted and ignored (Plex has one image per type).
    fun parseImageRoute(path: String): ImageRoute? = ROUTE.find(path)?.let { ImageRoute(it.groupValues[1], it.groupValues[2]) }

    // Emby image query (maxWidth, fillHeight…, any case) → a PMS photo transcode path. Without a size: 1920 wide for
    // a backdrop, 600 for anything else.
    fun transcodePath(pmsPath: String, type: String, query: Map<String, String> = emptyMap()): String {
        val q = HashMap<String, String>()
        for ((k, v) in query) if (v.isNotEmpty()) q[k.lowercase()] = v
        fun num(vararg keys: String): Int {
            for (k in keys) {
                val n = jsRound(jsNumber(q[k] ?: continue))
                if (n > 0) return minOf(n, 4096.0).toInt()
            }
            return 0
        }
        // Emby fill* covers the box (PMS minSize=1); max*, width and height fit inside it (minSize=0).
        val fill = num("fillwidth", "fillheight") > 0
        var width = num("fillwidth", "maxwidth", "width")
        var height = num("fillheight", "maxheight", "height")
        if (width == 0 && height == 0) width = if (type == "Backdrop") 1920 else 600
        // PMS needs both sides: the missing one is set so the given one decides (tiny to cover, large to fit).
        if (width == 0) width = if (fill) 1 else height * 4
        if (height == 0) height = if (fill) 1 else width * 4
        val quality = num("quality")
        val out = linkedMapOf("url" to pmsPath, "width" to "$width", "height" to "$height", "minSize" to if (fill) "1" else "0", "upscale" to "1")
        if (quality != 0) out["quality"] = "${minOf(quality, 100)}"
        return "/photo/:/transcode?" + formEncode(out)
    }
}
