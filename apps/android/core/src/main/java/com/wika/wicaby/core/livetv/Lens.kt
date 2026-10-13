package com.wika.wicaby.core.livetv

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Live TV lenses (spec §6.5, §6.6): hidden channels, favourite order, recents, tags, client groups,
// radio, category rows and the IPTV genre fallback. One pipeline feeds the guide rows, the
// "Toutes les chaînes" list, the mini-guide and the zap list. Mirrors D/shared/livetv/lens.ts
// (golden vectors: lens.json).

@Serializable
data class ClientGroup(val id: String, val name: String, val ids: List<String>)

/** The synced part of the lens state (DisplayPreferences, §5.4). */
data class LensPrefs(
    val favOrder: List<String> = emptyList(),
    val hidden: List<String> = emptyList(),
    val groups: List<ClientGroup> = emptyList(),
    val recents: List<String> = emptyList(),
)

const val RECENTS_MAX = 20

/** Favoris: members in lt.fav order; members missing from it appended in number order; stale ids dropped. */
fun reconcileFavorites(rows: List<ChannelRow>, favOrder: List<String>): List<ChannelRow> {
    val byId = rows.associateBy { it.id }
    val out = ArrayList<ChannelRow>()
    val seen = HashSet<String>()
    for (id in favOrder) {
        val r = byId[id]
        if (r != null && r.favorite && seen.add(id)) out.add(r)
    }
    return out + rows.filter { it.favorite && it.id !in seen }.sortedWith(compareByNumber)
}

/** The favourite order to write back after a reconcile (drops stale ids, appends new members). */
fun favoriteOrder(rows: List<ChannelRow>, favOrder: List<String>): List<String> = reconcileFavorites(rows, favOrder).map { it.id }

/** Moves one id to the front of the MRU (at most [max]). */
fun pushRecent(recents: List<String>, id: String, max: Int = RECENTS_MAX): List<String> =
    (listOf(id) + recents.filter { it != id }).take(maxOf(0, max))

/** Récentes: the stored MRU (existing channels only), topped up from UserData.LastPlayedDate. */
fun recentIds(rows: List<ChannelRow>, recents: List<String>, max: Int = RECENTS_MAX): List<String> {
    val ids = rows.mapTo(HashSet()) { it.id }
    val out = ArrayList<String>()
    for (id in recents) if (id in ids && id !in out && out.size < max) out.add(id)
    if (out.size < max) {
        val played = rows
            .filter { it.lastPlayed != null && it.id !in out }
            .sortedWith { a, b -> (b.lastPlayed ?: 0).compareTo(a.lastPlayed ?: 0).takeIf { it != 0 } ?: compareByNumber.compare(a, b) }
        for (r in played) {
            if (out.size >= max) break
            out.add(r.id)
        }
    }
    return out
}

data class LensInput(
    val rows: List<ChannelRow>,
    val lens: LensRef,
    val prefs: LensPrefs,
    val sort: SortMode,
    val favFirst: Boolean,
)

/**
 * The pipeline: hidden out → lens → sort. Favoris keeps the favourite order and Récentes the MRU
 * order (neither is re-sorted); "Favoris en premier" applies to every other lens.
 */
fun applyLens(input: LensInput): List<ChannelRow> {
    val hidden = input.prefs.hidden.toHashSet()
    val visible = input.rows.filter { it.id !in hidden }
    val mru = recentIds(input.rows, input.prefs.recents)
    fun sorted(list: List<ChannelRow>) = sortChannels(list, input.sort, mru, input.favFirst)
    return when (val lens = input.lens) {
        LensRef.Favorites -> reconcileFavorites(visible, input.prefs.favOrder)
        LensRef.Recents -> {
            val byId = visible.associateBy { it.id }
            mru.mapNotNull { byId[it] }
        }
        LensRef.Radio -> sorted(visible.filter { it.radio })
        is LensRef.Tag -> sorted(visible.filter { lens.tag in it.tags })
        is LensRef.Group -> {
            val members = input.prefs.groups.firstOrNull { it.id == lens.id }?.ids?.toHashSet() ?: emptySet()
            sorted(visible.filter { it.id in members })
        }
        LensRef.All -> sorted(visible)
    }
}

/**
 * The lenses on offer, in bar order (also the ←/→ cycle of the mini-guide): Toutes, Favoris,
 * Récentes, Radio (only when a radio channel exists), server tags (sorted), client groups.
 */
fun availableLenses(rows: List<ChannelRow>, groups: List<ClientGroup>, serverTags: Boolean = true): List<LensRef> {
    val out = mutableListOf<LensRef>(LensRef.All, LensRef.Favorites, LensRef.Recents)
    if (rows.any { it.radio }) out.add(LensRef.Radio)
    if (serverTags) {
        val tags = LinkedHashSet<String>()
        for (r in rows) tags.addAll(r.tags)
        for (tag in tags.sortedWith(::compareTags)) out.add(LensRef.Tag(tag))
    }
    for (g in groups) out.add(LensRef.Group(g.id))
    return out
}

