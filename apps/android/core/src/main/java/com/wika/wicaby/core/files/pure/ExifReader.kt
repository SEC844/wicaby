package com.wika.wicaby.core.files.pure

// Photo file sources: what a photo's first bytes say, for an index with no server behind it. A minimal EXIF/TIFF
// reader for the fields the timeline and the viewer's info panel use, out of JPEG (APP1), PNG (eXIf), WebP (EXIF chunk)
// and HEIC (the Exif item), plus the pixel size from the container. Pure, no dependency, never throws: a damaged or cut
// header gives what was read before the damage. Kotlin twin of the desktop's shared/files/exif.ts; both pass
// tools/checks/fixtures/photos/exif-vectors.json (ExifReaderTest here).
data class PhotoHead(
    // DateTimeOriginal (else DateTime) as wall-clock "YYYY-MM-DDTHH:MM:SS"; offset: OffsetTimeOriginal "+HH:MM".
    var takenAt: String? = null,
    var offset: String? = null,
    // EXIF Orientation 1..8.
    var orientation: Int? = null,
    // Never logged; the apps have no photo map, so they never leave the index.
    var lat: Double? = null,
    var lon: Double? = null,
    var alt: Double? = null,
    var make: String? = null,
    var model: String? = null,
    var lens: String? = null,
    var exposureS: Double? = null,
    var fNumber: Double? = null,
    var focalMm: Double? = null,
    var iso: Double? = null,
    // Stored pixels, before the orientation.
    var width: Int? = null,
    var height: Int? = null,
    // HEIC whose Exif item lies past the bytes given: read [at, at + length) and pass it to heicExifItem.
    var more: More? = null,
) {
    data class More(val at: Long, val length: Long)
}

object ExifReader {
    // The first bytes the index reads of each file: EXIF sits in the first 64 KB (JPEG APP1 is at most that).
    const val HEAD_BYTES = 65536

    private val ORIENTATIONS = listOf("TopLeft", "TopRight", "BottomRight", "BottomLeft", "LeftTop", "RightTop", "RightBottom", "LeftBottom")

    // EXIF 1..8 as the Emby ImageOrientation name the photo UI reads (PhotoAsset quarterTurn).
    fun orientationName(o: Int?): String? = o?.takeIf { it in 1..8 }?.let { ORIENTATIONS[it - 1] }

    fun read(b: ByteArray): PhotoHead = try {
        when {
            b.size >= 4 && u8(b, 0) == 0xff && u8(b, 1) == 0xd8 -> jpeg(b)
            b.size >= 8 && u32be(b, 0) == 0x89504e47L -> png(b)
            ascii(b, 0, 4) == "RIFF" && ascii(b, 8, 4) == "WEBP" -> webp(b)
            ascii(b, 4, 4) == "ftyp" -> heic(b)
            else -> PhotoHead()
        }
    } catch (e: Exception) {
        // unreachable by design (every read is bounds-checked); a parser bug must not stop an index
        PhotoHead()
    }

    // The bytes of a HEIC Exif item (read's `more`): a 4-byte offset to the TIFF header, then the EXIF.
    fun heicExifItem(item: ByteArray): PhotoHead = if (item.size < 4) PhotoHead() else tiff(item, 4 + u32be(item, 0), item.size.toLong())

    private fun u8(b: ByteArray, p: Long): Int = if (p >= 0 && p < b.size) b[p.toInt()].toInt() and 255 else 0
    private fun u8(b: ByteArray, p: Int): Int = u8(b, p.toLong())
    private fun u16be(b: ByteArray, p: Long) = (u8(b, p) shl 8) or u8(b, p + 1)
    private fun u32be(b: ByteArray, p: Long): Long = (u8(b, p).toLong() shl 24) or (u8(b, p + 1).toLong() shl 16) or (u8(b, p + 2).toLong() shl 8) or u8(b, p + 3).toLong()
    private fun u32le(b: ByteArray, p: Long): Long = u8(b, p).toLong() or (u8(b, p + 1).toLong() shl 8) or (u8(b, p + 2).toLong() shl 16) or (u8(b, p + 3).toLong() shl 24)
    private fun u24le(b: ByteArray, p: Long) = u8(b, p) or (u8(b, p + 1) shl 8) or (u8(b, p + 2) shl 16)
    private fun ascii(b: ByteArray, at: Long, n: Int): String =
        if (at >= 0 && at + n <= b.size) String(CharArray(n) { (b[(at + it).toInt()].toInt() and 255).toChar() }) else ""

