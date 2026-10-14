package com.wika.wicaby.core.music

import android.content.Context
import coil3.ImageLoader
import coil3.fetch.FetchResult
import coil3.fetch.Fetcher
import coil3.key.Keyer
import coil3.request.ImageRequest
import coil3.request.Options
import coil3.request.SuccessResult
import coil3.request.allowHardware
import coil3.toBitmap
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/**
 * Music covers (music-feishin-navidrome spec §4.A, MU-A1 to MU-A5), the twin of desktop shared/music-art.ts: both run
 * tools/checks/fixtures/music/cover-vectors.json. Emby keeps no Primary on an album whose only art is embedded in its
 * tracks (the owner's field bug: the cover shows once a track plays), and artists without MusicBrainz ids get no
 * image: those borrow their first track's or first album's cover, one lookup per item, cached, three at a time.
 */
object MusicArt {
    data class Ref(val id: String, val tag: String)

    sealed interface Plan {
        data class Image(val ref: Ref) : Plan
        data class Lookup(val kind: String) : Plan
    }

    const val FIRST_TRACK = "firstTrack"
    const val FIRST_ALBUM = "firstAlbum"

    fun isMusic(item: Item) = item.type in setOf("MusicAlbum", "MusicArtist", "Audio", "MusicGenre") || (item.type == "Playlist" && item.mediaType == "Audio")

    fun plan(item: Item): Plan? {
        item.imageTags["Primary"]?.takeIf { it.isNotEmpty() }?.let { return Plan.Image(Ref(item.id, it)) }
        if (item.type == "Audio" && item.albumId != null && item.albumPrimaryImageTag != null) return Plan.Image(Ref(item.albumId, item.albumPrimaryImageTag))
        if (item.type == "MusicAlbum") return Plan.Lookup(FIRST_TRACK)
        if (item.type == "MusicArtist") return Plan.Lookup(FIRST_ALBUM)
        return null
    }

    // Emby's AlbumArtistIds is unverified on 4.8+ (music spec §3.2): ArtistIds with ArtistType=AlbumArtist there.
    fun lookupQuery(kind: String, id: String, emby: Boolean): List<Pair<String, Any?>> {
        val common = listOf("Recursive" to true, "Limit" to 1, "EnableImageTypes" to "Primary", "ImageTypeLimit" to 1, "EnableUserData" to false, "Fields" to "PrimaryImageAspectRatio")
        if (kind == FIRST_TRACK) return listOf("ParentId" to id, "IncludeItemTypes" to "Audio", "ImageTypes" to "Primary", "SortBy" to "ParentIndexNumber,IndexNumber,SortName") + common
        val by = if (emby) listOf("ArtistIds" to id, "ArtistType" to "AlbumArtist") else listOf("AlbumArtistIds" to id)
        return by + listOf("IncludeItemTypes" to "MusicAlbum", "SortBy" to "ProductionYear,SortName", "SortOrder" to "Descending") + common
    }

    // Answers per server and item for the process (no image too); a failed lookup is asked again next time.
    private val cache = ConcurrentHashMap<String, Deferred<Ref?>>()
    private val permits = Semaphore(3)

    suspend fun resolve(api: Api, item: Item, lookup: suspend (String, Item) -> Item? = { kind, it -> api.items(*lookupQuery(kind, it.id, api.server.kind != "jellyfin").toTypedArray()).items.firstOrNull() }, depth: Int = 0): Ref? {
        val plan = plan(item) ?: return null
        if (plan is Plan.Image) return plan.ref
        if (depth > 1) return null
        val key = "${api.server.id}:${item.id}"
        val mine = CompletableDeferred<Ref?>()
        val running = cache.putIfAbsent(key, mine)
        if (running != null) return running.await()
        return try {
            val child = permits.withPermit { lookup((plan as Plan.Lookup).kind, item) }
            (child?.let { resolve(api, it, lookup, depth + 1) }).also { mine.complete(it) }
        } catch (e: Exception) {
            cache.remove(key)
            mine.complete(null)
            if (e is CancellationException) throw e
            null
        }
    }

    internal fun clear() = cache.clear()

    // Requested sizes in device pixels, from a few buckets so the server's resize cache is shared (MU-A5).
    private val SIZES = intArrayOf(80, 160, 240, 320, 480, 720, 960, 1200)
    fun size(px: Float): Int = SIZES.firstOrNull { it >= px } ?: SIZES.last()

    /** The placeholder's initials (MU-A4): first and last word that starts with a letter or digit, accents kept. */
    private val LEAD = Regex("^[\\p{L}\\p{N}]\\p{M}*")
    fun initials(name: String): String {
        val words = name.trim().split(Regex("\\s+")).mapNotNull { LEAD.find(it)?.value }
        return (if (words.size > 1) words.first() + words.last() else words.firstOrNull().orEmpty()).uppercase()
    }

