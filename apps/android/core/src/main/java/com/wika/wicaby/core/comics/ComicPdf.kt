package com.wika.wicaby.core.comics

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import kotlin.math.sqrt

// A PDF comic through the platform's PdfRenderer (API 21+, no dependency): pages are drawn at the size the reader
// asks for. PdfRenderer allows one page open at a time, hence the lock.
class ComicPdf(file: File) : ComicBook {
    private val fd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    private val pdf: PdfRenderer = try {
        PdfRenderer(fd)
    } catch (e: SecurityException) {
        fd.close()
        throw ComicRefused(ComicRefused.Reason.ENCRYPTED, "password")
    } catch (t: Throwable) {
        fd.close()
        throw t
    }
    override val meta = ComicMeta()

    // In points; image-only comics are usually laid out one point per pixel.
    override val sizes: List<PageSize> = try {
        (0 until minOf(pdf.pageCount, MAX_PAGES)).map { i -> synchronized(pdf) { pdf.openPage(i).use { PageSize(it.width, it.height) } } }
    } catch (t: Throwable) {
        close()
        throw t
    }
    override val pageCount get() = sizes.size

    override fun open(index: Int): InputStream = throw UnsupportedOperationException("PDF pages are rendered")

    override fun render(index: Int, width: Int, maxPixels: Int): Bitmap = synchronized(pdf) {
        pdf.openPage(index).use { p ->
            // A forged zero-size MediaBox would make an infinite scale.
            if (p.width <= 0 || p.height <= 0) throw java.io.IOException("empty page")
            var scale = width.toFloat() / p.width
            val px = p.width * scale * p.height * scale
            if (px > maxPixels) scale *= sqrt(maxPixels / px)
            val bmp = Bitmap.createBitmap(maxOf(1, (p.width * scale).toInt()), maxOf(1, (p.height * scale).toInt()), Bitmap.Config.ARGB_8888)
            // PDF pages are transparent where nothing is drawn.
            bmp.eraseColor(Color.WHITE)
            p.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            bmp
        }
    }

    // The first page as a JPEG, [height] px high (covers).
    fun coverJpeg(height: Int): ByteArray {
        val s = sizes.firstOrNull() ?: throw java.io.IOException("no page")
        val bmp = render(0, maxOf(1, height * s.width / maxOf(1, s.height)), height * height * 4)
        return ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray().also { bmp.recycle() }
    }

    override fun close() {
        synchronized(pdf) { pdf.close() }
        fd.close()
    }

    private companion object {
        const val MAX_PAGES = 10_000
    }
}