    private fun jpeg(b: ByteArray): PhotoHead {
        var out = PhotoHead()
        var exif = false
        var p = 2L
        while (p + 4 <= b.size) {
            if (u8(b, p) != 0xff) break
            val m = u8(b, p + 1)
            if (m == 0xff) {
                p++
                continue
            }
            if (m == 0xd9 || m == 0xda) break
            val len = u16be(b, p + 2)
            if (len < 2) break
            if (m == 0xe1 && !exif && ascii(b, p + 4, 6) == "Exif\u0000\u0000") {
                exif = true
                out = tiff(b, p + 10, minOf(b.size.toLong(), p + 2 + len))
            }
            val sof = m in 0xc0..0xcf && m != 0xc4 && m != 0xc8 && m != 0xcc
            // The frame's size wins over EXIF's PixelXDimension, which an editor may leave stale.
            if (sof && p + 9 <= b.size) {
                out.height = u16be(b, p + 5)
                out.width = u16be(b, p + 7)
                break
            }
            p += 2 + len
        }
        return out
    }

    private fun png(b: ByteArray): PhotoHead {
        var out = PhotoHead()
        var p = 8L
        while (p + 8 <= b.size) {
            val len = u32be(b, p)
            val type = ascii(b, p + 4, 4)
            if (type == "IHDR" && p + 16 <= b.size) {
                out.width = u32be(b, p + 8).toInt()
                out.height = u32be(b, p + 12).toInt()
            }
            if (type == "eXIf") out = tiff(b, p + 8, minOf(b.size.toLong(), p + 8 + len)).also { it.width = out.width; it.height = out.height }
            if (type == "IDAT" || type == "IEND") break
            p += 12 + len
        }
        return out
    }

    private fun webp(b: ByteArray): PhotoHead {
        var out = PhotoHead()
        var size: Pair<Int, Int>? = null
        var p = 12L
        while (p + 8 <= b.size) {
            val type = ascii(b, p, 4)
            val len = u32le(b, p + 4)
            val d = p + 8
            if (type == "VP8X" && d + 10 <= b.size) size = (1 + u24le(b, d + 4)) to (1 + u24le(b, d + 7))
            if (type == "VP8L" && d + 5 <= b.size && size == null) {
                val bits = u32le(b, d + 1)
                size = (1 + (bits and 0x3fff).toInt()) to (1 + ((bits ushr 14) and 0x3fff).toInt())
            }
            if (type == "VP8 " && d + 10 <= b.size && size == null) size = ((u8(b, d + 6) or (u8(b, d + 7) shl 8)) and 0x3fff) to ((u8(b, d + 8) or (u8(b, d + 9) shl 8)) and 0x3fff)
            if (type == "EXIF") {
                val end = minOf(b.size.toLong(), d + len)
                out = tiff(b, if (end - d >= 6 && ascii(b, d, 6) == "Exif\u0000\u0000") d + 6 else d, end)
            }
            p = d + len + (len and 1)
        }
        size?.let { out.width = it.first; out.height = it.second }
        return out
    }

