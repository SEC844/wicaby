package com.wika.wicaby.core.files

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import coil3.ImageLoader
import coil3.Uri
import coil3.decode.DataSource
import coil3.decode.ImageSource
import coil3.fetch.FetchResult
import coil3.fetch.Fetcher
import coil3.fetch.SourceFetchResult
import coil3.request.Options
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.files.pure.Ids
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okio.FileSystem
import okio.Path.Companion.toOkioPath
import java.io.File
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest

// A photo source's thumbnails (photo file sources): wicaby-photo://<sourceId>/<bucket>/<tag>/<id>. The address never
// holds a gateway token or a password, so Coil's memory key (the address itself) and the file cache below stay valid
// across runs; past the last bucket the screens get the file itself, as before (the viewer's zoom).
object PhotoThumbs {
    const val SCHEME = "wicaby-photo"
    // Long side, px: grid tiles, large tiles and covers, the TV viewer's low tier.
    val BUCKETS = intArrayOf(360, 720, 1440)
    private const val CAP_BYTES = 300L * 1024 * 1024
    private const val KEEP_BYTES = 250L * 1024 * 1024
    // A photo bigger than this is shown from the original, not thumbnailed (streamed: only the sampled bitmap is held).
    const val MAX_FILE = 64 * 1024 * 1024
    // One thumbnail's reading and decoding, ms (WebDAV and SMB also have their call timeout).
    const val TIMEOUT_MS = 20_000L

    // The smallest bucket covering [px] (0: no size asked), else null (the original).
    fun bucket(px: Int): Int? = if (px <= 0) null else BUCKETS.firstOrNull { it >= px }

    fun uri(sourceId: String, bucket: Int, tag: String, id: String) = "$SCHEME://$sourceId/$bucket/$tag/$id"

    // sourceId, bucket, tag, id; null when not ours.
    fun parse(u: String): List<String>? = u.takeIf { it.startsWith("$SCHEME://") }?.removePrefix("$SCHEME://")?.split('/')?.takeIf { it.size == 4 && it[1].toIntOrNull() != null }

    fun cacheFile(dir: File, u: String): File =
        File(dir, MessageDigest.getInstance("SHA-1").digest(u.toByteArray()).joinToString("") { "%02x".format(it) } + ".jpg")

    // Least recently used first, once the folder passes [cap] (a hit touches its file's mtime).
    fun prune(dir: File, cap: Long = CAP_BYTES, keep: Long = KEEP_BYTES) {
        val files = dir.listFiles()?.filter { it.isFile } ?: return
        var total = files.sumOf { it.length() }
        if (total <= cap) return
        for (f in files.sortedBy { it.lastModified() }) {
            if (total <= keep) break
            total -= f.length()
            f.delete()
        }
    }

    // EXIF orientation as the clockwise turn that shows the pixels upright (mirrors only turned, as PhotoAsset does).
    fun turn(o: Int?): Int = when (o) { 3, 4 -> 180; 5, 6 -> 90; 7, 8 -> 270; else -> 0 }

    // Powers of two while the decoded long side stays at or above [bucket].
    fun sampleSize(w: Int, h: Int, bucket: Int): Int {
        var s = 1
        while (maxOf(w, h) / (s * 2) >= bucket) s *= 2
        return s
    }