    /** FNV-1a of the name's UTF-16 units, mod 360. */
    fun hue(name: String): Int {
        var h = 0x811c9dc5.toInt()
        for (c in name) h = (h xor c.code) * 0x01000193
        return (h.toUInt() % 360u).toInt()
    }

    /** The tile colour, hsl(hue 35 % 32 %), as 0xRRGGBB: white initials keep ≥ 4.5:1 at every hue (music-art-check). */
    fun tileRgb(hue: Int, s: Double = 0.35, l: Double = 0.32): Int {
        val a = s * minOf(l, 1 - l)
        fun f(n: Int): Int {
            val k = (n + hue / 30.0) % 12
            return Math.round(255 * (l - a * maxOf(-1.0, minOf(k - 3, 9 - k, 1.0)))).toInt()
        }
        return (f(0) shl 16) or (f(8) shl 8) or f(4)
    }

    /**
     * Dominant colour of a small ARGB image (16 × 16, MU-A3) as 0xRRGGBB: the most common coarse bin (3 bits a channel)
     * among opaque pixels neither near black, near white nor grey, averaged; else the plain average; null if none is opaque.
     */
    fun dominant(argb: IntArray): Int? {
        val bins = HashMap<Int, LongArray>()
        val all = LongArray(4)
        for (p in argb) {
            if ((p ushr 24) < 128) continue
            val r = p shr 16 and 0xff
            val g = p shr 8 and 0xff
            val b = p and 0xff
            all[0] += r.toLong(); all[1] += g.toLong(); all[2] += b.toLong(); all[3]++
            val max = maxOf(r, g, b)
            val min = minOf(r, g, b)
            if (max < 24 || min > 232 || max - min < 20) continue
            val bin = bins.getOrPut(((r shr 5) shl 6) or ((g shr 5) shl 3) or (b shr 5)) { LongArray(4) }
            bin[0] += r.toLong(); bin[1] += g.toLong(); bin[2] += b.toLong(); bin[3]++
        }
        val best = bins.values.maxByOrNull { it[3] } ?: all
        if (best[3] == 0L) return null
        fun avg(c: Int) = Math.round(best[c].toDouble() / best[3]).toInt()
        return (avg(0) shl 16) or (avg(1) shl 8) or avg(2)
    }

    private val colours = object : LinkedHashMap<String, Int>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Int>?) = size > 200
    }

    /** The dominant colour of a cover (any Coil model), from a 16 px decode; cached by model. 0xRRGGBB or null. */
    suspend fun colour(loader: ImageLoader, context: Context, data: Any): Int? {
        val key = data.toString()
        synchronized(colours) { colours[key] }?.let { return it }
        val r = loader.execute(ImageRequest.Builder(context).data(data).size(16).allowHardware(false).build()) as? SuccessResult ?: return null
        val bmp = r.image.toBitmap(16, 16)
        val px = IntArray(bmp.width * bmp.height).also { bmp.getPixels(it, 0, bmp.width, 0, 0, bmp.width, bmp.height) }
        return dominant(px)?.also { synchronized(colours) { colours[key] = it } }
    }
}

/** What Coil loads for a music item whose cover needs a lookup first (an album without a Primary, an artist without an image). */
data class MusicCover(val api: Api, val item: Item, val px: Int)

/** Covers of music items (MU-A1): the image now, a [MusicCover] when a lookup comes first, null for the placeholder. */
fun Api.musicArt(item: Item, px: Int): Any? {
    val size = MusicArt.size(px.toFloat())
    return when (val p = MusicArt.plan(item)) {
        is MusicArt.Plan.Image -> image(p.ref.id, "Primary", p.ref.tag, maxWidth = size, maxHeight = size)
        is MusicArt.Plan.Lookup -> MusicCover(this, item, size)
        null -> null
    }
}

class MusicCoverKeyer : Keyer<MusicCover> {
    override fun key(data: MusicCover, options: Options) = "music-cover:${data.api.server.id}:${data.item.id}:${data.px}"
}

// Resolves the borrowed cover (cached in MusicArt), then loads it as any image URL (disk cache, auth, mesh transport).
// Coil starts it only for a card on screen, so lookups follow what is visible.
class MusicCoverFetcher(private val data: MusicCover, private val options: Options, private val loader: ImageLoader) : Fetcher {
    override suspend fun fetch(): FetchResult? {
        val ref = MusicArt.resolve(data.api, data.item) ?: throw IOException("no cover")
        val url = data.api.image(ref.id, "Primary", ref.tag, maxWidth = data.px, maxHeight = data.px)
        val mapped = loader.components.map(url, options)
        val (fetcher) = loader.components.newFetcher(mapped, options, loader) ?: throw IOException("no fetcher")
        return fetcher.fetch()
    }

    class Factory : Fetcher.Factory<MusicCover> {
        override fun create(data: MusicCover, options: Options, imageLoader: ImageLoader): Fetcher = MusicCoverFetcher(data, options, imageLoader)
    }
}
