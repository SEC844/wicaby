package com.wika.wicaby.core.comics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ComicsTest {
    private fun portrait() = PageSize(60, 90)
    private fun landscape() = PageSize(120, 80)

    @Test
    fun naturalOrderSkipsJunk() {
        val names = listOf(
            "b/page10.jpg", "b/page2.jpg", "b/Page1.JPG", "__MACOSX/b/._page1.jpg", "b/.DS_Store", "b/.cover.png",
            "Thumbs.db", "ComicInfo.xml", "b/", "b/page002a.webp", "b/page2b.png",
        )
        assertEquals(listOf("b/Page1.JPG", "b/page2.jpg", "b/page002a.webp", "b/page2b.png", "b/page10.jpg"), ComicPages.order(names))
    }

    @Test
    fun naturalOrderComparesNumbersByValue() {
        val sorted = listOf("10.png", "9.png", "009.png", "1.png", "100.png").sortedWith(ComicPages.natural)
        assertEquals(listOf("1.png", "009.png", "9.png", "10.png", "100.png"), sorted)
    }

    @Test
    fun spreadsFollowKomga() {
        val pages = listOf(portrait(), portrait(), portrait(), landscape(), portrait(), portrait(), portrait(), portrait())
        // Cover alone, pairs, the landscape page alone, the last page alone.
        assertEquals(listOf(listOf(0), listOf(1, 2), listOf(3), listOf(4, 5), listOf(6), listOf(7)), ComicPages.spreads(pages, double = true))
        assertEquals((0..7).map { listOf(it) }, ComicPages.spreads(pages, double = false))
        // A portrait page followed by a landscape one waits alone.
        val odd = listOf(portrait(), portrait(), landscape(), portrait(), portrait(), portrait())
        assertEquals(listOf(listOf(0), listOf(1), listOf(2), listOf(3, 4), listOf(5)), ComicPages.spreads(odd, double = true))
        assertEquals(3, ComicPages.spreadOf(ComicPages.spreads(odd, true), 4))
    }

    @Test
    fun spreadsHonourDoublePageFlag() {
        val pages = listOf(portrait(), portrait(), PageSize(60, 90, double = true), portrait(), portrait())
        assertEquals(listOf(listOf(0), listOf(1), listOf(2), listOf(3), listOf(4)), ComicPages.spreads(pages, true))
        assertEquals(listOf(listOf(0)), ComicPages.spreads(listOf(portrait()), true))
        assertEquals(emptyList<List<Int>>(), ComicPages.spreads(emptyList(), true))
    }

    @Test
    fun comicInfoParsesFlags() {
        val (meta, pages) = ComicInfo.parse(
            """<ComicInfo><Series>Tom &amp; Jerry</Series><Number> 3 </Number><Manga>YesAndRightToLeft</Manga><Format>Web</Format>
               <Pages><Page Image="0" Type="FrontCover" ImageWidth="800" ImageHeight="1200"/><Page Image="5" Type="Deleted"/><Page Image="6" DoublePage="True"></Page></Pages></ComicInfo>""",
        )
        assertEquals("Tom & Jerry", meta.series)
        assertEquals("3", meta.number)
        assertEquals(true, meta.manga)
        assertTrue(meta.webtoon)
        assertEquals(3, pages.size)
        assertEquals(800, pages[0].width)
        assertTrue(pages[1].deleted)
        assertTrue(pages[2].double)
        assertEquals(false, ComicInfo.parse("<ComicInfo><Manga>Yes</Manga></ComicInfo>").first.manga)
        assertNull(ComicInfo.parse("<ComicInfo/>").first.manga)
    }

    @Test
    fun webtoonFromShapes() {
        assertTrue(ComicPages.isWebtoon(ComicMeta(), List(5) { PageSize(500, 1800) }))
        assertFalse(ComicPages.isWebtoon(ComicMeta(), List(5) { PageSize(800, 1200) }))
        assertTrue(ComicPages.isWebtoon(ComicMeta(webtoon = true), emptyList()))
    }

    @Test
    fun progressTicksArePagesTimesTenThousand() {
        assertEquals(0L, ComicProgress.ticks(0))
        assertEquals(50_000L, ComicProgress.ticks(5))
        assertEquals(5, ComicProgress.pageFromTicks(50_000))
        assertEquals(0, ComicProgress.pageFromTicks(null))
        assertEquals(0, ComicProgress.pageFromTicks(-3))
        // Other clients' small raw values are pages.
        assertEquals(7, ComicProgress.pageFromTicks(7))
        assertEquals(4, ComicProgress.startPage(40_000, played = false, pageCount = 10))
        assertEquals(0, ComicProgress.startPage(40_000, played = true, pageCount = 10))
        assertEquals(9, ComicProgress.startPage(400_000, played = false, pageCount = 10))

        val mid = ComicProgress.update(4, 10)
        assertEquals(40_000L, mid.positionTicks)
        assertFalse(mid.played)
        assertEquals(50.0, mid.percentage, 1e-9)
        val end = ComicProgress.update(9, 10)
        assertTrue(end.played)
        assertEquals(0L, end.positionTicks)
        assertEquals(100.0, end.percentage, 1e-9)
        assertEquals(
            """{"PlaybackPositionTicks":20000,"Played":false,"PlayedPercentage":30.00,"LastPlayedDate":"2026-10-11T00:00:00.000Z"}""",
            ComicProgress.json(2, 10, "2026-10-11T00:00:00.000Z"),
        )
    }

    @Test
    fun imageHeaders() {
        // JPEG: SOI, an APP0 segment, then SOF0 with height 300 and width 200.
        val jpeg = byteArrayOf(
            0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 0, 4, 0, 0,
            0xFF.toByte(), 0xC0.toByte(), 0, 17, 8, 0x01, 0x2C, 0x00, 0xC8.toByte(), 3, 0, 0, 0, 0,
        )
        assertEquals(PageSize(200, 300), ImageHeader.size(jpeg))
        val gif = "GIF89a".toByteArray() + byteArrayOf(0x40, 0x01, 0xF0.toByte(), 0x00)
        assertEquals(PageSize(320, 240), ImageHeader.size(gif))
        assertNull(ImageHeader.size(ByteArray(40)))
    }

    private fun fixture() = File(javaClass.getResource("/comics/fixture.cbz")!!.toURI())

    @Test
    fun archiveReadsFixture() {
        ComicArchive(fixture()).use { a ->
            // page4 is "Deleted" in ComicInfo; junk entries never count.
            assertEquals(listOf("Vol/page1.png", "Vol/page2.png", "Vol/page3.png", "Vol/page10.png"), (0 until a.pageCount).map(a::name))
            assertEquals(listOf(PageSize(60, 90), PageSize(60, 90), PageSize(64, 96), PageSize(120, 80, double = true)), a.sizes)
            assertEquals(true, a.meta.manga)
            assertEquals("Fixture & Co", a.meta.series)
            assertEquals("Le début", a.meta.title)
            assertEquals(listOf(listOf(0), listOf(1, 2), listOf(3)), ComicPages.spreads(a.sizes, true))
            // Pages inflate on demand (stored and deflated entries alike).
            val png = a.bytes(1)
            assertEquals(0x89.toByte(), png[0])
            assertEquals(PageSize(60, 90), ImageHeader.size(png))
            assertEquals(PageSize(64, 96), ImageHeader.size(a.bytes(2)))
        }
    }

    @Test(expected = java.util.zip.ZipException::class)
    fun notAZip() {
        val f = File.createTempFile("comic", ".cbr").apply { writeBytes("Rar!\u001a\u0007\u0000 not a zip".toByteArray()); deleteOnExit() }
        ComicArchive(f)
    }
}
