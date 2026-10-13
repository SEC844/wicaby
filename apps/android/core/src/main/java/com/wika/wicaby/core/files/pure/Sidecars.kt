package com.wika.wicaby.core.files.pure

// File sources §4.2: the files next to a video (or in a folder) that give it a poster, a backdrop, an NFO and
// subtitles, matched without case against the names of the same folder. The same rules as the desktop's
// shared/files/sidecars.ts (vectors: tools/checks/fixtures/files/sidecars.json).
data class SidecarSubtitle(val name: String, val language: String?, val forced: Boolean, val hearingImpaired: Boolean, val codec: String)

data class Sidecars(val poster: String? = null, val backdrop: String? = null, val nfo: String? = null, val subtitles: List<SidecarSubtitle> = emptyList())

object SidecarRules {
    private val IMAGE_EXT = listOf("jpg", "jpeg", "png", "webp")
    private val SUB_EXT = listOf("srt", "ass", "ssa", "vtt", "sub")
    private val LANG = Regex("^[a-z]{2,3}(-[a-z]{2})?$")

    private fun stem(name: String): String {
        val ext = Names.extOf(name)
        return if (ext.isNotEmpty()) name.substring(0, name.length - ext.length - 1) else name
    }

    // The first name that is <one of bases>.<image ext>, in the order of [bases].
    private fun image(names: List<String>, bases: List<String>): String? {
        for (b in bases) names.firstOrNull { stem(it).equals(b, ignoreCase = true) && Names.extOf(it) in IMAGE_EXT }?.let { return it }
        return null
    }

    // movie.nfo describes a folder (or its video) only when the folder holds one video.
    private fun movieNfo(names: List<String>) = if (names.count(Names::isVideo) == 1) names.firstOrNull { it.lowercase() == "movie.nfo" } else null

    fun folder(names: List<String>) = Sidecars(
        poster = image(names, listOf("poster", "folder", "cover")),
        backdrop = image(names, listOf("fanart", "backdrop")),
        nfo = names.firstOrNull { it.lowercase() == "tvshow.nfo" } ?: movieNfo(names),
    )

    // [names]: every entry of the video's folder.
    fun video(video: String, names: List<String>): Sidecars {
        val base = stem(video)
        val lower = base.lowercase()
        val dir = folder(names)
        val subs = names.mapNotNull { n ->
            val ext = Names.extOf(n)
            if (ext !in SUB_EXT) return@mapNotNull null
            val s = stem(n)
            if (s.lowercase() != lower && !s.lowercase().startsWith("$lower.")) return@mapNotNull null
            // <base>[.<lang>][.forced|.sdh|.cc]: tags after the base, in any order.
            val tags = s.substring(base.length).split('.').filter { it.isNotEmpty() }.map { it.lowercase() }
            SidecarSubtitle(
                n, tags.firstOrNull { LANG.matches(it) && it != "sdh" && it != "cc" }, "forced" in tags, "sdh" in tags || "cc" in tags, ext,
            )
        }.sortedBy { it.name }
        return Sidecars(
            poster = image(names, listOf("$base-poster", base)) ?: dir.poster,
            backdrop = image(names, listOf("$base-fanart")) ?: dir.backdrop,
            nfo = names.firstOrNull { it.lowercase() == "$lower.nfo" } ?: movieNfo(names),
            subtitles = subs,
        )
    }

    // Names that only serve as sidecars and never show in a listing.
    fun isSidecar(name: String) = Names.extOf(name) in IMAGE_EXT + SUB_EXT + "nfo"
}