    // [bucket]'s thumbnail through [decode], called twice (the bounds, then the pixels at a power-of-two sample): the
    // file is streamed, never held, so the memory is the sampled bitmap's (8000x6000 at 360: 500x375).
    suspend fun decode(bucket: Int, decode: suspend (BitmapFactory.Options) -> Bitmap?): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        decode(bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("cannot decode")
        val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, bucket) }
        return decode(opts) ?: throw IOException("cannot decode")
    }

    // At most [max] bytes, then the end; past [deadline] (System.nanoTime) an IOException. No mark, so a decoder cannot
    // rewind past the count. shortcut: the deadline is checked between reads, a read that blocks forever (SAF provider)
    // still holds its slot; the HTTP backends have their call timeout.
    class Capped(s: InputStream, private var left: Long, private val deadline: Long) : FilterInputStream(s) {
        private fun allow(n: Long): Long {
            if (System.nanoTime() > deadline) throw IOException("thumbnail timeout")
            return minOf(n, left)
        }

        override fun read(): Int = if (allow(1) <= 0) -1 else super.read().also { if (it >= 0) left-- }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            val n = allow(len.toLong()).toInt()
            if (len > 0 && n <= 0) return -1
            return super.read(b, off, n).also { if (it > 0) left -= it }
        }

        override fun skip(n: Long): Long = super.skip(allow(n)).also { left -= it }

        override fun available(): Int = minOf(super.available().toLong(), left).toInt()

        override fun markSupported() = false

        override fun mark(readlimit: Int) {}

        override fun reset() = throw IOException("no mark")
    }
}

// Loads a wicaby-photo:// thumbnail: the cached JPEG, else the photo read through its source's backend (its own
// credentials, pin or gateway), decoded at a power-of-two sample, turned upright (as Coil does for an original, so the
// client's rotation rule sees an upright tile), saved, served. [permits]: thumbnails read and decoded at once.
class PhotoThumbFetcher(private val uri: String, private val dir: File, private val permits: Semaphore) : Fetcher {
    override suspend fun fetch(): FetchResult = withContext(Dispatchers.IO) {
        val file = PhotoThumbs.cacheFile(dir, uri)
        if (!file.isFile) make(file)
        file.setLastModified(System.currentTimeMillis())
        SourceFetchResult(ImageSource(file.toOkioPath(), FileSystem.SYSTEM), "image/jpeg", DataSource.DISK)
    }

    private suspend fun make(file: File) {
        val (sourceId, bucket, _, id) = PhotoThumbs.parse(uri) ?: throw IOException("not a photo thumbnail")
        val api = FileSources.api(sourceId) ?: throw IOException("no such source")
        val index = api.photos ?: throw IOException("not a photo source")
        val rel = Ids.decode(id) ?: throw IOException("bad id")
        val rec = index.cached(rel) ?: index.records()[rel] ?: throw IOException("not indexed")
        if (rec.s > PhotoThumbs.MAX_FILE) throw IOException("too large")
        val entry = FileEntry(Ids.name(rel), false, rec.s, rec.m, rec.u)
        permits.withPermit {
            val deadline = System.nanoTime() + PhotoThumbs.TIMEOUT_MS * 1_000_000
            var bmp = PhotoThumbs.decode(bucket.toInt()) { o ->
                api.backend.open(rel, entry, PhotoThumbs.MAX_FILE) { BitmapFactory.decodeStream(PhotoThumbs.Capped(it, PhotoThumbs.MAX_FILE.toLong(), deadline), null, o) }
            }
            val turn = PhotoThumbs.turn(rec.o)
            if (turn != 0) bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(turn.toFloat()) }, true).also { if (it !== bmp) bmp.recycle() }
            dir.mkdirs()
            val tmp = File(dir, file.name + ".tmp")
            tmp.outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }
            bmp.recycle()
            if (!tmp.renameTo(file)) throw IOException("cannot cache")
        }
        PhotoThumbs.prune(dir)
    }

    // [parallel]: 2 on the TV (a 192 MB heap, video buffers beside), 3 on phones.
    class Factory(parallel: Int = 3, private val dir: () -> File = { File(Core.app.cacheDir, "photo-thumbs") }) : Fetcher.Factory<Uri> {
        private val permits = Semaphore(parallel)

        override fun create(data: Uri, options: Options, imageLoader: ImageLoader): Fetcher? =
            if (data.scheme == PhotoThumbs.SCHEME) PhotoThumbFetcher(data.toString(), dir(), permits) else null
    }
}
