package com.wika.wicaby.core.photos

import com.wika.wicaby.core.data.Item
import java.math.BigDecimal
import java.math.RoundingMode
import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.pow
import kotlin.math.roundToLong

// Photos (spec PH-01, F9): the EXIF panel's values. Twin of the desktop's renderer/lib/photos/exif.ts. The unit
// templates are the core photos_exif_*_value strings.
data class Exif(
    val make: String? = null,
    val model: String? = null,
    val software: String? = null,
    val exposureS: Double? = null,
    val focalMm: Double? = null,
    // As the server sends it: APEX on Jellyfin (TagLib's ApertureValue), unverified on Emby (gate G2).
    val apertureAv: Double? = null,
    val iso: Int? = null,
    val lat: Double? = null,
    val lon: Double? = null,
    val alt: Double? = null,
    val width: Int? = null,
    val height: Int? = null,
    val orientation: String? = null,
)

data class ExifTemplates(
    val aperture: String,
    val exposure: String,
    val focal: String,
    val iso: String,
    val dimensions: String,
    val altitude: String,
    val location: String,
)

fun exifOf(item: Item) = Exif(
    make = item.cameraMake, model = item.cameraModel, software = item.software, exposureS = item.exposureTime,
    focalMm = item.focalLength, apertureAv = item.aperture, iso = item.isoSpeedRating, lat = item.latitude,
    lon = item.longitude, alt = item.altitude, width = item.width, height = item.height, orientation = item.imageOrientation,
)

// Rounded to `digits` (the exact value, half up, as toFixed does on desktop), trailing zeros dropped, decimal
// comma in French; the sign goes on separately so both platforms round negatives alike.
private fun num(x: Double, digits: Int, lang: String): String {
    var s = BigDecimal(abs(x)).setScale(digits, RoundingMode.HALF_UP).toPlainString()
    if (digits > 0) s = s.trimEnd('0').trimEnd('.')
    if (x < 0 && s.any { it in '1'..'9' }) s = "-$s"
    return if (lang == "fr") s.replace('.', ',') else s
}

private val PLACEHOLDER = Regex("""\{(\w+)\}""")
private fun fill(tpl: String, values: Map<String, String>) = PLACEHOLDER.replace(tpl) { values[it.groupValues[1]] ?: it.value }
private fun Double?.ok(): Boolean = this != null && this.isFinite()

// [label key, value] pairs in panel order, for the fields present. Label keys: photos_exif_<key>.
// aperture: "hidden" until gate G2 confirms the server's unit (spec §3.1), "apex" or "fnumber". ShutterSpeed (APEX
// too) is never shown: ExposureTime is in seconds on both servers.
fun formatExif(e: Exif, lang: String, tpl: ExifTemplates, aperture: String = "hidden"): List<Pair<String, String>> {
    val out = mutableListOf<Pair<String, String>>()
    val make = e.make?.trim().orEmpty()
    val model = e.model?.trim().orEmpty()
    val camera = if (make.isNotEmpty() && model.isNotEmpty() && !model.lowercase(Locale.ROOT).startsWith(make.lowercase(Locale.ROOT))) "$make $model" else model.ifEmpty { make }
    if (camera.isNotEmpty()) out += "camera" to camera
    val t = e.exposureS
    if (t.ok() && t!! > 0) out += "exposure" to fill(tpl.exposure, mapOf("value" to if (t >= 0.5) num(t, 1, lang) else "1/${floor(1 / t + 0.5).roundToLong()}"))
    val av = e.apertureAv
    if (aperture != "hidden" && av.ok() && av!! > 0) out += "aperture" to fill(tpl.aperture, mapOf("value" to num(if (aperture == "apex") 2.0.pow(av / 2) else av, 1, lang)))
    val f = e.focalMm
    if (f.ok() && f!! > 0) out += "focal" to fill(tpl.focal, mapOf("value" to num(f, 1, lang)))
    if (e.iso != null && e.iso > 0) out += "iso" to fill(tpl.iso, mapOf("value" to e.iso.toString()))
    if (e.width != null && e.height != null && e.width > 0 && e.height > 0) {
        val turned = quarterTurn(e.orientation) != 0
        out += "dimensions" to fill(tpl.dimensions, mapOf("w" to "${if (turned) e.height else e.width}", "h" to "${if (turned) e.width else e.height}"))
    }
    if (e.alt.ok()) out += "altitude" to fill(tpl.altitude, mapOf("value" to num(e.alt!!, 0, lang)))
    if (e.lat.ok() && e.lon.ok()) out += "location" to fill(tpl.location, mapOf("lat" to num(e.lat!!, 4, lang), "lon" to num(e.lon!!, 4, lang)))
    val software = e.software?.trim()
    if (!software.isNullOrEmpty()) out += "software" to software
    return out
}
