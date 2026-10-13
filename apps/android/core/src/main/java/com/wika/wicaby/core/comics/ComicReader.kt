package com.wika.wicaby.core.comics

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.Api
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.abs
import kotlin.math.min

// One open book, observed by the TV and mobile reader screens: loading state, page sizes,
// direction and mode, the decoded page window and the progress written back to the server.
// [keep] is how many pages each side of the visible ones stay decoded (2 on TV, 3 on mobile).
class ComicReader(
    private val api: Api,
    val itemId: String,
    private val keep: Int,
    private val scope: CoroutineScope,
    // Decoded pixels per page, in screens: enough for a ×2 zoom without blowing a TV's RAM.
    private val pixelBudget: Float = 2f,
) {
    sealed interface State {
        data class Loading(val progress: Float) : State
        data class Failed(val message: String) : State
        data object Ready : State
    }

    var state by mutableStateOf<State>(State.Loading(0f))
        private set
    var title by mutableStateOf("")
        private set
    var meta by mutableStateOf(ComicMeta())
        private set
    val sizes = mutableStateListOf<PageSize>()
    val pageCount get() = sizes.size

    // Manga order and long-strip mode: from ComicInfo and page shapes, then the reader's own choice.
    var rtl by mutableStateOf(false)
        private set
    var webtoon by mutableStateOf(false)
        private set

    // First page of the visible spread (paged) or the top page (webtoon).
    var page by mutableIntStateOf(0)
        private set

    // Decode box in pixels, set by the screen from its size.
    @Volatile
    var screen: Pair<Int, Int> = 1920 to 1080

    private val bitmaps = mutableStateMapOf<Int, Bitmap>()
    private val thumbs = mutableStateMapOf<Int, Bitmap>()
    private val jobs = HashMap<Int, Job>()
    private val thumbJobs = HashMap<Int, Job>()
    private var archive: ComicArchive? = null
    private var readPage = -1
    private var savedPage = -1
    private var saveJob: Job? = null

    @OptIn(ExperimentalCoroutinesApi::class)
    private val decoder = Dispatchers.IO.limitedParallelism(2)

    private val prefs get() = Core.app.getSharedPreferences("comics", Context.MODE_PRIVATE)
    private val prefKey get() = "${api.server.id}-$itemId"

    fun start(fromStart: Boolean) {
        scope.launch {
            try {
                val item = Comics.item(api, itemId)
                title = item.name
                val a = Comics.open(api, item) { p -> state = State.Loading(p) }
                archive = a
                meta = a.meta
                sizes.clear()
                sizes.addAll(a.sizes)
                val stored = prefs.getString(prefKey, null)?.split(',')
                rtl = stored?.getOrNull(0)?.toBooleanStrictOrNull() ?: (a.meta.manga == true)
                webtoon = stored?.getOrNull(1)?.toBooleanStrictOrNull() ?: ComicPages.isWebtoon(a.meta, a.sizes)
                val local = Comics.saved[itemId]
                val start = when {
                    fromStart -> 0
                    local != null -> if (local.played) 0 else local.page
                    else -> ComicProgress.startPage(item.userData?.playbackPositionTicks, item.userData?.played == true, a.pageCount)
                }.coerceIn(0, a.pageCount - 1)
                page = start
                readPage = start
                savedPage = start
                state = State.Ready
            } catch (e: CancellationException) {
                throw e
            } catch (e: ComicException) {
                state = State.Failed(e.message.orEmpty())
            } catch (e: Exception) {
                state = State.Failed(Core.str(R.string.reader_load_error))
            }
        }
    }

    fun spreads(double: Boolean): List<List<Int>> = ComicPages.spreads(sizes, double && !webtoon)

    fun toggleRtl() {
        rtl = !rtl
        storePrefs()
    }

    fun toggleWebtoon() {
        webtoon = !webtoon
        storePrefs()
    }

    private fun storePrefs() = prefs.edit().putString(prefKey, "$rtl,$webtoon").apply()

    // The screen moved to these pages. Reaching the last page counts as reading it.
    fun show(visible: List<Int>) {
        if (visible.isEmpty() || pageCount == 0) return
        page = visible.first()
        readPage = if (pageCount - 1 in visible) pageCount - 1 else visible.first()
        window(visible)
        saveJob?.cancel()
        saveJob = scope.launch {
            delay(1500)
            save()
        }
    }

    fun bitmap(i: Int): Bitmap? = bitmaps[i]

    fun thumb(i: Int): Bitmap? = thumbs[i]

    // Strip thumbnails, decoded small and kept around the part of the strip on screen.
    fun loadThumb(i: Int) {
        if (i !in 0 until pageCount || thumbs.containsKey(i) || thumbJobs.containsKey(i)) return
        thumbJobs[i] = scope.launch {
            val bmp = withContext(decoder) { decode(i, 120, 120 * 480) }
            if (bmp != null) {
                thumbs[i] = bmp
                if (thumbs.size > 60) thumbs.keys.sortedByDescending { abs(it - i) }.take(thumbs.size - 60).forEach { thumbs.remove(it) }
            }
            thumbJobs.remove(i)
        }
    }

    // Decode the visible pages first, then the reading direction, then behind; drop the rest.
    private fun window(visible: List<Int>) {
        val first = visible.min()
        val last = visible.max()
        val wanted = (visible + (1..keep).map { last + it } + (1..keep).map { first - it }).filter { it in 0 until pageCount }
        val range = (first - keep)..(last + keep)
        bitmaps.keys.filter { it !in range }.forEach { bitmaps.remove(it) }
        jobs.keys.filter { it !in range }.forEach { jobs.remove(it)?.cancel() }
        for (i in wanted) {
            if (bitmaps.containsKey(i) || jobs.containsKey(i)) continue
            jobs[i] = scope.launch {
                val (w, h) = screen
                val size = sizes.getOrNull(i) ?: PageSize(0, 0)
                // Enough for a ×2 zoom of the page fitted to the screen (or the strip width).
                val shown = if (webtoon) min(w, h) else min(w.toFloat(), h * size.aspect).toInt()
                val bmp = withContext(decoder) { decode(i, shown * 2, (w * h * pixelBudget).toInt()) }
                if (bmp != null) bitmaps[i] = bmp
                jobs.remove(i)
            }
        }
    }

    // BitmapFactory with a power-of-two sample: at least about reqW wide, under maxPixels.
    private fun decode(i: Int, reqW: Int, maxPixels: Int): Bitmap? {
        val a = archive ?: return null
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            a.open(i).use { BitmapFactory.decodeStream(it, null, bounds) }
            val w = bounds.outWidth
            val h = bounds.outHeight
            if (w <= 0 || h <= 0) return null
            // A header the archive scan could not read: the real size fixes the layout.
            if (sizes.getOrNull(i)?.known == false) scope.launch { if (i < sizes.size) sizes[i] = sizes[i].copy(width = w, height = h) }
            var s = 1
            while (w / (s * 2) >= reqW) s *= 2
            while ((w / s).toLong() * (h / s) > maxPixels) s *= 2
            sampled(a, i, s)
        } catch (e: Exception) {
            null
        } catch (e: OutOfMemoryError) {
            null
        }
    }

    // Short on memory: half the resolution rather than a blank page.
    private fun sampled(a: ComicArchive, i: Int, s: Int): Bitmap? = try {
        a.open(i).use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = s }) }
    } catch (e: OutOfMemoryError) {
        if (s < 16) sampled(a, i, s * 2) else null
    }

    private suspend fun save() {
        val p = readPage
        val n = pageCount
        if (p < 0 || p == savedPage || n == 0) return
        savedPage = p
        runCatching { Comics.saveProgress(api, itemId, p, n) }
    }

    // Leaving the reader: the last position goes out even though the screen is gone.
    fun close() {
        saveJob?.cancel()
        jobs.values.forEach { it.cancel() }
        thumbJobs.values.forEach { it.cancel() }
        val a = archive
        archive = null
        val p = readPage
        val n = pageCount
        val needSave = p >= 0 && p != savedPage && n > 0
        Core.scope.launch {
            if (needSave) runCatching { Comics.saveProgress(api, itemId, p, n) }
            runCatching { a?.close() }
        }
    }
}
