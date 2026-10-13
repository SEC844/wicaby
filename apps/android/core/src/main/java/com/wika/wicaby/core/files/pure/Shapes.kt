package com.wika.wicaby.core.files.pure

// File sources §4.3, display only: the card type of a folder from its name and its children. Ids and storage never
// change. The same rules as the desktop's shared/files/shapes.ts (vectors: tools/checks/fixtures/files/shapes.json).
object Shapes {
    const val SERIES = "Series"
    const val SEASON = "Season"
    const val MOVIE = "Movie"
    const val FOLDER = "Folder"

    // "Season 2", "Saison 2", "S02".
    private val SEASON_RE = Regex("^(?:(?:season|saison)[\\s._-]*(\\d{1,3})|s(\\d{1,3}))$", RegexOption.IGNORE_CASE)
    // Extras next to a film: Example-trailer.mkv, Example.sample.mkv…
    private val EXTRA = Regex("[-._ ](trailer|sample|featurette|behindthescenes|deleted|deletedscene|interview|scene|short|extra)$", RegexOption.IGNORE_CASE)

    fun seasonNumber(folderName: String): Int? =
        SEASON_RE.find(folderName.trim())?.let { m -> (m.groups[1] ?: m.groups[2])?.value?.toInt() }

    // [children]: the folder's entries without the hidden ones, as (name, isDir). The film: the video a film folder opens.
    fun folder(name: String, children: List<Pair<String, Boolean>>): Pair<String, String?> {
        if (seasonNumber(name) != null) return SEASON to null
        if (children.any { (n, dir) -> (!dir && n.lowercase() == "tvshow.nfo") || (dir && seasonNumber(n) != null) }) return SERIES to null
        val mains = children.filter { (n, dir) -> !dir && Names.isVideo(n) && !EXTRA.containsMatchIn(n.substringBeforeLast('.')) }
        // One video (an episode alone is not a film), extras and a movie.nfo allowed.
        if (mains.size == 1 && Names.parse(mains[0].first).episode == null) return MOVIE to mains[0].first
        return FOLDER to null
    }

    // Default order of the files in a folder: episodes by season and number first, then the rest; the caller breaks
    // ties with the natural sort.
    val episodeOrder = Comparator<String> { a, b ->
        val pa = Names.parse(a)
        val pb = Names.parse(b)
        val ea = pa.episode != null
        val eb = pb.episode != null
        when {
            ea != eb -> if (ea) -1 else 1
            !ea -> 0
            else -> ((pa.season ?: 0) - (pb.season ?: 0)).takeIf { it != 0 } ?: (pa.episode!! - pb.episode!!)
        }
    }
}
