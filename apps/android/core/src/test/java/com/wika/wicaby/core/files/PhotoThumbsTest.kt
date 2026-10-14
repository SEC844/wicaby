package com.wika.wicaby.core.files

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// Photo sources' thumbnails (PhotoThumbs): the bucket a size asks for, the address and cache name (stable, nothing
// secret in them), the sample size and the turn, and the cache's least-recently-used pruning.
class PhotoThumbsTest {
    @Test
    fun bucketsAndAddresses() {
        assertNull("no size: the original", PhotoThumbs.bucket(0))
        assertEquals(360, PhotoThumbs.bucket(240))
        assertEquals(360, PhotoThumbs.bucket(360))
        assertEquals(720, PhotoThumbs.bucket(361))
        assertEquals(1440, PhotoThumbs.bucket(1440))
        assertNull("past the last bucket: the original", PhotoThumbs.bucket(1441))
        val u = PhotoThumbs.uri("0123456789abcdef0123456789abcdef", 720, "4096-1700000000", "p.QWxidW0vSU1HX0IuanBn")
        assertEquals(listOf("0123456789abcdef0123456789abcdef", "720", "4096-1700000000", "p.QWxidW0vSU1HX0IuanBn"), PhotoThumbs.parse(u))
        assertNull(PhotoThumbs.parse("http://127.0.0.1:1234/tok/f/a.jpg"))
        val dir = File("x")
        assertEquals(PhotoThumbs.cacheFile(dir, u), PhotoThumbs.cacheFile(dir, u))
        assertFalse(PhotoThumbs.cacheFile(dir, u) == PhotoThumbs.cacheFile(dir, u.replace("4096-", "4097-")))
    }

    @Test
    fun sampleAndTurn() {
        assertEquals(8, PhotoThumbs.sampleSize(6000, 4000, 720))
        assertEquals(1, PhotoThumbs.sampleSize(640, 480, 720))
        assertEquals(2, PhotoThumbs.sampleSize(1440, 1080, 720))
        assertEquals(listOf(0, 0, 180, 180, 90, 90, 270, 270), (1..8).map { PhotoThumbs.turn(it) })
        assertEquals(0, PhotoThumbs.turn(null))
    }

    @Test
    fun prunesTheLeastRecentlyUsed() {
        val dir = FilesTestKit.tempDir()
        val files = (0 until 5).map { i -> File(dir, "$i.jpg").apply { writeBytes(ByteArray(100)); setLastModified(1_700_000_000_000 + i * 1000L) } }
        PhotoThumbs.prune(dir, cap = 450, keep = 300)
        assertEquals(listOf(false, false, true, true, true), files.map { it.isFile })
        PhotoThumbs.prune(dir, cap = 450, keep = 300)
        assertTrue(files.drop(2).all { it.isFile })
    }
}
