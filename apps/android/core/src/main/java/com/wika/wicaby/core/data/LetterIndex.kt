package com.wika.wicaby.core.data

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import java.text.Normalizer

// The A–Z jump rail of a library sorted by name. Where each letter starts comes from the server itself: for each
// letter, how many items sort before it (NameLessThan, Limit 0: a count, no items), so a jump lands on the right
// offset of a paginated library in its own SortName order, without loading it. Both servers keep SortName lower
// case (leading articles already dropped by their own settings), hence the lower-case bounds.
object LetterIndex {
    const val LETTERS = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ"

    // The rail letter of a name: A–Z with accents folded (É → E), '#' for digits, symbols and other scripts.
    fun letterOf(name: String?): Char {
        val c = name?.trimStart()?.firstOrNull() ?: return '#'
        // Letters NFD does not split: the ligatures and stroked letters of Latin alphabets.
        LIGATURES[c.uppercaseChar()]?.let { return it }
        val base = Normalizer.normalize(c.toString(), Normalizer.Form.NFD)[0].uppercaseChar()
        return if (base in 'A'..'Z') base else '#'
    }

    private val LIGATURES = mapOf('Œ' to 'O', 'Æ' to 'A', 'Ø' to 'O', 'Ł' to 'L', 'Đ' to 'D', 'ẞ' to 'S', 'ß' to 'S')

    fun indexOf(letter: Char): Int = LETTERS.indexOf(letter).coerceAtLeast(0)

    // The 27 bounds asked for: before 'a' … before 'z', then before '{' (just past 'z': the end of Z).
    val bounds: List<String> = ('a'..'z').map { it.toString() } + "{"

    // Each rail letter's first offset, -1 when it has no item. [before][i] = items sorting before bounds[i].
    // '#' holds what sorts before 'a'; what sorts past 'z' (an accent the server does not fold) has no letter.
    fun offsets(before: List<Int>): IntArray {
        require(before.size == bounds.size) { "one count per bound" }
        val out = IntArray(LETTERS.length) { -1 }
        if (before[0] > 0) out[0] = 0
        for (i in 0 until 26) if (before[i + 1] > before[i]) out[i + 1] = before[i]
        return out
    }

    // The letter an offset falls in (the last letter starting at or before it), for entering the rail; 0 ('#') if none.
    fun letterAt(offsets: IntArray, index: Int): Int = offsets.indices.lastOrNull { offsets[it] in 0..index } ?: 0

    // The letter the rail opens on for the item at [index] named [name]: its own (accents folded) when the server sorts
    // it there, else the letter its offset falls in (a leading article the server drops: "The Matrix" sits in M).
    fun entry(offsets: IntArray, index: Int, name: String?): Int {
        val own = indexOf(letterOf(name))
        val start = offsets.getOrElse(own) { -1 }
        val end = offsets.drop(own + 1).firstOrNull { it >= 0 } ?: Int.MAX_VALUE
        return if (start in 0..index && index < end) own else letterAt(offsets, index)
    }

    // The nearest letter with items from [i] going [step] (+1 down, -1 up); [i] itself when none.
    fun next(offsets: IntArray, i: Int, step: Int): Int {
        var j = i + step
        while (j in offsets.indices) {
            if (offsets[j] >= 0) return j
            j += step
        }
        return i
    }

    // The counts, in parallel, with the grid's own [filters] (ParentId, IncludeItemTypes, Recursive…).
    suspend fun load(api: Api, vararg filters: Pair<String, Any?>): IntArray = load { b ->
        api.items(*filters, *countOnly(b)).totalRecordCount
    }

    // The same from any count query (a music library's album artists).
    suspend fun load(count: suspend (bound: String) -> Int): IntArray = coroutineScope { offsets(bounds.map { async { count(it) } }.awaitAll()) }

    fun countOnly(bound: String): Array<Pair<String, Any?>> = arrayOf("NameLessThan" to bound, "Limit" to 0, "EnableImages" to false, "EnableUserData" to false)
}
