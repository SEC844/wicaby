package com.wika.wicaby.core.player

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Rect
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.json
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import okhttp3.Request

// The thumbnail shown over the scrub bar: Emby's BIF or Jellyfin's tile sheets. Null from load()
// when the item has none (no extraction, a header-only BIF, an old server): no preview, no error.
interface ScrubPreview {
    suspend fun frame(ms: Long): Bitmap?

    companion object {
        suspend fun load(api: Api, item: Item, mediaSourceId: String?): ScrubPreview? =
            if (api.server.isEmby) Bif.load(api, item.id)?.let(::BifPreview)
            else {
                val source = mediaSourceId ?: item.id
                JellyfinTiles.pick(item.trickplay, source)?.let { TilesPreview(api, item.id, source, JellyfinTiles(it)) }
            }
    }
}

private class BifPreview(private val bif: Bif) : ScrubPreview {
    override suspend fun frame(ms: Long): Bitmap? = withContext(Dispatchers.Default) {
        bif.indexAt(ms)?.let(bif::jpeg)?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
    }
}

// Jellyfin 10.9+ BaseItemDto.Trickplay entry for one width.
@Serializable
data class TileInfo(
    val width: Int = 0,
    val height: Int = 0,
    val tileWidth: Int = 0,
    val tileHeight: Int = 0,
    val thumbnailCount: Int = 0,
    val interval: Int = 0,
)

// Thumbnail [index] is on sheet [sheet] at pixel ([x], [y]), [TileInfo.width] x [TileInfo.height].
data class Tile(val index: Int, val sheet: Int, val x: Int, val y: Int)

class JellyfinTiles(val info: TileInfo) {
    private val perSheet = info.tileWidth * info.tileHeight

    fun at(ms: Long): Tile {
        val i = (ms.coerceAtLeast(0) / info.interval).coerceAtMost(info.thumbnailCount - 1L).toInt()
        val local = i % perSheet
        return Tile(i, i / perSheet, (local % info.tileWidth) * info.width, (local / info.tileWidth) * info.height)
    }

    val sheets get() = (info.thumbnailCount + perSheet - 1) / perSheet

    companion object {
        // The manifest is {mediaSourceId: {width: info}} (10.9+) or flat {width: info}; the smallest
        // width of at least [minWidth] wins, else the largest there is.
        fun pick(trickplay: JsonObject?, mediaSourceId: String, minWidth: Int = 320): TileInfo? {
            val t = trickplay ?: return null
            val flat = t.keys.isNotEmpty() && t.keys.all { k -> k.all(Char::isDigit) }
            val widths = (if (flat) t else (t[mediaSourceId] ?: t.values.firstOrNull()) as? JsonObject) ?: return null
            val infos = widths.values.mapNotNull { runCatching { json.decodeFromJsonElement(TileInfo.serializer(), it) }.getOrNull() }
                .filter { it.width > 0 && it.height > 0 && it.tileWidth > 0 && it.tileHeight > 0 && it.thumbnailCount > 0 && it.interval > 0 }
            return infos.filter { it.width >= minWidth }.minByOrNull { it.width } ?: infos.maxByOrNull { it.width }
        }
    }
}

