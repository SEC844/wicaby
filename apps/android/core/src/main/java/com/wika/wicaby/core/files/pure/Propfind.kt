package com.wika.wicaby.core.files.pure

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

// mtime: milliseconds since the epoch, 0 when the server sent no usable date.
data class DavEntry(val name: String, val dir: Boolean, val size: Long, val mtime: Long)

// [self]: the folder itself, when the reply describes it. [dropped]: entries refused (another origin, outside the base,
// deeper than a child, an unsafe name): the mock's HREF-ESCAPE tag.
data class DavListing(val entries: List<DavEntry>, val self: DavEntry?, val dropped: Int)

// File sources §3.3, §7.4: a PROPFIND (Depth 1) reply read with plain text matching (any namespace prefix), never a
// DTD-aware parser. Each href is resolved against the request URL and kept only on the source's origin, under its base
// path, as a direct child of the folder asked for, through the path guard. The same rules as the desktop's
// shared/files/propfind.ts (vectors: tools/checks/fixtures/files/propfind.json).
object Propfind {
    const val MAX_BYTES = 8 * 1024 * 1024
    private const val NS = "(?:[A-Za-z][\\w.-]*:)?"
    private val RESPONSE = Regex("<${NS}response(?:\\s[^>]*)?>([\\s\\S]*?)</${NS}response\\s*>", RegexOption.IGNORE_CASE)
    private val PROPSTAT = Regex("<${NS}propstat(?:\\s[^>]*)?>([\\s\\S]*?)</${NS}propstat\\s*>", RegexOption.IGNORE_CASE)
    private val COLLECTION = Regex("<${NS}collection\\b", RegexOption.IGNORE_CASE)

    private fun tag(name: String) = Regex("<$NS$name(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</$NS$name\\s*>)", RegexOption.IGNORE_CASE)

    private fun text(body: String, name: String): String? {
        val m = tag(name).find(body) ?: return null
        return (m.groups[1]?.value ?: "").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").trim()
    }

    // decodeURIComponent: strict percent-decoding as UTF-8; null on a malformed escape or byte sequence.
    fun decode(p: String): String? {
        val out = ByteArrayOutputStream()
        var i = 0
        while (i < p.length) {
            val c = p[i]
            if (c == '%') {
                if (i + 2 >= p.length) return null
                out.write(p.substring(i + 1, i + 3).toIntOrNull(16) ?: return null)
                i += 3
            } else {
                // A whole code point (a surrogate pair stays together).
                val cp = p.codePointAt(i)
                out.write(String(Character.toChars(cp)).toByteArray(Charsets.UTF_8))
                i += Character.charCount(cp)
            }
        }
        return runCatching {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(out.toByteArray())).toString()
        }.getOrNull()
    }

    // encodeURIComponent.
    fun encode(s: String): String {
        val sb = StringBuilder()
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val c = b.toInt() and 0xff
            if (c in 'a'.code..'z'.code || c in 'A'.code..'Z'.code || c in '0'.code..'9'.code || c.toChar() in "-_.!~*'()") sb.append(c.toChar())
            else sb.append('%').append("%02X".format(c))
        }
        return sb.toString()
    }

    // The URL of [rel] under the source root [baseUrl]: each segment encoded, a trailing slash for a folder.
    fun url(baseUrl: String, rel: String, dir: Boolean): String {
        val b = baseUrl.trimEnd('/')
        if (rel.isEmpty()) return "$b/"
        return b + "/" + rel.split('/').joinToString("/") { encode(it) } + if (dir) "/" else ""
    }

    // Date.parse of an HTTP date (RFC 1123), else 0. minSdk 23: no java.time.
    private fun date(s: String?): Long {
        if (s.isNullOrEmpty()) return 0
        val f = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US).apply { timeZone = TimeZone.getTimeZone("GMT"); isLenient = false }
        return runCatching { f.parse(s)!!.time }.getOrDefault(0L)
    }

    private fun sameOrigin(a: HttpUrl, b: HttpUrl) = a.scheme == b.scheme && a.host == b.host && a.port == b.port

    // [baseUrl]: the source root (https://dav.example/media); [rel]: the folder asked for ("" = the root).
    fun parse(xml: String, baseUrl: String, rel: String): DavListing {
        val base = baseUrl.toHttpUrlOrNull() ?: return DavListing(emptyList(), null, 0)
        val basePath = (decode(base.encodedPath) ?: "").trimEnd('/')
        val requestUrl = (base.newBuilder().encodedPath("/").build().toString().trimEnd('/') + base.encodedPath.trimEnd('/') + "/" +
            rel.split('/').filter { it.isNotEmpty() }.joinToString("/") { encode(it) } + if (rel.isNotEmpty()) "/" else "").toHttpUrlOrNull()
            ?: return DavListing(emptyList(), null, 0)
        val entries = ArrayList<DavEntry>()
        var self: DavEntry? = null
        var dropped = 0
        for (r in RESPONSE.findAll(xml)) {
            val body = r.groupValues[1]
            val href = text(body, "href")
            if (href.isNullOrEmpty()) continue
            // Only the properties a 200 propstat carries.
            val props = PROPSTAT.findAll(body).map { it.groupValues[1] }.filter { p -> Regex(" 200 ").containsMatchIn(text(p, "status") ?: " 200 ") }.joinToString("\n")
            val url = requestUrl.resolve(href)
            val path = url?.let { decode(it.encodedPath) }
            if (url == null || path == null || !sameOrigin(url, base) || (path != basePath && path != "$basePath/" && !path.startsWith("$basePath/"))) {
                dropped++
                continue
            }
            val entryRel = path.substring(basePath.length).trim('/')
            val dir = COLLECTION.containsMatchIn(tag("resourcetype").find(props)?.groups?.get(1)?.value ?: "")
            val size = text(props, "getcontentlength").let { t -> if (t.isNullOrEmpty()) 0L else t.toLongOrNull()?.takeIf { it >= 0 } ?: 0L }
            val entry = DavEntry(entryRel.substringAfterLast('/'), dir, size, date(text(props, "getlastmodified")))
            if (entryRel == rel) {
                self = entry
                continue
            }
            val parent = if ('/' in entryRel) entryRel.substringBeforeLast('/') else ""
            // A deeper entry (Depth: infinity), an encoded slash or an unsafe name.
            if (parent != rel || !Ids.guard(entryRel)) {
                dropped++
                continue
            }
            entries += entry
        }
        return DavListing(entries, self, dropped)
    }
}
