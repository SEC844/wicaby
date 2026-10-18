package com.wika.wicaby.core.comics

import java.io.File
import java.io.IOException
import java.io.InputStream

// Comic book formats: which reader a file goes to and EPUB's reading order. Pure JVM, mirrored from
// desktop src/main/comics/formats.ts (comic-formats-check keeps the extension lists equal).
enum class ComicFormat { ZIP, EPUB, RAR, SEVEN_Z, TAR, PDF }

// A book the reader refuses for a reason it can name (Comics maps it to a message).
class ComicRefused(val reason: Reason, detail: String = reason.name) : IOException(detail) {
    enum class Reason { ENCRYPTED, TEXT_BOOK, TOO_LARGE }
}

object ComicFormats {
    private val BY_EXT = mapOf(
        "cbz" to ComicFormat.ZIP, "zip" to ComicFormat.ZIP, "epub" to ComicFormat.EPUB,
        "cbr" to ComicFormat.RAR, "rar" to ComicFormat.RAR, "cb7" to ComicFormat.SEVEN_Z, "7z" to ComicFormat.SEVEN_Z,
        "cbt" to ComicFormat.TAR, "tar" to ComicFormat.TAR, "pdf" to ComicFormat.PDF,
    )

    // Extensions the reader opens (lower case, no dot).
    val EXTS: Set<String> = BY_EXT.keys

    fun ofExt(ext: String): ComicFormat? = BY_EXT[ext.lowercase()]

    // The first bytes of the file (1 KiB is plenty; tar needs 262). null: not a book format we read.
    fun sniff(head: ByteArray): ComicFormat? {
        fun at(s: String, o: Int = 0) = head.size >= o + s.length && String(head, o, s.length, Charsets.ISO_8859_1) == s
        if (at("PK\u0003\u0004") || at("PK\u0005\u0006")) return if (at("mimetypeapplication/epub+zip", 30)) ComicFormat.EPUB else ComicFormat.ZIP
        if (at("Rar!\u001a\u0007")) return ComicFormat.RAR
        if (at("7z\u00bc\u00af\u0027\u001c")) return ComicFormat.SEVEN_Z
        if (at("ustar", 257)) return ComicFormat.TAR
        // PDF allows junk before the header within the first 1 KiB.
        if (String(head, 0, minOf(head.size, 1024), Charsets.ISO_8859_1).contains("%PDF-")) return ComicFormat.PDF
        return null
    }

    fun sniff(file: File): ComicFormat? = sniff(file.inputStream().use { readUpTo(it, 1024) })

    // An archive entry name turned into a flat file name inside the extraction folder: index first (unique),
    // then the path with separators flattened, so the folder sorts like the archive. Nothing climbs out.
    fun flatName(index: Int, name: String): String {
        val safe = name.replace(Regex("^[a-zA-Z]:"), "")
            .split(Regex("[\\\\/]+"))
            .filter { it.isNotEmpty() && it != "." && it != ".." }
            .joinToString("~")
            .replace(Regex("[\\x00-\\x1f<>:\"|?*]"), "_")
            .takeLast(120)
        return "$index#$safe"
    }

    // The archive name back from a flatName (page order, ComicInfo lookup).
    fun archiveName(flat: String): String = flat.substring(flat.indexOf('#') + 1).replace('~', '/')

    fun readUpTo(s: InputStream, max: Int): ByteArray {
        val buf = ByteArray(max)
        var n = 0
        while (n < max) {
            val r = s.read(buf, n, max - n)
            if (r < 0) break
            n += r
        }
        return buf.copyOf(n)
    }

    // ---- EPUB (fixed-layout comics: one image per spine page) ----

    class EpubPackage(val title: String?, val spine: List<String>, val cover: String?, val fixedLayout: Boolean)

