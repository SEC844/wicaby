package com.wika.wicaby.core.photos

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ItemsResult
import java.util.Calendar
import java.util.GregorianCalendar
import java.util.Locale
import java.util.TimeZone

// Photos (spec PH-01, F7): "on this day". Twin of the desktop's renderer/lib/photos/memories.ts.
// indexes: positions in the takenAt list given, in its order.
data class Memory(val yearsAgo: Int, val indexes: List<Int>)

private fun leap(y: Int) = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0

// Year [y], "MM-DD" [md], moved by [d] days, as "YYYY-MM-DD" (Feb 29 in a common year rolls over, like the desktop).
// minSdk 23 (TV): Calendar in UTC, no java.time.
private fun shiftDay(y: Int, md: String, d: Int): String =
    GregorianCalendar(TimeZone.getTimeZone("UTC")).run {
        clear()
        set(y, md.take(2).toInt() - 1, 1)
        add(Calendar.DAY_OF_MONTH, md.substring(3, 5).toInt() - 1 + d)
        "%04d-%02d-%02d".format(Locale.ROOT, get(Calendar.YEAR), get(Calendar.MONTH) + 1, get(Calendar.DAY_OF_MONTH))
    }

// Assets taken on today's month and day ("YYYY-MM-DD", wall-clock) in earlier years, the nearest year first.
// Feb 29 shows on Feb 28 in a year without one.
fun memories(takenAt: List<String>, today: String): List<Memory> {
    val year = today.take(4).toInt()
    val md = today.substring(5, 10)
    val days = if (md == "02-28" && !leap(year)) listOf("02-28", "02-29") else listOf(md)
    val byYear = sortedMapOf<Int, MutableList<Int>>(reverseOrder())
    takenAt.forEachIndexed { i, t ->
        val y = t.take(4).toInt()
        if (y < year && t.substring(5, 10) in days) byYear.getOrPut(y) { mutableListOf() } += i
    }
    return byYear.map { (y, indexes) -> Memory(year - y, indexes) }
}

// The query side (spec PH-07 Memories source, PH-08 AC3): /Years once, then one premiere-date range per earlier year
// (the 10 nearest), kept by memories() above so the Feb 29 rule matches the desktop. today: "YYYY-MM-DD", the device's
// local date. Each year's photos, nearest year first (desktop source.svelte.ts memoriesOf).
// limit: each range's Limit, 30 by the spec; the home row asks 90 like the desktop (three days of 30).
// shortcut: one range at a time (the desktop runs three); run them concurrently if the home row feels slow.
suspend fun Api.memoryGroups(parentId: String?, today: String, limit: Int = 30): List<Pair<Int, List<Photo>>> {
    val year = today.take(4).toInt()
    val md = today.substring(5, 10)
    val years = get<ItemsResult>(
        "/Years", "UserId" to userId, "ParentId" to parentId, "Recursive" to true, "IncludeItemTypes" to "Photo",
        "SortBy" to "SortName", "SortOrder" to "Descending",
    ).items.mapNotNull { it.productionYear ?: it.name.toIntOrNull() }.filter { it < year }.distinct().sortedDescending().take(10)
    val found = years.flatMap { y ->
        val last = if (md == "02-28" && !leap(year) && leap(y)) "02-29" else md
        photoItems(
            "ParentId" to parentId, "Recursive" to true, "IncludeItemTypes" to "Photo",
            // ±1 day (spec §3.1 step 2): the server may read the zoneless bounds in its own zone; memories() keeps the
            // day. shortcut: a busy eve can still crowd the day out, page if it does.
            "MinPremiereDate" to "${shiftDay(y, md, -1)}T00:00:00", "MaxPremiereDate" to "${shiftDay(y, last, 1)}T23:59:59",
            "SortBy" to "PremiereDate", "SortOrder" to "Ascending", "Limit" to limit,
        ).items
    }.filter { it.imageTags["Primary"] != null }.map { Photo(toAsset(it), it) }
    return memories(found.map { it.asset.takenAt }, today).map { m -> m.yearsAgo to m.indexes.map { found[it] } }
}

// The TV screensaver's Memories source: today's photos, else random stills, so the screensaver never goes black.
suspend fun Api.memoryPhotos(parentId: String?, today: String, limit: Int = 60): List<Item> =
    memoryGroups(parentId, today).flatMap { (_, photos) -> photos.map { it.item } }.take(limit).ifEmpty { randomPhotos(parentId, limit) }

private val homeCache = mutableMapOf<String, List<Pair<Int, List<Photo>>>>()

// Immich's "on this day" (/api/memories), as the home rows' groups; none without a source or without memory.read.
suspend fun immichMemories(today: String): List<Pair<Int, List<Photo>>> =
    if (Immich.source == null) emptyList() else runCatching { Immich.client().memories(today).map { (y, a) -> y to a.map(::immichPhoto) } }.getOrDefault(emptyList())

// The home rows' "Ce jour-là" (PH-08 AC3): every photo library of the server, asked once per server, user and day.
suspend fun Api.homeMemories(today: String): List<Pair<Int, List<Photo>>> {
    val key = "${server.id}/$userId/$today"
    synchronized(homeCache) { homeCache[key] }?.let { return it }
    // An Immich source's own memories join theirs, year by year (photos spec PH-13).
    // And the photo sources' (photo file sources), from their indexes.
    val files = com.wika.wicaby.core.files.FileSources.photoApis().flatMap { a -> runCatching { a.memoryGroups(null, today, limit = 90) }.getOrDefault(emptyList()) }
    val groups = (memoryGroups(null, today, limit = 90) + immichMemories(today) + files).groupBy { it.first }.map { (y, l) -> y to l.flatMap { it.second } }.sortedBy { it.first }
    synchronized(homeCache) {
        homeCache.keys.removeAll { !it.endsWith("/$today") }
        homeCache[key] = groups
    }
    return groups
}
