package com.wika.wicaby.core.data

import com.wika.wicaby.core.livetv.parseServerDate
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import java.text.Collator
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import kotlin.math.roundToLong

// The recently played list and the series genres its stats need (episodes rarely carry their own).
data class HistoryData(val items: List<Item>, val seriesGenres: Map<String, List<String>>)

data class WatchStats(val weekMs: Long, val monthMs: Long, val genres: List<String>)

// Watch history and personal stats (TP-08), as on the desktop History page (shared/history.ts,
// renderer/routes/History.svelte): same server queries, same grouping and stats. Pure part tested in
// WatchHistoryTest with the fixtures of tools/checks/desk-shell-check.mjs.
object WatchHistory {
    private const val DAY_MS = 86_400_000L

    fun lastPlayed(item: Item): Long = parseServerDate(item.userData?.lastPlayedDate?.takeIf { it.isNotEmpty() }) ?: 0L

    // Items ever played, most recent first.
    fun recentFirst(items: List<Item>): List<Item> = items.filter { lastPlayed(it) > 0 }.sortedByDescending(::lastPlayed)

    // Local midnight of a timestamp.
    fun dayStart(ms: Long, zone: TimeZone = TimeZone.getDefault()): Long = Calendar.getInstance(zone).run {
        timeInMillis = ms
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
        timeInMillis
    }

    // 0 = today, 1 = yesterday… in local calendar days (DST-safe through rounding).
    fun daysAgo(day: Long, now: Long = System.currentTimeMillis(), zone: TimeZone = TimeZone.getDefault()): Int =
        ((dayStart(now, zone) - day).toDouble() / DAY_MS).roundToLong().toInt()

    // Recently played items grouped by local day, newest day first.
    fun groupByDay(items: List<Item>, zone: TimeZone = TimeZone.getDefault()): List<Pair<Long, List<Item>>> =
        recentFirst(items).groupBy { dayStart(lastPlayed(it), zone) }.toList()

    // shortcut: the server keeps only the last play date per item, so a rewatch counts once and an
    // unfinished item counts up to its saved position (as on desktop); exact totals need the Playback Reporting plugin.
    fun stats(items: List<Item>, seriesGenres: Map<String, List<String>> = emptyMap(), now: Long = System.currentTimeMillis()): WatchStats {
        var weekMs = 0L
        var monthMs = 0L
        val counts = LinkedHashMap<String, Int>()
        for (item in recentFirst(items)) {
            val ticks = if (item.userData?.played == true) item.runTimeTicks ?: 0 else item.userData?.playbackPositionTicks ?: 0
            val ms = ticks / TICKS_PER_MS
            val age = now - lastPlayed(item)
            if (age <= 7 * DAY_MS) weekMs += ms
            if (age <= 30 * DAY_MS) monthMs += ms
            // Episodes rarely carry genres of their own: their series' count instead.
            val genres = item.genres.ifEmpty { item.seriesId?.let { seriesGenres[it] }.orEmpty() }
            for (g in genres) counts[g] = (counts[g] ?: 0) + 1
        }
        val byName = Collator.getInstance(Locale.ROOT)
        val genres = counts.entries.sortedWith { a, b -> if (a.value != b.value) b.value - a.value else byName.compare(a.key, b.key) }.map { it.key }.take(5)
        return WatchStats(weekMs, monthMs, genres)
    }

    // History.svelte's query: Recursive, Movie,Episode, DatePlayed descending, 200 (Api.items adds the list fields,
    // Genres among them), once with Filters=IsPlayed and once with IsResumable. Emby can sort never-played items
    // before played ones on DatePlayed, so an unfiltered query may hold no history at all.
    val QUERY = arrayOf<Pair<String, Any?>>("Recursive" to true, "IncludeItemTypes" to "Movie,Episode", "SortBy" to "DatePlayed", "SortOrder" to "Descending", "Limit" to 200)
    val FILTERS = listOf("IsPlayed", "IsResumable")

    // As History.svelte: that query on every signed-in server online (fanOut), merged newest first (merge(…, true));
    // never-played ones come last and are dropped. A server that fails is left out; all of them failing is an error.
    // Then one lookup per server of the series whose episodes carry no genres.
    suspend fun load(api: Api): HistoryData {
        val apis = listOf(api) + Servers.online.filter { it.server.id != api.server.id }
        val found = Servers.fanOut(apis) { a -> FILTERS.flatMap { f -> a.items(*QUERY, "Filters" to f).items } }
        if (found.all { it == null }) throw java.io.IOException("history: no server answered")
        val list = Servers.merge(found, byDate = true)
        val missing = list.filter { it.genres.isEmpty() && it.seriesId != null && it.userData?.lastPlayedDate != null }
            .groupBy({ it.serverId }, { it.seriesId!! })
        val genres = coroutineScope {
            missing.map { (sid, ids) ->
                async {
                    runCatching {
                        (Servers.of(sid) ?: api).items("Ids" to ids.distinct().take(50).joinToString(","), "EnableImages" to false).items
                    }.getOrDefault(emptyList())
                }
            }.awaitAll().flatten().associate { it.id to it.genres }
        }
        return HistoryData(list, genres)
    }
}
