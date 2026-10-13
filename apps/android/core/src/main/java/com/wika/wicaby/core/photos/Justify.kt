package com.wika.wicaby.core.photos

// Photos (spec PH-01, §0): our own justified rows, a textbook greedy row fill. No Immich or Flickr code.
// Twin of the desktop's renderer/lib/photos/justify.ts: same operations in the same order, so the same doubles.
data class RowItem(val index: Int, val x: Double, val w: Double)

data class Row(val top: Double, val height: Double, val items: List<RowItem>)

// Row tops count from below the section header.
data class Section(val key: String, val top: Double, val height: Double, val rows: List<Row>)

// Fills a row at targetH until it is as wide as `width`, then scales it down to fit, unless dropping its last item
// gives a height closer to targetH (at most maxScale × targetH). A panorama wider than 3:1 gets a row of its own
// (at most maxScale × targetH high). A row cut short, the last one or one before a panorama, keeps targetH,
// left-aligned. Indexes start at `first`; a bad aspect counts as 1.
fun justify(aspects: List<Double>, width: Double, targetH: Double, gap: Double, maxScale: Double = 1.6, first: Int = 0): List<Row> {
    val rows = mutableListOf<Row>()
    if (!(width > 0 && targetH > 0)) return rows
    fun ar(i: Int) = aspects[i].let { if (it > 0 && it.isFinite()) it else 1.0 }
    fun fit(row: List<Int>): Double {
        var sum = 0.0
        for (i in row) sum += ar(i)
        return (width - gap * (row.size - 1)) / sum
    }
    var top = 0.0
    fun emit(row: List<Int>, h: Double) {
        var x = 0.0
        val items = row.map { i ->
            val w = ar(i) * h
            val it = RowItem(i + first, x, w)
            x += w + gap
            it
        }
        rows += Row(top, h, items)
        top += h + gap
    }
    var row = mutableListOf<Int>()
    for (i in aspects.indices) {
        if (ar(i) > 3) {
            if (row.isNotEmpty()) emit(row, minOf(fit(row), targetH))
            row = mutableListOf()
            emit(listOf(i), minOf(width / ar(i), targetH * maxScale))
            continue
        }
        row += i
        val h = fit(row)
        if (h > targetH) continue
        if (row.size > 1) {
            val without = row.dropLast(1)
            val h2 = fit(without)
            if (h2 <= targetH * maxScale && h2 / targetH < targetH / h) {
                emit(without, h2)
                row = mutableListOf(i)
                if (fit(row) <= targetH) {
                    emit(row, fit(row))
                    row = mutableListOf()
                }
                continue
            }
        }
        emit(row, h)
        row = mutableListOf()
    }
    if (row.isNotEmpty()) emit(row, minOf(targetH, fit(row)))
    return rows
}

// The timeline: per bucket a header, then its rows; section tops feed the date scrubber.
fun layoutTimeline(buckets: List<Bucket>, aspects: List<Double>, width: Double, targetH: Double, gap: Double, headerH: Double, maxScale: Double = 1.6): List<Section> {
    var top = 0.0
    return buckets.map { b ->
        val rows = justify(aspects.subList(b.firstIndex, b.firstIndex + b.count), width, targetH, gap, maxScale, b.firstIndex)
        val last = rows.lastOrNull()
        val height = headerH + (if (last != null) last.top + last.height else 0.0)
        val s = Section(b.key, top, height, rows)
        top += height + gap
        s
    }
}
