package com.wika.wicaby.core.photos

import com.wika.wicaby.core.data.Item
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

// Photos (spec PH-01): the one asset shape the photo UI reads, with the date and orientation rules. Kotlin twin of
// the desktop's renderer/lib/photos/asset.ts; tools/checks/fixtures/photos/photo-fixtures.json pins both
// (PhotoFixturesTest). minSdk 23: Calendar, no java.time.
data class PhotoAsset(
    val id: String,
    val serverId: String,
    // "photo" or "video".
    val kind: String,
    // Wall-clock "YYYY-MM-DDTHH:MM:SS", no zone (takenAt below).
    val takenAt: String,
    // Width / height as shown, after the orientation.
    val aspect: Double,
    // The client-side turn, set once the thumbnail is decoded (rotation below).
    val rotate: Int = 0,
    val durationMs: Long? = null,
    val favorite: Boolean = false,
    val thumbTag: String? = null,
    val blurHash: String? = null,
    // Only when the map is on (spec §6.1): never logged, never persisted.
    val lat: Double? = null,
    val lon: Double? = null,
)

private val WALL = Regex("""^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?""")
private val STAMP = Regex("""^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$""", RegexOption.IGNORE_CASE)

// The timeline key. PremiereDate holds the EXIF date as written: its calendar fields are taken as they are,
// whatever zone suffix comes with them (Jellyfin sends none, Emby a Z). Without one (or with a placeholder year),
// DateCreated, which both servers send in UTC, in local time. offsetMin: minutes east of UTC; the device's zone
// at that instant when left out.
fun takenAt(premiereDate: String?, dateCreated: String?, offsetMin: Int? = null): String? {
    val w = premiereDate?.let { WALL.find(it) }
    if (w != null && w.groupValues[1].toInt() > 1800) {
        val g = w.groupValues
        return "${g[1]}-${g[2]}-${g[3]}T${g[4].ifEmpty { "00" }}:${g[5].ifEmpty { "00" }}:${g[6].ifEmpty { "00" }}"
    }
    val m = dateCreated?.let { STAMP.find(it) } ?: return null
    val g = m.groupValues.map { it.ifEmpty { "0" } }
    val zone = m.groupValues[7].uppercase(Locale.ROOT).let { z ->
        if (z.isEmpty() || z == "Z") 0 else {
            val digits = z.substring(1).replace(":", "")
            (if (z[0] == '-') -1 else 1) * (digits.substring(0, 2).toInt() * 60 + digits.substring(2, 4).toInt())
        }
    }
    val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
    cal.clear()
    cal.set(g[1].toInt(), g[2].toInt() - 1, g[3].toInt(), g[4].toInt(), g[5].toInt(), g[6].toInt())
    val ms = cal.timeInMillis - zone * 60_000L
    cal.timeInMillis = ms + (offsetMin ?: (TimeZone.getDefault().getOffset(ms) / 60_000)) * 60_000L
    fun p(n: Int, w: Int = 2) = n.toString().padStart(w, '0')
    return "${p(cal.get(Calendar.YEAR), 4)}-${p(cal.get(Calendar.MONTH) + 1)}-${p(cal.get(Calendar.DAY_OF_MONTH))}" +
        "T${p(cal.get(Calendar.HOUR_OF_DAY))}:${p(cal.get(Calendar.MINUTE))}:${p(cal.get(Calendar.SECOND))}"
}

// The clockwise quarter turn an EXIF orientation asks for. shortcut: the mirrored LeftTop and RightBottom are only
// turned, not flipped (cameras do not write them); flip them too if a server ever sends one.
fun quarterTurn(orientation: String?): Int = when (orientation) {
    "RightTop", "LeftTop" -> 90
    "LeftBottom", "RightBottom" -> 270
    else -> 0
}

// Width / height as shown: swapped for a quarter turn. Else the server's PrimaryImageAspectRatio, else 3:2.
fun displayAspect(width: Int?, height: Int?, orientation: String?, primaryAspect: Double? = null): Double =
    if (width != null && height != null && width > 0 && height > 0) {
        if (quarterTurn(orientation) != 0) height.toDouble() / width else width.toDouble() / height
    } else if (primaryAspect != null && primaryAspect > 0) primaryAspect else 1.5

// Spec §3.1 orientation rule, once the thumbnail is decoded: a quarter-turn asset whose pixels still have the
// unrotated shape is turned by the client (graphicsLayer.rotationZ); pixels the server or the decoder already turned
// (shape swapped) are left alone.
fun rotation(orientation: String?, width: Int, height: Int, decodedW: Int, decodedH: Int): Int {
    val turn = quarterTurn(orientation)
    if (turn == 0 || width <= 0 || height <= 0 || decodedW <= 0 || decodedH <= 0) return 0
    return if ((width >= height) == (decodedW >= decodedH)) turn else 0
}

// A decoded tile whose shown aspect is more than 10 % off the predicted one re-lays out its row.
fun needsRelayout(predicted: Double, decodedW: Int, decodedH: Int, rotate: Int): Boolean {
    if (!(predicted > 0) || decodedW <= 0 || decodedH <= 0) return false
    val shown = if (rotate % 180 != 0) decodedH.toDouble() / decodedW else decodedW.toDouble() / decodedH
    return Math.abs(shown / predicted - 1) > 0.1
}

// An Emby/Jellyfin Photo or Video item as a timeline asset. Coordinates only with withLocation (the map is on).
fun toAsset(item: Item, offsetMin: Int? = null, withLocation: Boolean = false): PhotoAsset {
    val tag = item.imageTags["Primary"]
    val located = withLocation && item.latitude != null && item.longitude != null
    return PhotoAsset(
        id = item.id,
        serverId = item.serverId ?: "",
        kind = if (item.type == "Video" || item.mediaType == "Video") "video" else "photo",
        takenAt = takenAt(item.premiereDate, item.dateCreated, offsetMin) ?: "0001-01-01T00:00:00",
        aspect = displayAspect(item.width, item.height, item.imageOrientation, item.primaryImageAspectRatio),
        durationMs = item.runTimeTicks?.takeIf { it != 0L }?.let { it / 10_000 },
        favorite = item.userData?.isFavorite == true,
        thumbTag = tag,
        blurHash = tag?.let { item.imageBlurHashes?.get("Primary")?.get(it) },
        lat = if (located) item.latitude else null,
        lon = if (located) item.longitude else null,
    )
}
