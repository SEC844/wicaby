package com.wika.wicaby.core.files.pure

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

// What the Add sheet accepts, normalised; user:pass@ moves to the credential fields. url never holds user info, a
// query or a fragment: https://dav.example/media, smb://STORAGE/media/sub.
data class ParsedSource(val protocol: String, val url: String, val user: String? = null, val pass: String? = null)

// File sources §6.1, §7.2: source addresses, the same rules as the desktop's shared/files/urls.ts
// (vectors: tools/checks/fixtures/files/urls.json).
object Urls {
    private val SMB_HOST = Regex("^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\\[[0-9A-Fa-f:.]+\\]$")
    private val SEG_BAD = Regex("[\\x00-\\x1f\\x7f<>:\"|?*\\\\]")
    private val SCHEME = Regex("^([a-z][a-z0-9+.-]*)://", RegexOption.IGNORE_CASE)
    private val ALIAS = mapOf("dav" to "http", "webdav" to "http", "davs" to "https", "webdavs" to "https")

    // User info, query and fragment dropped: what a log line or a message may show.
    fun redact(url: String): String =
        url.replace(Regex("^([a-z][a-z0-9+.-]*://)[^/?#]*@", RegexOption.IGNORE_CASE), "$1").replace(Regex("[?#][\\s\\S]*$"), "")

    // https://…, http://…, dav(s)://, webdav(s):// (aliases of http(s)), smb://HOST/share[/sub], \\HOST\share[\sub]
    // and HOST/share. null for anything else (SMB takes no port: 445 only).
    fun parse(input: String): ParsedSource? {
        var raw = input.trim()
        // A dot segment would be resolved away by a URL parser: refused as typed instead.
        if (raw.isEmpty() || raw.length > 2048 || Regex("(^|[\\\\/])\\.\\.?([\\\\/]|$)").containsMatchIn(raw.replace(SCHEME, ""))) return null
        if (raw.startsWith("\\\\")) raw = "smb://" + raw.substring(2).replace('\\', '/')
        val scheme = SCHEME.find(raw)?.groupValues?.get(1)?.lowercase()
        if (scheme == null) raw = "smb://" + raw.trimStart('/')
        ALIAS[scheme]?.let { raw = it + raw.substring(scheme!!.length) }
        val s = SCHEME.find(raw)?.groupValues?.get(1)?.lowercase()
        if (s == "http" || s == "https") {
            val u = raw.toHttpUrlOrNull() ?: return null
            val user = u.username.takeIf { it.isNotEmpty() }
            val pass = u.password.takeIf { it.isNotEmpty() }
            val host = if (':' in u.host) "[${u.host}]" else u.host
            val port = if (u.port != (if (u.scheme == "https") 443 else 80)) ":${u.port}" else ""
            return ParsedSource("webdav", "${u.scheme}://$host$port${u.encodedPath.trimEnd('/')}", user, pass)
        }
        if (s != "smb") return null
        val rest = raw.substring("smb://".length)
        val authority = rest.substringBefore('/').substringBefore('?').substringBefore('#')
        val userInfo = if ('@' in authority) authority.substringBeforeLast('@') else null
        val host = authority.substringAfterLast('@')
        if (!SMB_HOST.matches(host)) return null
        val path = rest.substring(authority.length).substringBefore('?').substringBefore('#')
        val segs = path.split('/').filter { it.isNotEmpty() }.map { Propfind.decode(it) }
        if (segs.isEmpty() || segs.any { it == null || it == "." || it == ".." || SEG_BAD.containsMatchIn(it) }) return null
        val user = userInfo?.substringBefore(':')?.let { Propfind.decode(it) }?.takeIf { it.isNotEmpty() }
        val pass = userInfo?.takeIf { ':' in it }?.substringAfter(':')?.let { Propfind.decode(it) }?.takeIf { it.isNotEmpty() }
        return ParsedSource("smb", "smb://$host/" + segs.joinToString("/") { Propfind.encode(it!!) }, user, pass)
    }

    // \\HOST\share\sub plus [rel]; null when [smbUrl] is not smb://.
    fun unc(smbUrl: String, rel: String = ""): String? {
        val m = Regex("^smb://([^/]+)/(.+)$").find(smbUrl) ?: return null
        val segs = m.groupValues[2].split('/').map { Propfind.decode(it) ?: return null }
        val tail = if (rel.isEmpty()) emptyList() else rel.split('/')
        return "\\\\${m.groupValues[1]}\\" + (segs + tail).joinToString("\\")
    }

    // What the UI shows next to the name: dav.example/media, \\STORAGE\media, or a local path as is.
    fun display(url: String): String {
        if (url.startsWith("smb://")) return unc(url) ?: url
        if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(url)) {
            val u = url.toHttpUrlOrNull() ?: return redact(url)
            val host = if (':' in u.host) "[${u.host}]" else u.host
            val port = if (u.port != (if (u.scheme == "https") 443 else 80)) ":${u.port}" else ""
            val p = u.encodedPath.trimEnd('/')
            return "$host$port${Propfind.decode(p) ?: p}"
        }
        return url
    }

    // The default name: the last path segment, else the share or the host.
    fun defaultName(url: String): String {
        val shown = display(url).trimEnd('\\', '/')
        return shown.split('\\', '/').lastOrNull { it.isNotEmpty() } ?: shown
    }
}
