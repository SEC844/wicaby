package com.wika.wicaby.core.comics

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import java.util.zip.ZipFile

// Formats, EPUB and the archive walk's limits. The books are the mock servers' own (tools/mock-server, written by
// write-comic-fixtures.mjs when node is on the PATH). RAR, 7z and tar go through libarchive (JNI) and PDF through
// PdfRenderer, which a JVM test cannot load: here they are sniffed, and the walk is fed from ZIP entries instead.
class ComicFormatsTest {
    private val repo = File("../../..").canonicalFile

    private val books: File by lazy {
        val n = listOf("node", "node.exe").firstOrNull { n ->
            runCatching { ProcessBuilder(n, "--version").redirectErrorStream(true).start().let { it.waitFor(10, TimeUnit.SECONDS) && it.exitValue() == 0 } }.getOrDefault(false)
        }
        val script = File(repo, "tools/mock-server/write-comic-fixtures.mjs")
        assumeTrue("node is not on the PATH", n != null && script.isFile)
        val dir = Files.createTempDirectory("comic-fixtures").toFile()
        val p = ProcessBuilder(n, script.absolutePath, dir.absolutePath).redirectErrorStream(true).start()
        val log = p.inputStream.bufferedReader().readText()
        assertTrue("write-comic-fixtures: $log", p.waitFor(60, TimeUnit.SECONDS) && p.exitValue() == 0)
        dir
    }

    private fun book(name: String) = File(books, name)

    private fun tmp() = Files.createTempDirectory("comic").toFile()

    @Test
    fun magicBytesPickTheReader() {
        val expected = mapOf(
            "comic-1.cbz" to ComicFormat.ZIP, "comic-3.cbr" to ComicFormat.RAR, "comic-5.cbr" to ComicFormat.RAR,
            "comic-6.cb7" to ComicFormat.SEVEN_Z, "comic-7.cbt" to ComicFormat.TAR, "comic-8.pdf" to ComicFormat.PDF,
            "comic-9.epub" to ComicFormat.EPUB, "comic-11.mobi" to null,
        )
        for ((name, format) in expected) assertEquals(name, format, ComicFormats.sniff(book(name)))
        // The bytes decide: a RAR named .cbz is a RAR.
        assertEquals(ComicFormat.RAR, ComicFormats.sniff(book("comic-3.cbr").readBytes().copyOf(1024)))
        assertEquals(ComicFormat.PDF, ComicFormats.sniff("junk\n%PDF-1.7".toByteArray()))
        assertNull(ComicFormats.sniff(ByteArray(0)))
        assertEquals(setOf("cbz", "zip", "epub", "cbr", "rar", "cb7", "7z", "cbt", "tar", "pdf"), ComicFormats.EXTS)
        assertEquals(ComicFormat.RAR, ComicFormats.ofExt("CBR"))
        assertNull(ComicFormats.ofExt("mobi"))
    }

    @Test
    fun flatNamesNeverClimbOut() {
        assertEquals("3#etc~passwd.png", ComicFormats.flatName(3, "../../etc/passwd.png"))
        assertEquals("0#x~y.png", ComicFormats.flatName(0, "C:\\x\\..\\y.png"))
        assertEquals("1#a~b~c_.png", ComicFormats.flatName(1, "/a//b/./c?.png"))
        assertEquals("Tome 1/02.png", ComicFormats.archiveName(ComicFormats.flatName(7, "Tome 1/02.png")))
        assertEquals(123, ComicFormats.flatName(12, "a".repeat(500)).length)
    }

    @Test
    fun epubPagesFollowTheSpine() {
        ComicArchive(book("comic-9.epub"), epub = true).use { a ->
            // The fixture names its images in reverse reading order: only the spine gives this order.
            assertEquals((5 downTo 1).map { "OEBPS/images/00$it.png" }, (0 until a.pageCount).map(a::name))
            assertTrue(a.sizes.all { it == PageSize(600, 900) })
            assertEquals("Planches EPUB", a.meta.title)
            assertEquals(0x89.toByte(), a.bytes(0)[0])
        }
        assertEquals(ComicRefused.Reason.TEXT_BOOK, refusal { ComicArchive(book("comic-10.epub"), epub = true) })
        assertEquals(ComicRefused.Reason.ENCRYPTED, refusal { ComicArchive(book("drm.epub"), epub = true) })
    }