    // ISO BMFF: meta > iinf (the 'Exif' item's id), iloc (where it is), iprp > ipco > ispe (the largest is the image).
    private fun heic(b: ByteArray): PhotoHead {
        fun box(from: Long, to: Long, cb: (type: String, start: Long, end: Long) -> Unit) {
            var p = from
            while (p + 8 <= to) {
                var size = u32be(b, p)
                var head = 8L
                if (size == 1L && p + 16 <= to) {
                    size = u32be(b, p + 8) * 4294967296L + u32be(b, p + 12)
                    head = 16
                }
                if (size == 0L) size = to - p
                if (size < head) return
                cb(ascii(b, p + 4, 4), p + head, minOf(to, p + size))
                p += size
            }
        }
        var exifId = -1L
        val locs = HashMap<Long, PhotoHead.More>()
        var dims: Pair<Long, Long>? = null
        box(0, b.size.toLong()) { type, s, e ->
            if (type != "meta") return@box
            box(s + 4, e) { t2, s2, e2 ->
                if (t2 == "iinf") {
                    val v = u8(b, s2)
                    box(s2 + 4 + (if (v == 0) 2 else 4), e2) { t3, s3, _ ->
                        if (t3 != "infe" || u8(b, s3) < 2) return@box
                        val id = if (u8(b, s3) == 2) u16be(b, s3 + 4).toLong() else u32be(b, s3 + 4)
                        val at = s3 + 4 + (if (u8(b, s3) == 2) 2 else 4) + 2
                        if (ascii(b, at, 4) == "Exif") exifId = id
                    }
                }
                if (t2 == "iloc") iloc(b, s2, e2, locs)
                if (t2 == "iprp") box(s2, e2) { t3, s3, e3 ->
                    if (t3 == "ipco") box(s3, e3) { t4, s4, _ ->
                        if (t4 != "ispe" || s4 + 12 > b.size) return@box
                        val w = u32be(b, s4 + 4)
                        val h = u32be(b, s4 + 8)
                        val d = dims
                        if (d == null || w * h > d.first * d.second) dims = w to h
                    }
                }
            }
        }
        val loc = locs[exifId]
        var out = PhotoHead()
        if (loc != null && loc.length > 0) {
            out = if (loc.at + loc.length <= b.size) heicExifItem(b.copyOfRange(loc.at.toInt(), (loc.at + loc.length).toInt())) else PhotoHead(more = loc)
        }
        dims?.let { out.width = it.first.toInt(); out.height = it.second.toInt() }
        return out
    }

    // One extent per item is all a camera writes for Exif; construction method 0 (file offsets) only.
    private fun iloc(b: ByteArray, s: Long, e: Long, out: MutableMap<Long, PhotoHead.More>) {
        val v = u8(b, s)
        if (s + 8 > e) return
        val offSize = u8(b, s + 4) shr 4
        val lenSize = u8(b, s + 4) and 15
        val baseSize = u8(b, s + 5) shr 4
        val idxSize = if (v == 1 || v == 2) u8(b, s + 5) and 15 else 0
        var p = s + 6
        fun read(n: Int): Long {
            var x = 0L
            for (i in 0 until n) x = x * 256 + u8(b, p + i)
            p += n
            return x
        }
        val count = if (v < 2) read(2) else read(4)
        var i = 0L
        while (i < count && p < e) {
            val id = if (v < 2) read(2) else read(4)
            val method = if (v == 1 || v == 2) read(2) and 15 else 0
            read(2) // data_reference_index
            val base = read(baseSize)
            val extents = read(2)
            var first: PhotoHead.More? = null
            var k = 0L
            while (k < extents && p < e) {
                if (idxSize > 0) read(idxSize)
                val off = read(offSize)
                val len = read(lenSize)
                if (first == null) first = PhotoHead.More(base + off, len)
                k++
            }
            if (first != null && method == 0L && extents == 1L) out[id] = first
            i++
        }
    }

    private class Entry(val type: Int, val count: Long, val at: Long)

    private val SIZE = intArrayOf(0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8)