    private fun attr(tag: String, name: String): String? =
        Regex("\\s$name\\s*=\\s*(\"([^\"]*)\"|'([^']*)')", RegexOption.IGNORE_CASE).find(tag)?.let { it.groups[2]?.value ?: it.groups[3]?.value }

    private fun decode(s: String) = s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")

    // %XX escapes as UTF-8 (URLDecoder would also turn '+' into a space).
    private fun unescape(s: String) = Regex("(%[0-9A-Fa-f]{2})+").replace(s) { m ->
        String(m.value.chunked(3).map { it.substring(1).toInt(16).toByte() }.toByteArray(), Charsets.UTF_8)
    }

    // Zip paths are relative to the archive root, with forward slashes (path.posix.normalize + join).
    private fun resolve(from: String, href: String): String {
        val out = ArrayList<String>()
        val joined = from.substringBeforeLast('/', "") + "/" + unescape(decode(href).substringBefore('#'))
        for (p in joined.split('/')) {
            when {
                p.isEmpty() || p == "." -> Unit
                p == ".." && out.isNotEmpty() && out.last() != ".." -> out.removeAt(out.lastIndex)
                else -> out += p
            }
        }
        return out.joinToString("/")
    }

    // META-INF/container.xml -> the package document's path.
    fun epubRootfile(container: String): String? =
        Regex("<(?:\\w+:)?rootfile\\b[^>]*>", RegexOption.IGNORE_CASE).find(container)?.value?.let { attr(it, "full-path") }?.let(::decode)

    fun epubPackage(opf: String, opfPath: String): EpubPackage {
        class Item(val href: String, val props: String)
        val items = LinkedHashMap<String, Item>()
        for (m in Regex("<(?:\\w+:)?item\\b[^>]*>", RegexOption.IGNORE_CASE).findAll(opf)) {
            val id = attr(m.value, "id")
            val href = attr(m.value, "href")
            if (id != null && href != null) items[id] = Item(resolve(opfPath, href), attr(m.value, "properties").orEmpty())
        }
        val spine = Regex("<(?:\\w+:)?itemref\\b[^>]*>", RegexOption.IGNORE_CASE).findAll(opf)
            .filter { attr(it.value, "linear") != "no" }
            .mapNotNull { items[attr(it.value, "idref").orEmpty()]?.href }.toList()
        val coverId = Regex("<(?:\\w+:)?meta\\b[^>]*>", RegexOption.IGNORE_CASE).findAll(opf).map { it.value }.firstOrNull { attr(it, "name") == "cover" }
        val cover = items.values.firstOrNull { "cover-image" in it.props.split(Regex("\\s+")) }?.href
            ?: items[coverId?.let { attr(it, "content") }.orEmpty()]?.href
        val title = Regex("<dc:title\\b[^>]*>([^<]*)</dc:title>", RegexOption.IGNORE_CASE).find(opf)?.groupValues?.get(1)?.trim()
        val fixed = Regex("rendition:layout\"?\\s*>\\s*pre-paginated|rendition:layout\\s*=\\s*\"pre-paginated\"", RegexOption.IGNORE_CASE).containsMatchIn(opf)
        return EpubPackage(title?.ifEmpty { null }?.let(::decode), spine, cover, fixed)
    }

    // The page image a spine document shows: its first <img src> or SVG <image href>. null: a text page, that is
    // no image, or (in a reflowable book) more than a caption's worth of text beside it.
    fun epubPageImage(xhtml: String, docPath: String, fixedLayout: Boolean): String? {
        val body = Regex("<body\\b[\\s\\S]*$", RegexOption.IGNORE_CASE).find(xhtml)?.value ?: xhtml
        if (!fixedLayout && body.replace(Regex("<[^>]*>"), "").replace(Regex("\\s+"), " ").trim().length > 200) return null
        val tag = Regex("<(?:\\w+:)?(?:img|image)\\b[^>]*>", RegexOption.IGNORE_CASE).find(xhtml)?.value ?: return null
        val href = if (Regex("^<(?:\\w+:)?img", RegexOption.IGNORE_CASE).containsMatchIn(tag)) attr(tag, "src") else attr(tag, "xlink:href") ?: attr(tag, "href")
        return if (href != null && !Regex("^[a-z]+:", RegexOption.IGNORE_CASE).containsMatchIn(href)) resolve(docPath, href) else null
    }