// Sheets are kept as JPEG bytes (a few hundred KB each, four at most) and only the tile is decoded:
// a whole 10x10 sheet of 320 px thumbnails would be ~23 MB as a bitmap.
private class TilesPreview(private val api: Api, private val itemId: String, private val source: String, private val tiles: JellyfinTiles) : ScrubPreview {
    private val sheets = object : LinkedHashMap<Int, Deferred<ByteArray?>>(8, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Int, Deferred<ByteArray?>>) = size > 4
    }
    private var lastMs = -1L

    private fun sheet(n: Int): Deferred<ByteArray?> = synchronized(sheets) {
        sheets.getOrPut(n) {
            Core.scope.async {
                runCatching {
                    val req = Request.Builder().url(api.trickplayUrl(itemId, tiles.info.width, n, source)).apply { api.authHeaders().forEach { (k, v) -> header(k, v) } }.build()
                    Core.http.newCall(req).execute().use { r -> if (r.isSuccessful) r.body.bytes() else null }
                }.getOrNull()
            }
        }
    }

    override suspend fun frame(ms: Long): Bitmap? {
        val t = tiles.at(ms)
        // Prefetch the next sheet in the direction of motion.
        val ahead = t.sheet + if (ms >= lastMs) 1 else -1
        lastMs = ms
        if (ahead in 0 until tiles.sheets) sheet(ahead)
        val bytes = sheet(t.sheet).await() ?: return null
        return withContext(Dispatchers.Default) {
            runCatching {
                @Suppress("DEPRECATION")
                val d = BitmapRegionDecoder.newInstance(bytes, 0, bytes.size, false) ?: return@runCatching null
                try {
                    val w = tiles.info.width.coerceAtMost(d.width - t.x)
                    val h = tiles.info.height.coerceAtMost(d.height - t.y)
                    if (w <= 0 || h <= 0) null else d.decodeRegion(Rect(t.x, t.y, t.x + w, t.y + h), null)
                } finally {
                    d.recycle()
                }
            }.getOrNull()
        }
    }
}

// Roku BIF, as Emby serves it from /Videos/{id}/index.bif: magic, u32 version @8,
// u32 count @12, u32 ms multiplier @16 (0 = 1000), then from byte 64 a little-endian
// (timestamp, offset) index of count + 1 entries, then the JPEG frames back to back.
class Bif private constructor(private val data: ByteArray, private val times: LongArray, private val offsets: IntArray) {
    val count get() = times.size

    // The frame shown at [ms]: the last one whose timestamp is <= ms.
    fun indexAt(ms: Long): Int? {
        if (times.isEmpty()) return null
        var lo = 0
        var hi = times.size - 1
        while (lo < hi) {
            val mid = (lo + hi + 1) / 2
            if (times[mid] <= ms) lo = mid else hi = mid - 1
        }
        return lo
    }

    fun jpeg(index: Int): ByteArray? {
        if (index !in 0 until count) return null
        val a = offsets[index]
        val b = offsets[index + 1]
        return if (a in 0..b && b <= data.size) data.copyOfRange(a, b) else null
    }

    companion object {
        private val MAGIC = byteArrayOf(0x89.toByte(), 0x42, 0x49, 0x46, 0x0D, 0x0A, 0x1A, 0x0A)

        private fun u32(b: ByteArray, at: Int): Long =
            (b[at].toLong() and 0xFF) or ((b[at + 1].toLong() and 0xFF) shl 8) or ((b[at + 2].toLong() and 0xFF) shl 16) or ((b[at + 3].toLong() and 0xFF) shl 24)

        fun parse(b: ByteArray): Bif? {
            if (b.size < 64 || !b.copyOf(8).contentEquals(MAGIC)) return null
            val n = u32(b, 12).toInt()
            val mult = u32(b, 16).let { if (it == 0L) 1000L else it }
            if (n <= 0 || 64 + (n + 1) * 8 > b.size) return null
            val times = LongArray(n) { u32(b, 64 + it * 8) * mult }
            val offsets = IntArray(n + 1) { u32(b, 64 + it * 8 + 4).toInt() }
            return Bif(b, times, offsets)
        }

        // Null when the library has no thumbnails (404) or the server is Jellyfin.
        suspend fun load(api: Api, itemId: String, width: Int = 320): Bif? = withContext(Dispatchers.IO) {
            if (!api.server.isEmby) return@withContext null
            runCatching {
                val req = Request.Builder().url(api.bifUrl(itemId, width)).apply { api.authHeaders().forEach { (k, v) -> header(k, v) } }.build()
                Core.http.newCall(req).execute().use { r ->
                    // A feature-length BIF at 320 px is a few MB; refuse anything absurd.
                    if (!r.isSuccessful || r.body.contentLength() > 64L shl 20) null else parse(r.body.bytes())
                }
            }.getOrNull()
        }
    }
}
