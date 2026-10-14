package com.wika.wicaby.core.iptv

import com.wika.wicaby.core.livetv.jsTrim
import kotlinx.serialization.Serializable
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.Locale

// IPTV playlists (M3U / M3U8 "extended"), the twin of D/shared/iptv/m3u.ts: same ids, same rules (vectors:
// tools/checks/fixtures/iptv, replayed by IptvParityTest). Lenient on purpose: a malformed line is skipped and counted,
// never fatal. Only http(s) stream URLs are kept. Fed line by line (M3uParser) so a big playlist is never split in memory.

@Serializable
data class IptvChannel(
    // Stable across refreshes (tvg-id, name and group, never the URL: an Xtream URL carries rotating credentials).
    val id: String,
    val name: String,
    val url: String,
    val number: String,
    val tvgId: String? = null,
    val tvgName: String? = null,
    val logo: String? = null,
    val group: String? = null,
    val radio: Boolean? = null,
    val userAgent: String? = null,
    val referrer: String? = null,
)

@Serializable
data class Playlist(
    // url-tvg / x-tvg-url of the #EXTM3U header (comma separated lists split), http(s) only.
    val guides: List<String>,
    val channels: List<IptvChannel>,
    val skipped: Int,
)

const val MAX_CHANNELS = 50_000
private const val MAX_LINE = 64 * 1024
private const val MAX_FIELD = 16 * 1024

// JavaScript's \s as the inside of a character class (Java's \s is ASCII only).
internal const val WS = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"

private val HTTP = Regex("^https?://[^$WS]+$", RegexOption.IGNORE_CASE)

fun isWebUrl(s: String): Boolean = s.length <= 4096 && HTTP.matches(s)

private val ATTR = Regex("([A-Za-z0-9_:-]+)[$WS]*=[$WS]*(?:\"([^\"]*)\"|'([^']*)'|([^$WS\"']+))")

/** key="value", key='value' or key=value (unquoted runs to the next space); the first of a key wins. */
fun parseAttrs(s: String): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    for (m in ATTR.findAll(s)) {
        val key = m.groupValues[1].lowercase(Locale.ROOT)
        if (key !in out) out[key] = jsTrim(m.groups[2]?.value ?: m.groups[3]?.value ?: m.groups[4]?.value ?: "").take(MAX_FIELD)
    }
    return out
}

// The comma that ends the attributes of #EXTINF: the first one outside quotes.
private fun titleComma(s: String): Int {
    var q = 0.toChar()
    for (i in s.indices) {
        val c = s[i]
        if (q != 0.toChar()) {
            if (c == q) q = 0.toChar()
        } else if (c == '"' || c == '\'') q = c
        else if (c == ',') return i
    }
    return -1
}

/** FNV-1a, 2 × 32 bits: 16 hex characters, safe as a path segment and an item id. */
fun stableId(s: String): String {
    var a = 0x811c9dc5.toInt()
    var b = 0x01000193 xor 0x5bd1e995
    for (ch in s) {
        val c = ch.code
        a = (a xor c) * 0x01000193
        b = ((b xor c) * 0x01000193) xor (b ushr 13)
    }
    return Integer.toHexString(a).padStart(8, '0') + Integer.toHexString(b).padStart(8, '0')
}

private val CHNO = Regex("^\\d{1,5}(?:\\.\\d{1,3})?$")
private val MEDIA_EXT = Regex("\\.(m3u8?|ts|mp4)\\z", RegexOption.IGNORE_CASE)
private val DATA_LOGO = Regex("^data:image/(png|jpeg|gif|webp|svg\\+xml);base64,", RegexOption.IGNORE_CASE)

private fun lastSegment(url: String): String {
    val cut = url.indexOfFirst { it == '?' || it == '#' }
    val path = (if (cut >= 0) url.substring(0, cut) else url).trimEnd('/')
    return MEDIA_EXT.replace(decodeSafe(path.substringAfterLast('/')), "")
}

private fun decodeSafe(s: String): String = decodeUriComponent(s) ?: s

/** decodeURIComponent: null where JavaScript throws (a bad escape, invalid UTF-8). '+' stays '+'. */
internal fun decodeUriComponent(s: String): String? {
    if ('%' !in s) return s
    val out = StringBuilder(s.length)
    var i = 0
    while (i < s.length) {
        if (s[i] != '%') {
            out.append(s[i++])
            continue
        }
        val bytes = ByteArrayOutputStream()
        while (i < s.length && s[i] == '%') {
            if (i + 2 >= s.length) return null
            val hi = Character.digit(s[i + 1], 16)
            val lo = Character.digit(s[i + 2], 16)
            if (hi < 0 || lo < 0) return null
            bytes.write(hi * 16 + lo)
            i += 3
        }
        val dec = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        try {
            out.append(dec.decode(ByteBuffer.wrap(bytes.toByteArray())))
        } catch (_: CharacterCodingException) {
            return null
        }
    }
    return out.toString()
}

