package com.wika.wicaby.core.mesh

// Diagnostics a user may paste or scan anywhere (onboarding spec 3.5): addresses, mesh keys,
// sign-in links, user codes, private hostnames, peer names and long tokens are masked. The
// desktop twin is apps/desktop/src/main/vpn/diagnostics.ts; both run
// tools/checks/fixtures/diagnostics-redact.json, so keep the rules and their order identical.

// Public provider hosts stay readable.
private val PROVIDER_HOSTS = setOf("login.tailscale.com", "controlplane.tailscale.com", "api.netbird.io", "app.netbird.io")

private val URL_RE = Regex("""\b([A-Za-z][A-Za-z0-9+.-]*)://([^\s/?#"'<>(),;]*)([^\s"'<>]*)""")
private val TSKEY = Regex("""\btskey-[A-Za-z0-9-]+""")
private val UUID_RE = Regex("""\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b""")
private val USER_CODE = Regex("""\b[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+\b""")
private val CIDR4 = Regex("""(?<![\w.])(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}/(\d{1,2})(?!\d)""")
private val IPV4 = Regex("""(?<![\w.])(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}(?!\w|\.\d)""")
private const val H = "[0-9A-Fa-f]{1,4}"
// No ':' in the lookarounds: Go errors put one right after the address ("listen fd7a::2: …") and
// Go %+v structs right before it ("{IP:fd7a::2}").
private val IPV6 = Regex("""(?<!\w)(?:$H(?::$H){7}|(?:$H(?::$H)*)?::(?:$H(?::$H)*)?)(?:/\d{1,3})?(?!\w)""")
private val HOSTNAME = Regex("""(?<![\w.-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63})(?![\w-])(:\d+)?(/[^\s"'<>]*)?""")
// redactMeshLog's 20-character floor when the run has a digit (so "X-Emby-Authorization" stays), 32 otherwise.
private val SECRET = Regex("""(?=[A-Za-z+/_-]*\d)[A-Za-z0-9+/_-]{20,}={0,2}|[A-Za-z0-9+/_-]{32,}={0,2}""")
// Credentials, the forms the desktop redact() masks, so both sides mask them alike.
// shortcut: quoted values with spaces and percent-encoded pairs are only fully masked by the
// desktop redact(); port it here if diagnostics ever carry server request logs.
private val BEARER = Regex("""(Bearer\s+)(?!\*\*\*)[^&\s"'\\]+""", RegexOption.IGNORE_CASE)
private val AUTH_SCHEME = Regex("""\b(authorization["']?\s*[=:]\s*["']?(?:Basic|Digest|Emby|MediaBrowser)\s+)(?![\w-]+\s*=|\*\*\*)[^\s,&"'\\]+""", RegexOption.IGNORE_CASE)
private val KEY_PAIR = Regex("""\b(api[_-]?key|x-emby-token|x-mediabrowser-token|access[_-]?token)(["']?\s*[=:]\s*["']?|\s+)(?!\*\*\*)[^&\s"']+""", RegexOption.IGNORE_CASE)
private val WORD_PAIR = Regex("""(token|password|secret|authorization)(["']?\s*[=:]\s*["']?)(?!(?:MediaBrowser|Emby|Bearer|Basic|Digest)\s|\*\*\*)[^&\s"']+""", RegexOption.IGNORE_CASE)

private fun hostOrMask(host: String) = if (host.lowercase().removeSuffix(".") in PROVIDER_HOSTS) host else "<host>"
private fun tail(path: String) = if (path.isNotEmpty() && path != "/") "/***" else ""

/** [names]: peer and self names, replaced by peer-1..n (one number per name, first listed first). */
fun redactDiagnostics(text: String, names: List<String> = emptyList()): String {
    val labels = LinkedHashMap<String, String>()
    for (n in names.map { it.trim() }.filter { it.isNotEmpty() }) labels.getOrPut(n.lowercase()) { "peer-${labels.size + 1}" }
    var out = text
    for ((name, label) in labels.entries.sortedByDescending { it.key.length }) {
        out = out.replace(Regex("""(?<![A-Za-z0-9_.-])${Regex.escape(name)}(?![A-Za-z0-9_-])""", RegexOption.IGNORE_CASE), label)
    }
    // redactMeshLog's rules are all here: its URL and host/path masks become URL_RE and
    // HOSTNAME (which keep provider hosts readable), its tokens SECRET (digit-free runs from 32
    // characters), its codes USER_CODE.
    return out
        .replace(BEARER, "$1***")
        .replace(AUTH_SCHEME, "$1***")
        .replace(KEY_PAIR, "$1$2***")
        .replace(WORD_PAIR, "$1$2***")
        .replace(URL_RE) { m ->
            val (scheme, authority, rest) = m.destructured
            val hostPort = authority.substringAfterLast('@')
            val bracket = if (hostPort.startsWith("[")) hostPort.indexOf(']') + 1 else 0
            val colon = hostPort.indexOf(':', bracket)
            val host = if (colon < 0) hostPort else hostPort.substring(0, colon)
            val port = if (colon < 0) "" else hostPort.substring(colon)
            "$scheme://${hostOrMask(host)}$port${tail(rest)}"
        }
        .replace(TSKEY, "tskey-***")
        .replace(UUID_RE, "***")
        .replace(USER_CODE, "***")
        .replace(CIDR4, "$1.$2.*.*/$3")
        .replace(IPV4, "$1.*.*.*")
        .replace(IPV6) { m -> val v = m.value; if (v == "::") v else v.substringBefore(':') + ":…" + (if ('/' in v) "/" + v.substringAfter('/') else "") }
        .replace(HOSTNAME) { m -> hostOrMask(m.groupValues[1]) + m.groupValues[2] + tail(m.groupValues[3]) }
        .replace(SECRET, "***")
}
