package com.wika.wicaby.core.comics

import kotlin.math.roundToInt

// Comic reader logic shared by the TV and mobile readers: page order, spreads, ComicInfo,
// progress ticks and image headers. Pure JVM, mirrored from src/main/comics (desktop).

// Width and height are 0 when the header could not be read; the reader measures on decode.
data class PageSize(val width: Int, val height: Int, val double: Boolean = false) {
    val known get() = width > 0 && height > 0

    // A landscape page (or one ComicInfo flags as a double page) always stands alone in a spread.
    val wide get() = double || (known && width > height)

    // width / height; unknown pages are laid out as a typical portrait page until decoded.
    val aspect: Float get() = if (known) width.toFloat() / height else 0.68f
}

data class ComicMeta(
    val title: String? = null,
    val series: String? = null,
    val number: String? = null,
    // ComicInfo Manga=YesAndRightToLeft; null when the file does not say.
    val manga: Boolean? = null,
    // ComicInfo Format=Web.
    val webtoon: Boolean = false,
)

data class ComicInfoPage(val image: Int, val deleted: Boolean, val double: Boolean, val width: Int?, val height: Int?)

// ComicInfo.xml (ComicRack / Anansi schema): only the fields the reader acts on. A regex read
// is enough for this flat format and needs no XML parser.
object ComicInfo {
    private fun decode(s: String) = s.replace(Regex("&(lt|gt|amp|quot|apos|#\\d+);")) { m ->
        when (val e = m.groupValues[1]) {
            "lt" -> "<"; "gt" -> ">"; "amp" -> "&"; "quot" -> "\""; "apos" -> "'"
            else -> e.drop(1).toIntOrNull()?.toChar()?.toString().orEmpty()
        }
    }

    private fun field(xml: String, name: String): String? =
        Regex("<$name>([^<]*)</$name>", RegexOption.IGNORE_CASE).find(xml)?.let { decode(it.groupValues[1]).trim() }?.ifEmpty { null }

    fun parse(xml: String): Pair<ComicMeta, List<ComicInfoPage>> {
        val manga = field(xml, "Manga")
        val meta = ComicMeta(
            title = field(xml, "Title"),
            series = field(xml, "Series"),
            number = field(xml, "Number"),
            manga = manga?.let { it.equals("YesAndRightToLeft", true) },
            webtoon = field(xml, "Format")?.equals("Web", true) == true,
        )
        val pages = Regex("<Page\\b([^>]*)/?>", RegexOption.IGNORE_CASE).findAll(xml).mapNotNull { m ->
            fun attr(n: String) = Regex("\\b$n=\"([^\"]*)\"", RegexOption.IGNORE_CASE).find(m.groupValues[1])?.groupValues?.get(1)
            val image = attr("Image")?.toIntOrNull() ?: return@mapNotNull null
            val type = attr("Type")?.lowercase()
            ComicInfoPage(
                image = image,
                deleted = type == "deleted" || type == "delete",
                double = attr("DoublePage").equals("true", true),
                width = attr("ImageWidth")?.toIntOrNull()?.takeIf { it > 0 },
                height = attr("ImageHeight")?.toIntOrNull()?.takeIf { it > 0 },
            )
        }.toList()
        return meta to pages
    }
}

object ComicPages {
    private val IMAGE = Regex("\\.(jpe?g|jpe|jfif|png|webp|gif|avif|bmp|heic|heif)$", RegexOption.IGNORE_CASE)

    // Page images only: no folders, macOS resource forks or hidden files (".DS_Store", "._01.jpg").
    fun isPage(name: String): Boolean =
        !name.endsWith("/") && IMAGE.containsMatchIn(name) &&
            name.split('/', '\\').none { it == "__MACOSX" || it.startsWith(".") }

    // Natural order, like Intl.Collator({numeric: true}): "2.jpg" before "10.jpg", case-insensitive.
    val natural: Comparator<String> = Comparator { a, b ->
        val x = chunks(a)
        val y = chunks(b)
        for (i in 0 until minOf(x.size, y.size)) {
            val p = x[i]
            val q = y[i]
            val c = if (p[0].isDigit() && q[0].isDigit()) {
                val pt = p.trimStart('0')
                val qt = q.trimStart('0')
                if (pt.length != qt.length) pt.length - qt.length else pt.compareTo(qt)
            } else p.lowercase().compareTo(q.lowercase())
            if (c != 0) return@Comparator c
        }
        if (x.size != y.size) x.size - y.size else a.compareTo(b)
    }

    private fun chunks(s: String): List<String> = Regex("\\d+|\\D+").findAll(s).map { it.value }.toList()

    fun order(names: List<String>): List<String> = names.filter(::isPage).sortedWith(natural)

    // Komga's pairing, as on the desktop: the cover, the last page and wide pages stand alone;
    // everything else goes two by two. Single-page mode gives one page per spread.
    fun spreads(pages: List<PageSize>, double: Boolean): List<List<Int>> {
        val out = mutableListOf<List<Int>>()
        var i = 0
        val n = pages.size
        while (i < n) {
            if (!double || i == 0 || i + 1 >= n - 1 || pages[i].wide || pages[i + 1].wide) out += listOf(i++)
            else {
                out += listOf(i, i + 1)
                i += 2
            }
        }
        return out
    }

