package com.wika.wicaby.core.comics

import android.graphics.Bitmap
import java.io.Closeable
import java.io.File
import java.io.InputStream
import java.nio.charset.Charset
import java.util.zip.ZipEntry
import java.util.zip.ZipException
import java.util.zip.ZipFile

// One open book, whatever its format: pages in reading order, their sizes and ComicInfo.
interface ComicBook : Closeable {
    val pageCount: Int
    val meta: ComicMeta
    val sizes: List<PageSize>

    fun open(index: Int): InputStream

    // Pages drawn rather than decoded (PDF): about [width] wide, under [maxPixels]. null: decode open(index).
    fun render(index: Int, width: Int, maxPixels: Int): Bitmap? = null
}

internal class BookLayout(val pages: List<String>, val meta: ComicMeta, val sizes: List<PageSize>)

// Page order, ComicInfo (Deleted and DoublePage) and header sizes for a book made of named files. [read] gives at
// most max bytes of a file (empty when it cannot). [spine]: the order the book itself gives (EPUB), no ComicInfo.
internal fun layout(names: Collection<String>, read: (String, Int) -> ByteArray, spine: List<String>? = null, spineMeta: ComicMeta = ComicMeta()): BookLayout {
    var ordered = spine ?: ComicPages.order(names.toList())
    val infoName = if (spine == null) names.firstOrNull { it.substringAfterLast('/').equals("ComicInfo.xml", true) } else null
    val (meta, infoPages) = infoName?.let { n -> runCatching { ComicInfo.parse(read(n, 4 shl 20).toString(Charsets.UTF_8)) }.getOrNull() } ?: (spineMeta to emptyList())
    // ComicInfo Page/@Image indexes the sorted image list; "Deleted" pages are ads or scanner credits.
    val info = infoPages.associateBy { it.image }
    val kept = ordered.indices.filter { info[it]?.deleted != true }
    if (kept.isNotEmpty()) ordered = kept.map { ordered[it] }
    val sizes = ordered.mapIndexed { k, n ->
        val ci = info[kept.getOrElse(k) { k }]
        val head = ImageHeader.size(read(n, 64 * 1024))
        PageSize(head?.width ?: ci?.width ?: 0, head?.height ?: ci?.height ?: 0, ci?.double == true)
    }
    return BookLayout(ordered, meta, sizes)
}

// A CBZ (or an EPUB, read through its spine) opened for random access: the central directory is read once and
// each page is inflated on demand, so the whole archive never sits in memory.
class ComicArchive(file: File, epub: Boolean = false) : ComicBook {
    private val zip: ZipFile = openZip(file)
    private val pages: List<ZipEntry>
    override val meta: ComicMeta
    override val sizes: List<PageSize>

    init {
        try {
            val byName = zip.entries().toList().filter { !it.isDirectory }.associateBy { it.name }
            val read = { n: String, max: Int -> byName[n]?.let { head(it, max) } ?: ByteArray(0) }
            val l = if (epub) epub(byName, read) else layout(byName.keys, read)
            pages = l.pages.map { byName.getValue(it) }
            meta = l.meta
            sizes = l.sizes
        } catch (t: Throwable) {
            zip.close()
            throw t
        }
    }

    override val pageCount get() = pages.size

    fun name(index: Int): String = pages[index].name

    // ZipFile streams are safe to open from several threads at once.
    override fun open(index: Int): InputStream = zip.getInputStream(pages[index])

    fun bytes(index: Int): ByteArray = open(index).use { it.readBytes() }

    // The first bytes of an entry (decompressed): enough for the image header.
    private fun head(e: ZipEntry, max: Int): ByteArray = runCatching { zip.getInputStream(e).use { ComicFormats.readUpTo(it, max) } }.getOrDefault(ByteArray(0))

    override fun close() = zip.close()

    private companion object {
        const val MAX_XML = 4 shl 20
        const val MAX_SPINE = 10_000

        // container.xml -> OPF -> one image per spine document. Text books and DRM'd images are refused.
        fun epub(byName: Map<String, ZipEntry>, read: (String, Int) -> ByteArray): BookLayout {
            fun text(n: String) = byName[n]?.let { read(n, MAX_XML).toString(Charsets.UTF_8) }
            val root = text("META-INF/container.xml")?.let(ComicFormats::epubRootfile) ?: throw ZipException("no EPUB package")
            val pkg = ComicFormats.epubPackage(text(root) ?: throw ZipException("no EPUB package"), root)
            val spine = pkg.spine.take(MAX_SPINE)
            val images = spine.mapNotNull { doc -> text(doc)?.let { ComicFormats.epubPageImage(it, doc, pkg.fixedLayout) }?.takeIf(byName::containsKey) }
            if (ComicFormats.isTextBook(spine.size, images.size)) throw ComicRefused(ComicRefused.Reason.TEXT_BOOK)
            val enc = text("META-INF/encryption.xml")
            if (enc != null && images.any { enc.contains("\"$it\"") }) throw ComicRefused(ComicRefused.Reason.ENCRYPTED)
            return layout(byName.keys, read, spine = images, spineMeta = ComicMeta(title = pkg.title))
        }

        // Names without the UTF-8 flag are CP437 (old tools); a strict UTF-8 read rejects some of them.
        fun openZip(file: File): ZipFile {
            val utf8 = ZipFile(file)
            return try {
                utf8.entries().toList()
                utf8
            } catch (e: IllegalArgumentException) {
                utf8.close()
                // The charset constructor is API 24+; Android 6 TVs just cannot read such names.
                if (android.os.Build.VERSION.SDK_INT < 24) throw e
                try {
                    ZipFile(file, ZipFile.OPEN_READ, Charset.forName("IBM437"))
                } catch (_: Throwable) {
                    throw e
                }
            }
        }
    }
}

// A RAR, 7z or tar book extracted by ComicFormats.extract: one file per page, named by flatName.
class ComicFolder(dir: File) : ComicBook {
    private val files: Map<String, File> = dir.listFiles().orEmpty().filter { it.isFile }.associateBy { ComicFormats.archiveName(it.name) }
    private val l = layout(files.keys, { n, max -> runCatching { files.getValue(n).inputStream().use { ComicFormats.readUpTo(it, max) } }.getOrDefault(ByteArray(0)) })
    override val pageCount get() = l.pages.size
    override val meta get() = l.meta
    override val sizes get() = l.sizes

    override fun open(index: Int): InputStream = files.getValue(l.pages[index]).inputStream()

    override fun close() = Unit
}