private fun splitGuides(v: String?): List<String> = (v ?: "").split(',').map(::jsTrim).filter(::isWebUrl)

/** One playlist, line by line ([line] in order, then [finish]); parseM3u is the one-shot form. */
class M3uParser {
    private class Info(val attrs: Map<String, String>, val title: String)

    private val guides = ArrayList<String>()
    private val channels = ArrayList<IptvChannel>()
    private var skipped = 0
    private var info: Info? = null
    private var userAgent: String? = null
    private var referrer: String? = null
    private var grp: String? = null
    private val seen = HashMap<String, Int>()

    // The BOM goes with the trim (JavaScript's trim takes U+FEFF too).
    fun line(raw: String) {
        val line = jsTrim(raw)
        if (line.isEmpty()) return
        if (line.length > MAX_LINE) {
            skipped++
            info = null
            return
        }
        if (line.startsWith('#')) {
            val upper = line.take(12).uppercase(Locale.ROOT)
            when {
                upper.startsWith("#EXTM3U") -> {
                    val a = parseAttrs(line.substring(7))
                    for (g in splitGuides(a["url-tvg"]) + splitGuides(a["x-tvg-url"])) if (g !in guides) guides += g
                }
                upper.startsWith("#EXTINF:") -> {
                    // A second #EXTINF without a URL in between: the first one was malformed.
                    if (info != null) skipped++
                    val body = line.substring(8)
                    val comma = titleComma(body)
                    info = if (comma < 0) Info(parseAttrs(body), "") else Info(parseAttrs(body.substring(0, comma)), jsTrim(body.substring(comma + 1)))
                }
                upper.startsWith("#EXTVLCOPT:") -> {
                    val parts = line.substring(11).split('=')
                    val v = jsTrim(parts.drop(1).joinToString("=")).take(1024)
                    val key = jsTrim(parts[0]).lowercase(Locale.ROOT)
                    if (v.isNotEmpty() && key == "http-user-agent") userAgent = v
                    else if (v.isNotEmpty() && (key == "http-referrer" || key == "http-referer")) referrer = v
                }
                upper.startsWith("#EXTGRP:") -> grp = jsTrim(line.substring(8)).take(MAX_FIELD).ifEmpty { null }
            }
            return
        }
        // A URL line closes the entry.
        val url = line
        val entry = info
        val ua = userAgent
        val ref = referrer
        val g = grp
        info = null
        userAgent = null
        referrer = null
        grp = null
        if (!isWebUrl(url) || channels.size >= MAX_CHANNELS) {
            skipped++
            return
        }
        val a = entry?.attrs ?: emptyMap()
        fun attr(k: String) = a[k]?.ifEmpty { null }
        val tvgName = attr("tvg-name")
        val name = (entry?.title?.ifEmpty { null } ?: tvgName ?: lastSegment(url).ifEmpty { null } ?: "#${channels.size + 1}").take(200)
        val group = jsTrim((attr("group-title") ?: g ?: "").split(';')[0]).ifEmpty { null }
        val tvgId = attr("tvg-id")
        val chno = attr("tvg-chno") ?: attr("channel-number") ?: attr("tvg-num") ?: ""
        val key = "${tvgId ?: ""}|$name|${group ?: ""}"
        val n = (seen[key] ?: 0) + 1
        seen[key] = n
        val logo = (attr("tvg-logo") ?: attr("logo"))?.takeIf { isWebUrl(it) || DATA_LOGO.containsMatchIn(it) }
        channels += IptvChannel(
            id = if (n == 1) stableId(key) else "${stableId(key)}-$n", name = name, url = url, number = if (CHNO.matches(chno)) chno else "",
            tvgId = tvgId, tvgName = tvgName, logo = logo, group = group, radio = if (a["radio"] == "true") true else null, userAgent = ua, referrer = ref,
        )
    }

    fun finish(): Playlist {
        if (info != null) skipped++
        info = null
        // No tvg-chno anywhere: the playlist order is the numbering.
        val list = if (channels.none { it.number.isNotEmpty() }) channels.mapIndexed { i, c -> c.copy(number = (i + 1).toString()) } else channels.toList()
        return Playlist(guides.toList(), list, skipped)
    }
}

private val LINES = Regex("\r\n|\n|\r")

fun parseM3u(text: String): Playlist = M3uParser().apply { text.split(LINES).forEach(::line) }.finish()