    fun spreadOf(spreads: List<List<Int>>, page: Int): Int = spreads.indexOfFirst { page in it }.coerceAtLeast(0)

    // Long strips: ComicInfo Format=Web, or a median height/width above 2.5 (Mihon's rule).
    fun isWebtoon(meta: ComicMeta, pages: List<PageSize>): Boolean {
        if (meta.webtoon) return true
        val ratios = pages.filter { it.known }.map { it.height.toFloat() / it.width }.sorted()
        return ratios.isNotEmpty() && ratios[ratios.size / 2] > 2.5f
    }
}

// Book progress rides on PlaybackPositionTicks with the 0-based page as "milliseconds", the
// jellyfin-web comicsPlayer convention (Emby's own reader saves nothing), so clients resume
// each other's position. Never reported through Sessions/Playing: the server would mark a
// runtime-less item played and zero it.
object ComicProgress {
    const val TICKS_PER_PAGE = 10_000L

    // Small raw values written by other clients are pages already.
    fun pageFromTicks(ticks: Long?): Int = when {
        ticks == null || ticks <= 0 -> 0
        ticks >= TICKS_PER_PAGE -> (ticks.toDouble() / TICKS_PER_PAGE).roundToInt()
        else -> ticks.toInt()
    }

    fun ticks(page: Int): Long = page.coerceAtLeast(0) * TICKS_PER_PAGE

    // Where to open: the saved page, or the start of a book already read.
    fun startPage(ticks: Long?, played: Boolean, pageCount: Int): Int =
        if (played || pageCount <= 0) 0 else pageFromTicks(ticks).coerceIn(0, pageCount - 1)

    data class Update(val positionTicks: Long, val played: Boolean, val percentage: Double)

    // Reaching the last page marks the book read (and clears the position).
    fun update(page: Int, pageCount: Int): Update {
        val played = pageCount > 0 && page >= pageCount - 1
        return Update(if (played) 0 else ticks(page), played, if (played) 100.0 else 100.0 * (page + 1) / pageCount.coerceAtLeast(1))
    }

    // The UserData body (Emby UserItemDataDto, Jellyfin UpdateUserItemDataDto).
    fun json(page: Int, pageCount: Int, lastPlayedIso: String): String {
        val u = update(page, pageCount)
        val pct = "%.2f".format(java.util.Locale.ROOT, u.percentage)
        return """{"PlaybackPositionTicks":${u.positionTicks},"Played":${u.played},"PlayedPercentage":$pct,"LastPlayedDate":"$lastPlayedIso"}"""
    }
}

// Page dimensions from the first bytes of an image, so spreads and webtoon strips are laid
// out before anything is decoded. PNG, GIF, WebP and JPEG; anything else returns null.
object ImageHeader {
    private fun u16be(b: ByteArray, p: Int) = ((b[p].toInt() and 0xff) shl 8) or (b[p + 1].toInt() and 0xff)
    private fun u16le(b: ByteArray, p: Int) = (b[p].toInt() and 0xff) or ((b[p + 1].toInt() and 0xff) shl 8)
    private fun u24le(b: ByteArray, p: Int) = u16le(b, p) or ((b[p + 2].toInt() and 0xff) shl 16)
    private fun u32be(b: ByteArray, p: Int) = (u16be(b, p) shl 16) or u16be(b, p + 2)
    private fun u32le(b: ByteArray, p: Int) = u16le(b, p) or (u16le(b, p + 2) shl 16)
    private fun ascii(b: ByteArray, p: Int, n: Int) = String(b, p, n, Charsets.ISO_8859_1)

    fun size(b: ByteArray, len: Int = b.size): PageSize? {
        if (len >= 24 && u32be(b, 0) == 0x89504e47.toInt()) return PageSize(u32be(b, 16), u32be(b, 20))
        if (len >= 10 && ascii(b, 0, 3) == "GIF") return PageSize(u16le(b, 6), u16le(b, 8))
        if (len >= 30 && ascii(b, 0, 4) == "RIFF" && ascii(b, 8, 4) == "WEBP") {
            return when (ascii(b, 12, 4)) {
                "VP8X" -> PageSize(1 + u24le(b, 24), 1 + u24le(b, 27))
                "VP8L" -> u32le(b, 21).let { PageSize(1 + (it and 0x3fff), 1 + ((it ushr 14) and 0x3fff)) }
                "VP8 " -> PageSize(u16le(b, 26) and 0x3fff, u16le(b, 28) and 0x3fff)
                else -> null
            }
        }
        if (len >= 4 && (b[0].toInt() and 0xff) == 0xff && (b[1].toInt() and 0xff) == 0xd8) {
            // Walk the segments to the first SOFn frame header.
            var p = 2
            while (p + 9 < len) {
                if ((b[p].toInt() and 0xff) != 0xff) return null
                val marker = b[p + 1].toInt() and 0xff
                if (marker == 0xff) {
                    p++
                    continue
                }
                val sof = marker in 0xc0..0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc
                if (sof) return PageSize(u16be(b, p + 7), u16be(b, p + 5))
                p += 2 + u16be(b, p + 2)
            }
        }
        return null
    }
}
