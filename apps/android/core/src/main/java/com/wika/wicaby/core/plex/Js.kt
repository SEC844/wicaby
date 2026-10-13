package com.wika.wicaby.core.plex

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.abs
import kotlin.math.floor

// The Plex dialect reads PMS JSON and writes Emby JSON as plain JsonElements, so the Kotlin twin of
// apps/desktop/src/shared/plex/*.ts answers tools/checks/fixtures/plex/*.json exactly. These helpers give the few
// JavaScript semantics the TypeScript relies on (String(v), Number(v), truthiness, `??` on null and undefined).

internal typealias Obj = MutableMap<String, JsonElement>

internal fun obj(): Obj = LinkedHashMap()

internal fun Obj.json(): JsonObject = JsonObject(this)

// A field, with JSON null read as missing (TypeScript `??` treats both alike).
internal operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)?.takeUnless { it is JsonNull }

internal fun JsonElement?.list(): List<JsonElement> = (this as? JsonArray) ?: emptyList()

internal fun JsonElement?.objs(): List<JsonObject> = list().filterIsInstance<JsonObject>()

internal fun JsonElement?.isNum(): Boolean =
    this is JsonPrimitive && this !is JsonNull && !isString && content != "true" && content != "false" && content.toDoubleOrNull() != null

internal fun JsonElement?.isStr(): Boolean = this is JsonPrimitive && isString

internal fun JsonElement?.num(): Double? = if (isNum()) (this as JsonPrimitive).content.toDouble() else null

// String(v) for a primitive; null for null and undefined.
internal fun JsonElement?.str(): String? = when {
    this == null || this is JsonNull -> null
    this is JsonPrimitive && isNum() -> jsNumberText(content.toDouble())
    this is JsonPrimitive -> content
    else -> null
}

internal fun jsNumberText(d: Double): String = if (d == floor(d) && abs(d) < 1e15) d.toLong().toString() else d.toString()

// JavaScript truthiness.
internal fun JsonElement?.truthy(): Boolean = when {
    this == null || this is JsonNull -> false
    this is JsonPrimitive && isString -> content.isNotEmpty()
    this is JsonPrimitive && content == "true" -> true
    this is JsonPrimitive && content == "false" -> false
    this is JsonPrimitive -> content.toDoubleOrNull()?.let { it != 0.0 && !it.isNaN() } ?: false
    else -> true
}

internal fun JsonElement?.isFalse(): Boolean = this is JsonPrimitive && !isString && content == "false"

internal fun JsonElement?.isTrue(): Boolean = this is JsonPrimitive && !isString && content == "true"

// Number(v): NaN for undefined and for text that is not a number.
internal fun JsonElement?.jsNumber(): Double = when {
    this == null -> Double.NaN
    this is JsonNull -> 0.0
    this is JsonPrimitive && isString -> jsNumber(content)
    this is JsonPrimitive && content == "true" -> 1.0
    this is JsonPrimitive && content == "false" -> 0.0
    this is JsonPrimitive -> content.toDoubleOrNull() ?: Double.NaN
    else -> Double.NaN
}

private val DECIMAL = Regex("^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?$")

internal fun jsNumber(s: String?): Double {
    if (s == null) return Double.NaN
    val t = s.trim()
    return when {
        t.isEmpty() -> 0.0
        DECIMAL.matches(t) -> t.toDouble()
        t == "Infinity" || t == "+Infinity" -> Double.POSITIVE_INFINITY
        t == "-Infinity" -> Double.NEGATIVE_INFINITY
        t.startsWith("0x", true) -> t.drop(2).toLongOrNull(16)?.toDouble() ?: Double.NaN
        else -> Double.NaN
    }
}

// `Number(x) || 0`.
internal fun orZero(d: Double): Double = if (d.isNaN()) 0.0 else d

// Math.round: half up.
internal fun jsRound(d: Double): Double = floor(d + 0.5)

// A number as JSON: integral values without a fraction, as JavaScript writes them.
internal fun jn(d: Double): JsonPrimitive = if (d == floor(d) && abs(d) < 1e15) JsonPrimitive(d.toLong()) else JsonPrimitive(d)

internal fun jn(n: Long): JsonPrimitive = JsonPrimitive(n)

internal fun js(s: String): JsonPrimitive = JsonPrimitive(s)

internal fun jb(b: Boolean): JsonPrimitive = JsonPrimitive(b)

internal fun jarr(list: List<JsonElement>): JsonArray = JsonArray(list)

internal fun jstrs(list: List<String>): JsonArray = JsonArray(list.map(::JsonPrimitive))

// A query or a header map as a JSON object.
internal fun Map<String, String>.toJson(): JsonObject = JsonObject(mapValues { JsonPrimitive(it.value) })

// The Emby query the apps send ({key: value}): String(v) of each value, null and "" left out.
internal fun JsonObject?.toQuery(): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    for ((k, v) in this ?: return out) v.str()?.let { out[k] = it }
    return out
}

// decodeURIComponent, lenient: a malformed escape stays as it is.
internal fun pctDecode(s: String): String {
    if ('%' !in s) return s
    val out = java.io.ByteArrayOutputStream()
    var i = 0
    while (i < s.length) {
        val c = s[i]
        if (c == '%' && i + 3 <= s.length &&s.substring(i + 1, i + 3).all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }) {
            out.write(s.substring(i + 1, i + 3).toInt(16))
            i += 3
        } else {
            out.write(c.toString().toByteArray(Charsets.UTF_8))
            i++
        }
    }
    return out.toString(Charsets.UTF_8.name())
}

// URLSearchParams serialisation (application/x-www-form-urlencoded): what java.net.URLEncoder writes.
internal fun formEncode(pairs: Map<String, String>): String =
    pairs.entries.joinToString("&") { (k, v) -> java.net.URLEncoder.encode(k, "UTF-8") + "=" + java.net.URLEncoder.encode(v, "UTF-8") }
