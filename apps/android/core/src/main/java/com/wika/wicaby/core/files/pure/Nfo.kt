package com.wika.wicaby.core.files.pure

// File sources §4.2: a Kodi-style NFO (or a bare IMDb/TMDB link) read with plain text matching, never an XML parser:
// no DTD, no entity beyond the five XML ones and numeric references. The same rules as the desktop's
// shared/files/nfo.ts (vectors: tools/checks/fixtures/files/nfo.json). The caller caps the input at MAX_BYTES.
data class NfoInfo(
    val kind: String, // movie, episode, tvshow or url
    val title: String? = null,
    val year: Int? = null,
    val plot: String? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val runtimeMin: Int? = null,
    val genres: List<String> = emptyList(),
    val providerIds: Map<String, String> = emptyMap(),
)

object Nfo {
    const val MAX_BYTES = 256 * 1024
    private val ROOT = Regex("<(movie|episodedetails|tvshow)(?:\\s[^>]*)?>([\\s\\S]*?)</\\1>", RegexOption.IGNORE_CASE)
    private val UNIQUE = Regex("<uniqueid\\s[^>]*type\\s*=\\s*[\"']([a-z]+)[\"'][^>]*>([^<]{1,64})</uniqueid>", RegexOption.IGNORE_CASE)
    private val ID = Regex("^[A-Za-z0-9_-]{1,32}$")

    private fun safeChar(cp: Int, fallback: String) =
        if (cp > 0 && cp <= 0x10ffff && cp !in 0xd800..0xdfff) String(Character.toChars(cp)) else fallback

    private fun decode(s: String): String = s
        .replace(Regex("<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>")) { it.groupValues[1] }
        .replace(Regex("&#x([0-9a-f]{1,6});", RegexOption.IGNORE_CASE)) { safeChar(it.groupValues[1].toInt(16), it.value) }
        .replace(Regex("&#(\\d{1,7});")) { safeChar(it.groupValues[1].toInt(), it.value) }
        .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
        .trim()

    // The text of every <tag …>text</tag> in [body], decoded, empty ones left out.
    private fun all(body: String, tag: String): List<String> =
        Regex("<$tag(?:\\s[^>]*)?>([\\s\\S]*?)</$tag>", RegexOption.IGNORE_CASE).findAll(body).map { decode(it.groupValues[1]) }.filter { it.isNotEmpty() }.toList()

    private fun first(body: String, tag: String) = all(body, tag).firstOrNull()

    private fun int(v: String?) = v?.takeIf { Regex("^\\d{1,6}$").matches(it) }?.toInt()

    // null when it is neither an NFO document nor a bare IMDb/TMDB link.
    fun parse(text: String): NfoInfo? {
        val root = ROOT.find(text)
        if (root == null) {
            val imdb = Regex("\\b(tt\\d{7,9})\\b").find(text)?.groupValues?.get(1)
            val tmdb = Regex("themoviedb\\.org/(?:movie|tv)/(\\d{1,9})").find(text)?.groupValues?.get(1)
            if (imdb == null && tmdb == null) return null
            return NfoInfo("url", providerIds = buildMap { imdb?.let { put("Imdb", it) }; tmdb?.let { put("Tmdb", it) } })
        }
        val kind = when (root.groupValues[1].lowercase()) { "movie" -> "movie"; "tvshow" -> "tvshow"; else -> "episode" }
        val body = root.groupValues[2]
        val year = int(first(body, "year")) ?: int(Regex("^(\\d{4})-").find(first(body, "premiered") ?: first(body, "aired") ?: "")?.groupValues?.get(1))
        val ids = LinkedHashMap<String, String>()
        for (m in UNIQUE.findAll(body)) {
            val name = when (m.groupValues[1].lowercase()) { "imdb" -> "Imdb"; "tmdb" -> "Tmdb"; "tvdb" -> "Tvdb"; else -> null } ?: continue
            if (name !in ids) ids[name] = decode(m.groupValues[2])
        }
        val imdb = first(body, "imdbid") ?: first(body, "imdb_id") ?: first(body, "id")?.takeIf { Regex("^tt\\d{7,9}$").matches(it) }
        if (imdb != null && "Imdb" !in ids) ids["Imdb"] = imdb
        first(body, "tmdbid")?.let { if ("Tmdb" !in ids) ids["Tmdb"] = it }
        return NfoInfo(
            kind = kind,
            title = first(body, "title"),
            year = year?.takeIf { it in 1870..2200 },
            plot = first(body, "plot") ?: first(body, "outline"),
            season = int(first(body, "season")),
            episode = int(first(body, "episode")),
            runtimeMin = int(first(body, "runtime"))?.takeIf { it != 0 },
            genres = all(body, "genre").take(20),
            providerIds = ids.filterValues { ID.matches(it) },
        )
    }
}
