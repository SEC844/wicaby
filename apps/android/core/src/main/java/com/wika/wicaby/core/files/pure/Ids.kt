package com.wika.wicaby.core.files.pure

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.text.Normalizer

// File sources §0 D3, §7.4: item ids and the path guard, the same rule as the desktop's shared/files/ids.ts
// (vectors: tools/checks/fixtures/files/paths.json, FilesVectorsTest). An id is "p." + base64url (no padding) of the
// UTF-8 path relative to the source root; the root is "p.". Nothing maps ids to paths, and every decode is guarded.
object Ids {
    const val ROOT = "p."
    const val MAX_REL_BYTES = 4096
    // As on the desktop (ids travel in IPC paths there): a deeper path gets no id and is left out of listings.
    const val MAX_ID_REL_BYTES = 750
    private val FILES_ID = Regex("^p\\.[A-Za-z0-9_-]{0,1000}$")
    // Windows device names, alone or with an extension (CON.txt still opens the console).
    private val DEVICE = Regex("^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\\$|conout\\$)(\\..*)?$", RegexOption.IGNORE_CASE)
    // Control characters, the backslash and ':' (alternate data streams, drive letters).
    private val BAD_CHARS = Regex("[\\x00-\\x1f\\x7f\\\\:]")
    // An encoded dot, slash, backslash or NUL: no file name needs one, and a layer that decodes would see "..".
    private val ENCODED = Regex("%(2e|2f|5c|00)", RegexOption.IGNORE_CASE)

    private fun loneSurrogate(s: String): Boolean {
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1])) i += 2
            else if (Character.isSurrogate(c)) return true
            else i++
        }
        return false
    }

    // "" is the root. "/"-separated; no empty, "." or ".." segment; no "\", NUL, control character or ":"; no Windows
    // device name or encoded dot, slash, backslash or NUL; NFC; at most 4,096 bytes of UTF-8.
    fun guard(rel: String): Boolean {
        if (rel.isEmpty()) return true
        if (!Normalizer.isNormalized(rel, Normalizer.Form.NFC)) return false
        if (rel.toByteArray(Charsets.UTF_8).size > MAX_REL_BYTES) return false
        if (BAD_CHARS.containsMatchIn(rel)) return false
        return rel.split('/').all(::segmentOk)
    }

    fun segmentOk(s: String): Boolean =
        s.isNotEmpty() && s != "." && s != ".." && !DEVICE.matches(s) && !ENCODED.containsMatchIn(s) && !BAD_CHARS.containsMatchIn(s) && !loneSurrogate(s)

    // The id of a guarded path, or null (unsafe, or too long to address).
    fun encode(rel: String): String? {
        if (!guard(rel)) return null
        val bytes = rel.toByteArray(Charsets.UTF_8)
        return if (bytes.size > MAX_ID_REL_BYTES) null else ROOT + B64.encode(bytes)
    }

    // The guarded path of an id, or null. Only the canonical encoding is accepted (one id per path).
    fun decode(id: String): String? {
        if (!FILES_ID.matches(id)) return null
        val bytes = B64.decode(id.substring(2)) ?: return null
        val rel = runCatching {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString()
        }.getOrNull() ?: return null
        return rel.takeIf { guard(it) && encode(it) == id }
    }

    // [parent]/[name], or null when that path would not pass the guard.
    fun child(parent: String, name: String): String? {
        if (name.isEmpty() || '/' in name) return null
        return (if (parent.isEmpty()) name else "$parent/$name").takeIf(::guard)
    }

    // null for the root itself.
    fun parent(rel: String): String? = if (rel.isEmpty()) null else rel.substringBeforeLast('/', "")

    fun name(rel: String): String = rel.substringAfterLast('/')

    // Root first, then each folder down to [rel]: (id, name); "" names the root.
    fun crumbs(rel: String): List<Pair<String, String>> {
        val out = mutableListOf(ROOT to "")
        if (rel.isEmpty()) return out
        val segs = rel.split('/')
        segs.forEachIndexed { i, name -> encode(segs.take(i + 1).joinToString("/"))?.let { out += it to name } }
        return out
    }
}

// base64url without padding (RFC 4648 §5). minSdk 23: java.util.Base64 is API 26, android.util.Base64 is not on the JVM.
object B64 {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    fun encode(b: ByteArray): String {
        val sb = StringBuilder((b.size * 4 + 2) / 3)
        var i = 0
        while (i < b.size) {
            val n = minOf(3, b.size - i)
            var v = 0
            for (k in 0 until 3) v = (v shl 8) or (if (k < n) b[i + k].toInt() and 0xff else 0)
            for (k in 0..n) sb.append(ALPHABET[(v shr (18 - 6 * k)) and 0x3f])
            i += 3
        }
        return sb.toString()
    }

    // null for a character outside the alphabet or a length no encoder writes (4n + 1).
    fun decode(s: String): ByteArray? {
        if (s.length % 4 == 1) return null
        val out = java.io.ByteArrayOutputStream(s.length * 3 / 4)
        var v = 0
        var bits = 0
        for (c in s) {
            val d = ALPHABET.indexOf(c)
            if (d < 0) return null
            v = (v shl 6) or d
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write((v shr bits) and 0xff)
            }
        }
        return out.toByteArray()
    }
}
