package com.wika.wicaby.core.files.pure

// File sources §4.2: what a file name says when there is no NFO, the same rules as the desktop's shared/files/names.ts
// (vectors: tools/checks/fixtures/files/names.json).
data class ParsedName(
    val title: String,
    val year: Int? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val episodeEnd: Int? = null,
    // A dated episode (daily shows): YYYY-MM-DD.
    val date: String? = null,
) {
    val isEpisode get() = episode != null || date != null

    // "S1:E2" (or "S1:E2-E3", "E3", the date); "" when the name has no episode.
    val label: String
        get() {
            if (date != null) return date
            val e = episode ?: return ""
            val ep = if (episodeEnd != null) "E$e-E$episodeEnd" else "E$e"
            return if (season == null) ep else "S$season:$ep"
        }
}

object Names {
    // §4.1 allow-list: what a listing shows; everything else is hidden or a sidecar.
    val VIDEO_EXT = listOf("mkv", "mp4", "m4v", "mov", "avi", "wmv", "ts", "m2ts", "mts", "webm", "mpg", "mpeg", "ogv", "flv")

    fun extOf(name: String): String {
        val i = name.lastIndexOf('.')
        return if (i > 0) name.substring(i + 1).lowercase() else ""
    }

    fun isVideo(name: String) = extOf(name) in VIDEO_EXT

    // Release tags: everything from the first one on is cut from a title.
    private val TAG = Regex(
        "^(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr|hdr10|dv|dovi|bluray|blu-ray|bdrip|brrip|bdremux|remux|web|web-dl|webdl|webrip|hdtv|dvdrip|dvd|hdrip|" +
            "x264|x265|h264|h265|h\\.264|h\\.265|hevc|avc|xvid|divx|aac|ac3|eac3|dts|dts-hd|truehd|atmos|flac|10bit|8bit|proper|repack|extended|unrated|" +
            "remastered|internal|multi|vff|vfq|vostfr|truefrench|french|subbed|dubbed)$",
        RegexOption.IGNORE_CASE,
    )
    private const val SEP = "(?:^|[\\s._\\-\\[(])"
    private val ANIME = Regex("^\\[[^\\]]+\\]\\s*(.+?)\\s+-\\s+(\\d{1,4})(?:v\\d)?(?:\\s*[\\[(].*)?$")
    private val SXE = Regex("$SEP[Ss](\\d{1,2})[\\s._-]?[Ee](\\d{1,3})(?:[\\s._]?-?[\\s._]?[Ee]?(\\d{1,3}))?(?![\\dp])")
    private val NX = Regex("$SEP(\\d{1,2})x(\\d{2,3})(?![\\dp])")
    private val DATED = Regex("$SEP((?:19|20)\\d{2})[.\\-_ ](0[1-9]|1[0-2])[.\\-_ ](0[1-9]|[12]\\d|3[01])(?!\\d)")
    private val YEAR = Regex("$SEP((?:19|20)\\d{2})(?=$|[\\s._\\-\\])])")
    private val WITH_YEAR = Regex("^(.+?)\\s*\\(?((?:19|20)\\d{2})\\)?$")

    private fun clean(s: String): String =
        s.replace(Regex("[._]+"), " ").replace(Regex("\\s+"), " ").replace(Regex("^[\\s\\-–\\[(]+|[\\s\\-–\\[(]+$"), "").trim()

    // The words before the first release tag, and the "-GROUP" suffix off.
    private fun untag(s: String): String {
        val words = s.replace(Regex("[._]+"), " ").split(Regex("\\s+")).filter { it.isNotEmpty() }
        fun isTag(w: String): Boolean {
            val x = w.replace(Regex("^[\\[(]+|[\\])]+$"), "")
            return TAG.matches(x) || TAG.matches(x.replace(Regex("-[A-Za-z0-9]+$"), ""))
        }
        val cut = words.indexOfFirst(::isTag)
        return (if (cut < 0) words else words.take(cut)).joinToString(" ")
    }

    // A show folder named "Show (2019)" or a title ending in a year keeps the year apart.
    private fun withYear(p: ParsedName): ParsedName {
        val m = WITH_YEAR.find(p.title) ?: return p
        return p.copy(title = m.groupValues[1].trim(), year = m.groupValues[2].toInt())
    }

    fun parse(fileName: String): ParsedName {
        val ext = extOf(fileName)
        val base = if (ext.isNotEmpty() && (ext in VIDEO_EXT || ext.length <= 4)) fileName.substring(0, fileName.length - ext.length - 1) else fileName

        ANIME.find(base)?.let { return ParsedName(clean(it.groupValues[1]), episode = it.groupValues[2].toInt()) }

        SXE.find(base)?.let { m ->
            val ep = m.groupValues[2].toInt()
            val end = m.groups[3]?.value?.toInt()?.takeIf { it > ep }
            return withYear(ParsedName(clean(untag(base.substring(0, m.range.first))), season = m.groupValues[1].toInt(), episode = ep, episodeEnd = end))
        }
        NX.find(base)?.let { m ->
            return withYear(ParsedName(clean(untag(base.substring(0, m.range.first))), season = m.groupValues[1].toInt(), episode = m.groupValues[2].toInt()))
        }
        DATED.find(base)?.let { m ->
            return ParsedName(clean(untag(base.substring(0, m.range.first))), date = "${m.groupValues[1]}-${m.groupValues[2]}-${m.groupValues[3]}")
        }

        // A film: the last year before the tags, not at the very start (1917.2019 is "1917" of 2019).
        val head = untag(base)
        var title = head
        var year: Int? = null
        YEAR.findAll(head).filter { it.groups[1]!!.range.first > 0 }.lastOrNull()?.let { m ->
            year = m.groupValues[1].toInt()
            title = head.substring(0, m.groups[1]!!.range.first)
        }
        title = clean(title).ifEmpty { clean(head) }.ifEmpty { clean(base) }
        return ParsedName(title, year)
    }
}