private fun compareTags(a: String, b: String): Int {
    val ka = nameKey(a)
    val kb = nameKey(b)
    return ka.compareTo(kb).takeIf { it != 0 } ?: a.compareTo(b)
}

fun sameLens(a: LensRef, b: LensRef): Boolean = a == b

/** Previous / next lens with wrap; an unknown current lens starts from Toutes. */
fun stepLens(list: List<LensRef>, current: LensRef, delta: Int): LensRef {
    if (list.isEmpty()) return LensRef.All
    val i = list.indexOfFirst { sameLens(it, current) }
    val n = list.size
    return list[if (i < 0) 0 else Math.floorMod(i + delta, n)]
}

// ---- URL state (§3.1): lens=all|fav|recent|radio|movies|…|tag:<name>|group:<id> ----

fun lensToParam(lens: LensRef): String = when (lens) {
    LensRef.Favorites -> "fav"
    LensRef.Recents -> "recent"
    LensRef.Radio -> "radio"
    is LensRef.Tag -> "tag:${lens.tag}"
    is LensRef.Group -> "group:${lens.id}"
    LensRef.All -> "all"
}

@Serializable
data class LensParam(val lens: LensRef, val category: Category? = null)

fun lensFromParam(param: String?): LensParam {
    val p = param ?: ""
    return when {
        p == "fav" -> LensParam(LensRef.Favorites)
        p == "recent" -> LensParam(LensRef.Recents)
        p == "radio" -> LensParam(LensRef.Radio)
        p.startsWith("tag:") && p.length > 4 -> LensParam(LensRef.Tag(p.substring(4)))
        p.startsWith("group:") && p.length > 6 -> LensParam(LensRef.Group(p.substring(6)))
        else -> LensParam(LensRef.All, Category.fromId(p))
    }
}

// ---- Categories (§6.6) ----

fun categoryBits(cat: Category): Int = when (cat) {
    Category.MOVIES -> PF.MOVIE
    Category.SPORTS -> PF.SPORTS
    Category.NEWS -> PF.NEWS
    Category.KIDS -> PF.KIDS
    Category.SERIES -> PF.SERIES
    Category.NEW -> PF.NEW or PF.PREMIERE // "Inédits"; New is always 0 on Jellyfin
}

fun programInCategory(flags: Int, cat: Category): Boolean = (flags and categoryBits(cat)) != 0

/** Cells outside the selected category fade to 35 % (they stay focusable). */
fun dimmed(flags: Int, cat: Category?): Boolean = cat != null && !programInCategory(flags, cat)

/**
 * Rows: intersected with the category channel set only when the server honours the filter.
 * "Inédits" has no channel-level flag except Emby's optional IsNewOrPremiere (same probe).
 */
fun categoryRows(rows: List<ChannelRow>, cat: Category?, set: Collection<String>?, filterOnChannels: Tri): List<ChannelRow> {
    if (cat == null || filterOnChannels != Tri.TRUE || set == null) return rows.toList()
    val s = set as? Set<String> ?: set.toHashSet()
    return rows.filter { it.id in s }
}

/** Probe 1: a set as large as the whole lineup (> 20 channels) means the server ignored the flag. */
fun categoryRowsProbe(setSize: Int, channelCount: Int): Boolean = !(setSize == channelCount && channelCount > 20)

private const val CATEGORY_MASK = PF.MOVIE or PF.SPORTS or PF.NEWS or PF.KIDS

/** Probe 2's verdict: 'flags', or 'probe' (an onNow page with Fields=Genres must decide). */
@Serializable
enum class TileCategoryVerdict {
    @SerialName("flags") FLAGS,
    @SerialName("probe") PROBE,
}

/**
 * Probe 2 (after the first 3 tiles): FLAGS when the programmes carry category flags (or the lineup
 * is small); PROBE when an onNow page with Fields=Genres must decide.
 */
fun categorySourceFromTiles(programFlags: List<Int>, channelCount: Int): TileCategoryVerdict {
    if (programFlags.any { (it and CATEGORY_MASK) != 0 }) return TileCategoryVerdict.FLAGS
    return if (channelCount > 20) TileCategoryVerdict.PROBE else TileCategoryVerdict.FLAGS
}

/** The genre probe's verdict: GENRES when any genre maps through the keyword table, else UNKNOWN (chips hidden). */
fun categorySourceFromGenres(genreLists: List<List<String>>): CategorySource =
    if (genreLists.any { genreFlags(it) != 0 }) CategorySource.GENRES else CategorySource.UNKNOWN