    // The TIFF structure at b[start] (offsets relative to start, nothing read at or past end): IFD0, then the Exif and
    // GPS IFDs it points to.
    private fun tiff(b: ByteArray, start: Long, end: Long): PhotoHead {
        val out = PhotoHead()
        if (start < 0 || start + 8 > end) return out
        val le = u8(b, start) == 0x49 && u8(b, start + 1) == 0x49
        if (!le && !(u8(b, start) == 0x4d && u8(b, start + 1) == 0x4d)) return out
        fun u16(p: Long) = if (le) u8(b, p) or (u8(b, p + 1) shl 8) else u16be(b, p)
        fun u32(p: Long) = if (le) u32le(b, p) else u32be(b, p)
        fun fits(p: Long, n: Long) = p >= start && p + n <= end
        if (u16(start + 2) != 42) return out
        val seen = HashSet<Long>()
        fun ifd(rel: Long, cb: (tag: Int, e: Entry) -> Unit) {
            val p = start + rel
            if (!seen.add(rel) || !fits(p, 2)) return
            val n = minOf(u16(p), 512)
            for (i in 0 until n) {
                val q = p + 2 + i * 12L
                if (!fits(q, 12)) return
                val type = u16(q + 2)
                val count = u32(q + 4)
                val bytes = (SIZE.getOrNull(type) ?: 0) * count
                if (bytes == 0L || bytes > 65536) continue
                val at = if (bytes <= 4) q + 8 else start + u32(q + 8)
                if (fits(at, bytes)) cb(u16(q), Entry(type, count, at))
            }
        }
        fun num(e: Entry, i: Int = 0): Double? {
            val p = e.at + i * (when (e.type) { 3, 8 -> 2; 5, 10 -> 8; else -> 4 })
            return when (e.type) {
                3 -> u16(p).toDouble()
                4 -> u32(p).toDouble()
                9 -> u32(p).toInt().toDouble()
                5 -> u32(p + 4).takeIf { it != 0L }?.let { d -> u32(p).toDouble() / d }
                10 -> u32(p + 4).toInt().takeIf { it != 0 }?.let { d -> u32(p).toInt().toDouble() / d }
                1, 7 -> u8(b, p).toDouble()
                else -> null
            }
        }
        fun text(e: Entry): String? {
            if (e.type != 2) return null
            val sb = StringBuilder()
            var i = 0L
            while (i < e.count && u8(b, e.at + i) != 0) sb.append(u8(b, e.at + i).toChar()).also { i++ }
            return sb.toString().trim().ifEmpty { null }
        }
        var exifAt = -1L
        var gpsAt = -1L
        var dateTime: String? = null
        ifd(u32(start + 4)) { tag, e ->
            when (tag) {
                0x010f -> out.make = text(e)
                0x0110 -> out.model = text(e)
                0x0112 -> num(e)?.takeIf { it >= 1 && it <= 8 }?.let { out.orientation = it.toInt() }
                0x0132 -> dateTime = text(e)
                0x8769 -> exifAt = num(e)?.toLong() ?: -1
                0x8825 -> gpsAt = num(e)?.toLong() ?: -1
            }
        }
        var original: String? = null
        if (exifAt > 0) ifd(exifAt) { tag, e ->
            when (tag) {
                0x9003 -> original = text(e)
                0x9011 -> text(e)?.takeIf { OFFSET.matches(it) }?.let { out.offset = it }
                0x829a -> out.exposureS = num(e)
                0x829d -> out.fNumber = num(e)
                0x8827 -> out.iso = num(e)
                0x920a -> out.focalMm = num(e)
                0xa002 -> out.width = num(e)?.toInt()
                0xa003 -> out.height = num(e)?.toInt()
                0xa434 -> out.lens = text(e)
            }
        }
        val taken = exifDate(original) ?: exifDate(dateTime)
        if (taken != null) out.takenAt = taken else out.offset = null
        if (gpsAt > 0) {
            val g = HashMap<Int, Entry>()
            ifd(gpsAt) { tag, e -> g[tag] = e }
            fun coord(refTag: Int, valTag: Int, neg: String): Double? {
                val e = g[valTag]?.takeIf { it.count >= 3 && (it.type == 5 || it.type == 10) } ?: return null
                val v = (0..2).map { num(e, it) }
                if (v.any { it == null || !it.isFinite() }) return null
                val x = v[0]!! + v[1]!! / 60 + v[2]!! / 3600
                return if (g[refTag]?.let(::text)?.uppercase() == neg) -x else x
            }
            val lat = coord(1, 2, "S")
            val lon = coord(3, 4, "W")
            // 0, 0 is "no fix" written as numbers.
            if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat != 0.0 || lon != 0.0)) {
                out.lat = lat
                out.lon = lon
                val alt = g[6]?.let { num(it) }
                if (alt != null && alt.isFinite()) out.alt = if (g[5]?.let { num(it) } == 1.0) -alt else alt
            }
        }
        // Not-a-number results (0/0 rationals are refused above, but keep the twin's rule).
        if (out.exposureS?.isFinite() == false) out.exposureS = null
        if (out.fNumber?.isFinite() == false) out.fNumber = null
        if (out.focalMm?.isFinite() == false) out.focalMm = null
        return out
    }

    private val OFFSET = Regex("^[+-]\\d{2}:\\d{2}$")
    private val DATE = Regex("^(\\d{4})[:-](\\d{2})[:-](\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})")

    // "YYYY:MM:DD HH:MM:SS" (zeros and blanks are "unknown") as "YYYY-MM-DDTHH:MM:SS".
    private fun exifDate(s: String?): String? {
        val m = s?.let { DATE.find(it) }?.groupValues ?: return null
        if (m[1].toInt() < 1800 || m[2] == "00" || m[3] == "00") return null
        return "${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}"
    }
}
