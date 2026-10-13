package com.wika.wicaby.core.livetv

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.text.Normalizer

// Live TV channel numbers, the name fold and the channel sorts (spec §4.4, §6.5). Mirrors
// D/shared/livetv/channel-order.ts (golden vectors: channel-order.json). Never a Collator: ICU
// differs between Node, the JDK and Android, so every sort goes through nameKey().

private val NUMBER_RE = Regex("^$JS_WS*(\\d+)(?:$JS_WS*[.\\-_ ]$JS_WS*(\\d+))?$JS_WS*$")
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

/** '5.1' → (5,1), '105' → (105,-1), '02' → (2,-1), '' or 'HD1' → null. */
fun parseChannelNumber(s: String?): NumKey? {
    if (s.isNullOrEmpty()) return null
    val m = NUMBER_RE.matchEntire(s) ?: return null
    val major = m.groupValues[1].toLongOrNull()?.takeIf { it <= MAX_SAFE_INTEGER } ?: return null
    val minorText = m.groups[2]?.value
    val minor = if (minorText == null) -1L else minorText.toLongOrNull()?.takeIf { it <= MAX_SAFE_INTEGER } ?: return null
    return NumKey(major, minor)
}

/** Canonical text of a number key: (5,1) → '5.1', (105,-1) → '105'. */
fun numKeyText(k: NumKey): String = if (k.minor < 0) k.major.toString() else "${k.major}.${k.minor}"

/** No number sorts last. */
fun compareNumKey(a: NumKey?, b: NumKey?): Int {
    if (a == null || b == null) return if (a == b) 0 else if (a == null) 1 else -1
    return a.major.compareTo(b.major).takeIf { it != 0 } ?: a.minor.compareTo(b.minor)
}

// ---- nameKey: one fold for sorting, channel search and genre keywords ----

/**
 * Unicode NFD, combining marks U+0300–U+036F dropped, each code point lower-cased on its own (root,
 * simple mapping: Character.toLowerCase(int), so no final-sigma rule), whitespace (≤ U+0020, NBSP,
 * U+2007, U+202F) trimmed and collapsed to one space. 'Œ' and 'ß' stay as they are.
 */
fun nameKey(s: String?): String {
    if (s.isNullOrEmpty()) return ""
    val n = Normalizer.normalize(s, Normalizer.Form.NFD)
    val out = StringBuilder(n.length)
    var space = false
    var i = 0
    while (i < n.length) {
        val cp = n.codePointAt(i)
        val len = Character.charCount(cp)
        val c = n[i].code
        i += len
        if (len == 1 && c in 0x300..0x36F) continue
        if (c <= 0x20 || c == 0xA0 || c == 0x2007 || c == 0x202F) {
            space = out.isNotEmpty()
            continue
        }
        if (space) out.append(' ')
        space = false
        out.appendCodePoint(Character.toLowerCase(cp))
    }
    return out.toString()
}

private fun isDigit(c: Char): Boolean = c in '0'..'9'

/**
 * Natural order of two folded keys: digit runs by value, then by length (leading zeros after),
 * other runs by UTF-16 code units; a digit run sorts before a non-digit run.
 */
fun compareFolded(a: String, b: String): Int {
    var i = 0
    var j = 0
    while (i < a.length && j < b.length) {
        val ca = a[i]
        val cb = b[j]
        val da = isDigit(ca)
        val db = isDigit(cb)
        if (da && db) {
            var ie = i
            while (ie < a.length && isDigit(a[ie])) ie++
            var je = j
            while (je < b.length && isDigit(b[je])) je++
            var ia = i
            while (ia < ie - 1 && a[ia] == '0') ia++
            var jb = j
            while (jb < je - 1 && b[jb] == '0') jb++
            val lenA = ie - ia
            val lenB = je - jb
            if (lenA != lenB) return lenA - lenB
            for (k in 0 until lenA) {
                val d = a[ia + k] - b[jb + k]
                if (d != 0) return d
            }
            val raw = ie - i - (je - j)
            if (raw != 0) return raw
            i = ie
            j = je
            continue
        }
        if (da != db) return if (da) -1 else 1
        if (ca != cb) return ca - cb
        i++
        j++
    }
    return a.length - i - (b.length - j)
}

fun compareNames(a: String, b: String): Int = compareFolded(nameKey(a), nameKey(b))

@Serializable
enum class SortMode(val id: String) {
    @SerialName("number") NUMBER("number"),
    @SerialName("name") NAME("name"),
    @SerialName("recent") RECENT("recent"),
    @SerialName("server") SERVER("server"),
    ;

    companion object {
        fun fromId(id: String?): SortMode? = entries.firstOrNull { it.id == id }
    }
}

/** Numéro: numKey (no number last), then natural name, then id. */
val compareByNumber: Comparator<ChannelRow> = Comparator { a, b ->
    compareNumKey(a.numKey, b.numKey).takeIf { it != 0 } ?: compareNames(a.name, b.name).takeIf { it != 0 } ?: a.id.compareTo(b.id)
}

/** Nom: nameKey natural order, then number, then id. */
val compareByName: Comparator<ChannelRow> = Comparator { a, b ->
    compareNames(a.name, b.name).takeIf { it != 0 } ?: compareNumKey(a.numKey, b.numKey).takeIf { it != 0 } ?: a.id.compareTo(b.id)
}

val compareByServer: Comparator<ChannelRow> = Comparator { a, b ->
    a.serverIndex.compareTo(b.serverIndex).takeIf { it != 0 } ?: a.id.compareTo(b.id)
}

/**
 * Sorts a copy. RECENT puts the MRU ids first (MRU order), then the rest by number.
 * [favFirst] stably moves favourites to the top.
 */
fun sortChannels(rows: List<ChannelRow>, mode: SortMode, mru: List<String> = emptyList(), favFirst: Boolean = false): List<ChannelRow> {
    var out: List<ChannelRow> = if (mode == SortMode.RECENT) {
        val rank = HashMap<String, Int>()
        mru.forEachIndexed { i, id -> if (id !in rank) rank[id] = i }
        rows.sortedWith { a, b ->
            val ra = rank[a.id]
            val rb = rank[b.id]
            when {
                ra != null && rb != null -> ra - rb
                ra != null -> -1
                rb != null -> 1
                else -> compareByNumber.compare(a, b)
            }
        }
    } else {
        rows.sortedWith(
            when (mode) {
                SortMode.NAME -> compareByName
                SortMode.SERVER -> compareByServer
                else -> compareByNumber
            },
        )
    }
    if (favFirst) out = out.filter { it.favorite } + out.filter { !it.favorite }
    return out
}

/** Ids of channels sharing a number key with another channel, grouped in input order. */
fun duplicateNumbers(rows: List<ChannelRow>): List<List<String>> {
    val by = LinkedHashMap<String, MutableList<String>>()
    for (r in rows) {
        val k = r.numKey ?: continue
        by.getOrPut(numKeyText(k)) { mutableListOf() }.add(r.id)
    }
    return by.values.filter { it.size > 1 }
}