    @Test
    fun epubParsing() {
        val opf = """<package><metadata><dc:title>A &amp; B</dc:title><meta name="cover" content="c"/></metadata><manifest>
            <item id="c" href="img/cover%20front.jpg"/><item id="p1" href="text/p1.xhtml"/><item id="n" href="nav.xhtml"/></manifest>
            <spine><itemref idref="n" linear="no"/><itemref idref="p1"/></spine></package>"""
        val pkg = ComicFormats.epubPackage(opf, "OPS/content.opf")
        assertEquals("A & B", pkg.title)
        assertEquals(listOf("OPS/text/p1.xhtml"), pkg.spine)
        assertEquals("OPS/img/cover front.jpg", pkg.cover)
        assertFalse(pkg.fixedLayout)
        assertEquals("OPS/img/01.jpg", ComicFormats.epubPageImage("<body><img src='../img/01.jpg#x'/></body>", "OPS/text/p1.xhtml", false))
        assertNull("a novel page with a picture", ComicFormats.epubPageImage("<body><img src=\"a.jpg\"/><p>${"mot ".repeat(80)}</p></body>", "p.xhtml", false))
        assertEquals("a.jpg", ComicFormats.epubPageImage("<body><img src=\"a.jpg\"/><p>${"mot ".repeat(80)}</p></body>", "p.xhtml", true))
        assertNull(ComicFormats.epubPageImage("<body><img src=\"https://x/a.jpg\"/></body>", "p.xhtml", true))
        assertEquals("OPS/c.opf", ComicFormats.epubRootfile("<container><rootfiles><rootfile full-path=\"OPS/c.opf\"/></rootfiles></container>"))
        assertTrue(ComicFormats.isTextBook(4, 1))
        assertFalse(ComicFormats.isTextBook(4, 2))
    }

    private fun zipEntries(file: File): Pair<ZipFile, Iterator<ComicFormats.Entry>> {
        val z = ZipFile(file)
        return z to z.entries().asSequence().map { ComicFormats.Entry(it.name, !it.isDirectory, it.size, false, z.getInputStream(it)) }.iterator()
    }

    // An extracted archive reads exactly like the same pages in a ZIP: order, ComicInfo Deleted and DoublePage,
    // sizes, bytes. libarchive only supplies the entries; this is everything after it.
    @Test
    fun extractedBooksReadLikeTheirZip() {
        val fixture = File(javaClass.getResource("/comics/fixture.cbz")!!.toURI())
        for (f in listOf(fixture, book("comic-1.cbz"))) {
            val dir = File(tmp(), "s-b.d")
            val (z, entries) = zipEntries(f)
            z.use { ComicFormats.extract(entries, dir) }
            assertFalse(File(dir.parentFile, "s-b.d.part").exists())
            ComicArchive(f).use { zip ->
                ComicFolder(dir).use { folder ->
                    assertEquals(zip.pageCount, folder.pageCount)
                    assertEquals(zip.sizes, folder.sizes)
                    assertEquals(zip.meta, folder.meta)
                    for (i in 0 until zip.pageCount) assertArrayEquals(zip.bytes(i), folder.open(i).use { it.readBytes() })
                }
            }
            // Only pages and ComicInfo.xml are kept (no __MACOSX junk).
            assertTrue(dir.list()!!.none { it.contains("MACOSX") })
        }
    }

    private fun refusal(block: () -> Unit): ComicRefused.Reason? = try {
        block()
        null
    } catch (e: ComicRefused) {
        e.reason
    }

    private fun entry(name: String, bytes: Int, size: Long = bytes.toLong(), encrypted: Boolean = false) =
        ComicFormats.Entry(name, true, size, encrypted, ByteArrayInputStream(ByteArray(bytes)))

    @Test
    fun walkLimits() {
        val small = ComicFormats.Limits(maxEntry = 100, maxTotal = 250, maxEntries = 5)
        fun extract(vararg e: ComicFormats.Entry, limits: ComicFormats.Limits = small): ComicRefused.Reason? {
            val dir = File(tmp(), "b.d")
            val r = refusal { ComicFormats.extract(e.iterator(), dir, limits) }
            // A refused archive leaves nothing behind.
            if (r != null) assertFalse(dir.exists() || File(dir.parentFile, "b.d.part").exists())
            return r
        }
        assertNull(extract(entry("1.png", 100), entry("2.png", 100), entry("notes.txt", 1000)))
        assertEquals("a forged entry size", ComicRefused.Reason.TOO_LARGE, extract(entry("1.png", 10, size = 65L shl 20)))
        assertEquals("a size that lies", ComicRefused.Reason.TOO_LARGE, extract(entry("1.png", 101, size = 10)))
        assertEquals("unset size, too many bytes", ComicRefused.Reason.TOO_LARGE, extract(entry("1.png", 101, size = -1)))
        assertEquals("the total", ComicRefused.Reason.TOO_LARGE, extract(entry("1.png", 100), entry("2.png", 100), entry("3.png", 100)))
        assertEquals("the entry count", ComicRefused.Reason.TOO_LARGE, extract(*Array(6) { entry("x$it.txt", 1) }))
        assertEquals(ComicRefused.Reason.ENCRYPTED, extract(entry("1.png", 10, encrypted = true)))
        // The real caps: a 65 MiB page header is refused before a byte is read.
        assertEquals(ComicRefused.Reason.TOO_LARGE, extract(entry("1.png", 1, size = 65L shl 20), limits = ComicFormats.Limits()))
        // A '..' segment is not a page name at all; an absolute one lands inside the folder. Nothing else is written.
        val root = tmp()
        val dir = File(root, "c.d")
        ComicFormats.extract(listOf(entry("../../evil.png", 3), entry("/abs/2.png", 3)).iterator(), dir)
        assertEquals(setOf("1#abs~2.png"), dir.list()!!.toSet())
        assertEquals(listOf("c.d"), root.list()!!.toList())
        try {
            ComicFolder(dir).use { assertEquals(1, it.pageCount) }
        } catch (e: Exception) {
            fail("folder: $e")
        }
    }
}
