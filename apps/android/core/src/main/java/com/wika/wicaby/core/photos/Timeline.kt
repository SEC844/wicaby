package com.wika.wicaby.core.photos

// Photos (spec PH-01): timeline order and grouping. Twin of the desktop's renderer/lib/photos/timeline.ts.
data class Bucket(val key: String, val count: Int, val firstIndex: Int)

// "YYYY-MM-DD", "YYYY-MM" or "YYYY" of a wall-clock takenAt; unit: "day", "month" or "year".
fun groupKey(takenAt: String, unit: String = "month"): String =
    takenAt.take(if (unit == "day") 10 else if (unit == "month") 7 else 4)

// The server pages by DateCreated (UTC); each loaded page is re-sorted by takenAt, newest first, so photos near
// midnight or taken in another zone fall in place. Ties by id, so every client agrees.
val BY_TAKEN_DESC = Comparator<PhotoAsset> { a, b ->
    if (a.takenAt != b.takenAt) b.takenAt.compareTo(a.takenAt) else a.id.compareTo(b.id)
}

// Consecutive runs of one key, over takenAt values already in timeline order.
fun buckets(takenAt: List<String>, unit: String = "month"): List<Bucket> {
    val out = mutableListOf<Bucket>()
    takenAt.forEachIndexed { i, t ->
        val key = groupKey(t, unit)
        val last = out.lastOrNull()
        if (last?.key == key) out[out.size - 1] = last.copy(count = last.count + 1) else out += Bucket(key, 1, i)
    }
    return out
}
