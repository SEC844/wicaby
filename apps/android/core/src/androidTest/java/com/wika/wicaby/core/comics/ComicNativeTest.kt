package com.wika.wicaby.core.comics

import android.graphics.BitmapFactory
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

// The parts a JVM test cannot load: libarchive (JNI) on the mock's RAR 5, RAR 4, 7z and tar books, and the platform
// PdfRenderer on its PDF. The books are the mocks' own (write-comic-fixtures.mjs, packed as test assets).
// Run: ./gradlew :core:connectedDebugAndroidTest (one device or emulator).
class ComicNativeTest {
    private val inst = InstrumentationRegistry.getInstrumentation()
    private val cache = inst.targetContext.cacheDir

    private fun book(name: String): File = File(cache, name).also { f -> inst.context.assets.open("comics/$name").use { i -> f.outputStream().use { i.copyTo(it) } } }

    @Test
    fun archivesReadLikeTheMockServesThem() {
        val cases = listOf(
            Triple("comic-3.cbr", ComicFormat.RAR, 6), // RAR 5, its ComicInfo Deleted ad page dropped
            Triple("comic-5.cbr", ComicFormat.RAR, 5), // RAR 4
            Triple("comic-6.cb7", ComicFormat.SEVEN_Z, 5),
            Triple("comic-7.cbt", ComicFormat.TAR, 5),
        )
        for ((name, format, pages) in cases) {
            val file = book(name)
            assertEquals(name, format, ComicFormats.sniff(file))
            val dir = File(cache, "$name.d").apply { deleteRecursively() }
            ComicLibarchive.entries(file, format) { ComicFormats.extract(it, dir) }
            ComicFolder(dir).use { b ->
                assertEquals(name, pages, b.pageCount)
                assertEquals(name, PageSize(600, 900), b.sizes[0])
                val bmp = b.open(0).use { BitmapFactory.decodeStream(it) }
                assertNotNull(name, bmp)
                assertEquals(600, bmp.width)
            }
        }
    }

    @Test
    fun anEncryptedRarIsRefused() {
        try {
            ComicLibarchive.entries(book("encrypted.cbr"), ComicFormat.RAR) { ComicFormats.extract(it, File(cache, "enc.d")) }
            fail("encrypted RAR opened")
        } catch (e: ComicRefused) {
            assertEquals(ComicRefused.Reason.ENCRYPTED, e.reason)
        }
        assertTrue(!File(cache, "enc.d").exists() && !File(cache, "enc.d.part").exists())
    }

    // The cover path's walk over the start of a RAR: what is complete in there comes out, the cut entry does not.
    @Test
    fun aTruncatedRarGivesItsCompletePages() {
        val whole = book("comic-3.cbr")
        val cut = File(cache, "cut.cbr").apply { writeBytes(whole.readBytes().copyOf(40_000)) }
        val got = LinkedHashMap<String, ByteArray>()
        runCatching { ComicLibarchive.entries(cut, ComicFormat.RAR) { ComicFormats.walk(it, ComicFormats.Limits()) { _, n, d -> if (ComicPages.isPage(n)) got[n] = d.readBytes() } } }
        assertTrue("pages ${got.keys}", got.isNotEmpty() && got.size < 7)
        assertEquals("Archive RAR/01.png", ComicCovers.entry(got.keys.toList()))
        assertNotNull(BitmapFactory.decodeByteArray(got.getValue("Archive RAR/01.png"), 0, got.getValue("Archive RAR/01.png").size))
    }

    @Test
    fun pdfPagesAreDrawn() {
        ComicPdf(book("comic-8.pdf")).use { p ->
            assertEquals(listOf(PageSize(600, 900), PageSize(600, 900), PageSize(1200, 900), PageSize(600, 900)), p.sizes)
            val bmp = p.render(0, 300, 1_000_000)
            assertEquals(300, bmp.width)
            assertEquals(450, bmp.height)
            // Under the pixel cap whatever the width asked.
            val capped = p.render(2, 4000, 100_000)
            assertTrue("${capped.width}x${capped.height}", capped.width * capped.height <= 100_000)
            val jpeg = p.coverJpeg(660)
            assertEquals(0xff.toByte(), jpeg[0])
            assertEquals(660, BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size).height)
        }
    }
}
