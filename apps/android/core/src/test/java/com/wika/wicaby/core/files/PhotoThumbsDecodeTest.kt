package com.wika.wicaby.core.files

import android.graphics.BitmapFactory
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.awt.image.BufferedImage
import java.io.File
import java.io.IOException
import javax.imageio.ImageIO

// Photo thumbnails' memory cap (PhotoThumbs.decode, Capped): a big photo is streamed twice (bounds, then pixels at a
// power-of-two sample), so what is held is the sampled bitmap, never the file. Real decoding: Robolectric's native
// graphics on a JPEG the JVM generates.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PhotoThumbsDecodeTest {
    private fun far() = System.nanoTime() + 60_000_000_000

    @Test
    fun aBigPhotoDecodesAtItsSample() = runBlocking {
        val photo = big()
        var opened = 0
        val decode: suspend (BitmapFactory.Options) -> android.graphics.Bitmap? = { o ->
            opened++
            photo.inputStream().use { BitmapFactory.decodeStream(PhotoThumbs.Capped(it, PhotoThumbs.MAX_FILE.toLong(), far()), null, o) }
        }
        val grid = PhotoThumbs.decode(360, decode)
        assertEquals("bounds, then pixels", 2, opened)
        assertEquals(500 to 375, grid.width to grid.height)
        assertTrue("grid tile ${grid.byteCount} bytes", grid.byteCount <= 1024 * 1024)
        val large = PhotoThumbs.decode(1440, decode)
        assertEquals(2000 to 1500, large.width to large.height)
        assertTrue("1440 tier ${large.byteCount} bytes", large.byteCount <= 12 * 1024 * 1024)
    }

    @Test
    fun cappedStopsAtItsSizeAndDeadline() {
        val data = ByteArray(1000) { it.toByte() }
        assertArrayEquals(data.copyOf(300), PhotoThumbs.Capped(data.inputStream(), 300, far()).readBytes())
        assertFalse(PhotoThumbs.Capped(data.inputStream(), 300, far()).markSupported())
        val stalled = PhotoThumbs.Capped(data.inputStream(), 1000, System.nanoTime() - 1)
        assertThrows(IOException::class.java) { stalled.read() }
        val late = { PhotoThumbs.Capped(data.inputStream(), 1000, System.nanoTime() - 1) }
        assertThrows(IOException::class.java) { runBlocking { PhotoThumbs.decode(360) { o -> BitmapFactory.decodeStream(late(), null, o) } } }
    }

    private companion object {
        // 8000x6000 greyscale with a gradient (no real photo): ~48 MB as pixels, small as a JPEG.
        fun big(): File = File(FilesTestKit.tempDir(), "big.jpg").also { f ->
            val img = BufferedImage(8000, 6000, BufferedImage.TYPE_BYTE_GRAY)
            val raster = img.raster
            val row = IntArray(8000) { it * 255 / 8000 }
            for (y in 0 until 6000) raster.setPixels(0, y, 8000, 1, row)
            ImageIO.write(img, "jpg", f)
        }
    }
}