// ---- Genre keyword table (server data, never translated; matched on nameKey tokens) ----
// A plain entry matches a contiguous run of whole tokens ("info" never matches "informatique");
// an exact entry (ETSI EN 300 468 content names, as XMLTV grabbers emit them) matches the whole genre.

class GenreRule(val bit: Int, val words: List<String>, val exact: List<String>) {
    internal val wordTokens: List<List<String>> by lazy { words.map(::genreTokens) }
    internal val exactTokens: List<List<String>> by lazy { exact.map(::genreTokens) }
}

val GENRE_TABLE: List<GenreRule> = listOf(
    // Sport → PF.SPORTS
    GenreRule(PF.SPORTS, listOf("sport", "sports", "football", "soccer", "rugby", "tennis", "basket", "cyclisme", "f1", "motorsport", "deportes", "fussball", "calcio"), listOf("sports")),
    // Films → PF.MOVIE
    GenreRule(PF.MOVIE, listOf("film", "films", "movie", "movies", "cinéma", "téléfilm", "téléfilms", "spielfilm", "cine", "pelicula", "película"), listOf("movie / drama")),
    // Infos → PF.NEWS
    GenreRule(PF.NEWS, listOf("info", "infos", "news", "journal", "actualité", "actualités", "nachrichten", "noticias", "notiziario"), listOf("news / current affairs")),
    // Jeunesse → PF.KIDS
    GenreRule(PF.KIDS, listOf("jeunesse", "enfants", "kids", "children", "animation", "dessin animé", "dessins animés", "kinder", "infantil"), listOf("children's / youth programmes")),
    // Séries → PF.SERIES
    GenreRule(PF.SERIES, listOf("série", "séries", "series", "feuilleton", "sitcom", "serie"), listOf("tv series")),
)

/** Token separators: whitespace and controls, ASCII punctuation, NBSP, typographic quotes and dashes. */
private fun isSeparator(c: Int): Boolean =
    c <= 0x20 || c in 0x21..0x2F || c in 0x3A..0x40 || c in 0x5B..0x60 || c in 0x7B..0x7E ||
        c == 0xA0 || c == 0x2018 || c == 0x2019 || c == 0x2013 || c == 0x2014

fun genreTokens(s: String): List<String> {
    val k = nameKey(s)
    val out = ArrayList<String>()
    val cur = StringBuilder()
    for (ch in k) {
        if (isSeparator(ch.code)) {
            if (cur.isNotEmpty()) out.add(cur.toString())
            cur.setLength(0)
        } else {
            cur.append(ch)
        }
    }
    if (cur.isNotEmpty()) out.add(cur.toString())
    return out
}

private fun containsRun(hay: List<String>, needle: List<String>): Boolean {
    if (needle.isEmpty() || needle.size > hay.size) return false
    for (i in 0..hay.size - needle.size) {
        if (needle.indices.all { j -> hay[i + j] == needle[j] }) return true
    }
    return false
}

/** PF bits for a programme's Genres through the keyword table. */
fun genreFlags(genres: List<String>): Int {
    var f = 0
    for (g in genres) {
        val toks = genreTokens(g)
        if (toks.isEmpty()) continue
        for (rule in GENRE_TABLE) {
            if ((f and rule.bit) != 0) continue
            if (rule.exactTokens.any { it == toks } || rule.wordTokens.any { containsRun(toks, it) }) f = f or rule.bit
        }
    }
    return f
}

// ---- Channel search (§6.8): name (folded, substring), number prefix, Emby tag; at most 8 ----

private val NUM_QUERY_RE = Regex("^\\d+(?:[.\\-_ ]\\d*)?$")
private val NUM_SEP_RE = Regex("[\\-_ ]")
private val ROW_NUM_SEP_RE = Regex("$JS_WS*[\\-_ ]$JS_WS*")

fun searchChannels(rows: List<ChannelRow>, query: String, limit: Int = 8): List<ChannelRow> {
    val q = nameKey(query)
    if (q.isEmpty()) return emptyList()
    val numQ = if (NUM_QUERY_RE.matches(q)) NUM_SEP_RE.replaceFirst(q, ".") else null
    val scored = ArrayList<Pair<ChannelRow, Int>>()
    for (r in rows) {
        var score = -1
        val num = ROW_NUM_SEP_RE.replaceFirst(jsTrim(r.number), ".")
        if (numQ != null && num == numQ) {
            score = 0
        } else if (numQ != null && num.startsWith(numQ)) {
            score = 1
        } else {
            val name = nameKey(r.name)
            score = when {
                name.startsWith(q) -> 2
                name.contains(q) -> 3
                r.tags.any { nameKey(it).contains(q) } -> 4
                else -> -1
            }
        }
        if (score >= 0) scored.add(r to score)
    }
    return scored
        .sortedWith { a, b -> (a.second - b.second).takeIf { it != 0 } ?: compareByNumber.compare(a.first, b.first) }
        .take(maxOf(0, limit))
        .map { it.first }
}