    // A spine where fewer than half the documents are image pages is a text book (a novel), not a comic.
    fun isTextBook(spineLength: Int, imagePages: Int) = spineLength == 0 || imagePages * 2 < spineLength

    // ---- RAR, 7z and tar: one pass over the entries (ComicLibarchive feeds it) ----

    class Entry(val name: String, val isFile: Boolean, val size: Long, val encrypted: Boolean, val data: InputStream)

    class Limits(val maxEntry: Long = MAX_ENTRY, val maxTotal: Long = MAX_TOTAL, val maxEntries: Int = MAX_ENTRIES)

    // A page bigger than this is not a page.
    const val MAX_ENTRY = 64L * 1024 * 1024
    // The extracted book (desktop: max(cache cap, MAX_BOOK)).
    const val MAX_TOTAL = 8L * 1024 * 1024 * 1024
    // As many entries as a 16 MiB ZIP central directory holds (desktop MAX_CD_SIZE / 80).
    const val MAX_ENTRIES = 16 * 1024 * 1024 / 80

    // Page images and ComicInfo.xml: all the reader keeps of an archive.
    fun wanted(name: String) = ComicPages.isPage(name) || name.substringAfterLast('/').substringAfterLast('\\').equals("ComicInfo.xml", true)

    // Walks [entries] once and hands each wanted file to [take] as a stream capped at the limits. Encrypted
    // entries and anything over the caps throw ComicRefused; [alive] runs between entries (cancellation).
    fun walk(entries: Iterator<Entry>, limits: Limits, alive: () -> Unit = {}, take: (Int, String, InputStream) -> Unit) {
        var seen = 0
        var total = 0L
        for (e in entries) {
            alive()
            if (++seen > limits.maxEntries) throw ComicRefused(ComicRefused.Reason.TOO_LARGE, "too many entries")
            if (!e.isFile || !wanted(e.name)) continue
            if (e.encrypted) throw ComicRefused(ComicRefused.Reason.ENCRYPTED)
            if (e.size > limits.maxEntry || total + e.size > limits.maxTotal) throw ComicRefused(ComicRefused.Reason.TOO_LARGE, "${e.size} bytes")
            // The header's size can lie (or be unset): the stream itself is capped too.
            val room = minOf(limits.maxEntry, limits.maxTotal - total)
            val counted = Capped(e.data, room)
            take(seen - 1, e.name, counted)
            total += counted.read
        }
    }

    // Extracts an archive into [dir] (through dir.part, renamed when complete), files named by flatName.
    fun extract(entries: Iterator<Entry>, dir: File, limits: Limits = Limits(), alive: () -> Unit = {}) {
        val part = File(dir.parentFile, "${dir.name}.part")
        part.deleteRecursively()
        if (!part.mkdirs()) throw IOException("cache")
        try {
            walk(entries, limits, alive) { i, name, data -> File(part, flatName(i, name)).outputStream().use { data.copyTo(it) } }
            if (!part.renameTo(dir)) throw IOException("cache")
        } catch (t: Throwable) {
            part.deleteRecursively()
            throw t
        }
    }

    private class Capped(private val s: InputStream, private val max: Long) : InputStream() {
        var read = 0L
        override fun read(): Int {
            val b = ByteArray(1)
            return if (read(b, 0, 1) < 0) -1 else b[0].toInt() and 0xff
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            val n = s.read(b, off, len)
            if (n > 0) {
                read += n
                if (read > max) throw ComicRefused(ComicRefused.Reason.TOO_LARGE, "entry over the cap")
            }
            return n
        }
    }
}
