package com.wika.wicaby.core.comics

import java.io.Closeable
import java.io.File
import java.io.InputStream
import java.nio.charset.Charset
import java.util.zip.ZipEntry
import java.util.zip.ZipFile

// A CBZ opened for random access: the central directory is read once and each page is
// inflated on demand, so the whole archive never sits in memory.
class ComicArchive(file: File) : Closeable {
    private val zip: ZipFile = openZip(file)
    private val pages: List<ZipEntry>
    val meta: ComicMeta
    val sizes: List<PageSize>

    init {
        try {
            val all = zip.entries().toList()
            val byName = all.filter { !it.isDirectory }.associateBy { it.name }
            var ordered = ComicPages.order(byName.keys.toList()).map { byName.getValue(it) }
            val infoEntry = all.firstOrNull { it.name.substringAfterLast('/').equals("ComicInfo.xml", true) }
            val (m, infoPages) = infoEntry?.let { e ->
                runCatching { ComicInfo.parse(zip.getInputStream(e).use { it.readBytes().toString(Charsets.UTF_8) }) }.getOrNull()
            } ?: (ComicMeta() to emptyList())
            // ComicInfo Page/@Image indexes the sorted image list; "Deleted" pages are ads or scanner credits.
            val info = infoPages.associateBy { it.image }
            val kept = ordered.indices.filter { info[it]?.deleted != true }
            if (kept.isNotEmpty()) ordered = kept.map { ordered[it] }
            pages = ordered
            meta = m
            sizes = ordered.mapIndexed { k, e ->
                val ci = info[kept.getOrElse(k) { k }]
                val head = ImageHeader.size(head(e))
                PageSize(head?.width ?: ci?.width ?: 0, head?.height ?: ci?.height ?: 0, ci?.double == true)
            }
        } catch (t: Throwable) {
            zip.close()
            throw t
        }
    }

    val pageCount get() = pages.size

    fun name(index: Int): String = pages[index].name

    // ZipFile streams are safe to open from several threads at once.
    fun open(index: Int): InputStream = zip.getInputStream(pages[index])

    fun bytes(index: Int): ByteArray = open(index).use { it.readBytes() }

    // The first bytes of an entry (decompressed): enough for the image header.
    private fun head(e: ZipEntry, max: Int = 64 * 1024): ByteArray = runCatching {
        zip.getInputStream(e).use { s ->
            val buf = ByteArray(max)
            var n = 0
            while (n < max) {
                val r = s.read(buf, n, max - n)
                if (r < 0) break
                n += r
            }
            buf.copyOf(n)
        }
    }.getOrDefault(ByteArray(0))

    override fun close() = zip.close()

    private companion object {
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
