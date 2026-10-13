package com.wika.wicaby.core.livetv

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

// Live TV search shared by the guide search (spec §6.8, LT-10) and the library search (TP-12):
// channels from a typed or spoken query, programmes from the server with the loaded tiles as fallback.

// Spoken numbers the recognizer may leave as words ("chaîne cinq", "France deux"), after nameKey's fold.
private val NUMBER_WORDS = mapOf(
    "zero" to 0, "un" to 1, "une" to 1, "deux" to 2, "trois" to 3, "quatre" to 4, "cinq" to 5, "six" to 6, "sept" to 7,
    "huit" to 8, "neuf" to 9, "dix" to 10, "onze" to 11, "douze" to 12, "treize" to 13, "quatorze" to 14, "quinze" to 15,
    "seize" to 16, "vingt" to 20,
    "one" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5, "seven" to 7, "eight" to 8, "nine" to 9, "ten" to 10,
    "eleven" to 11, "twelve" to 12, "thirteen" to 13, "fourteen" to 14, "fifteen" to 15, "sixteen" to 16, "seventeen" to 17,
    "eighteen" to 18, "nineteen" to 19, "twenty" to 20,
)

// "chaîne 5", "la chaîne numéro 5", "channel 5", "the channel number five" (folded: no accents, lower case).
private val CHANNEL_PREFIX_RE = Regex("^(?:(?:la|the)\\s+)?(?:chaine|channel|canal)(?:\\s+(?:numero|number|no))?(?:\\s+|$)")

/** The query as a lineup reads it: folded (case, accents), number words as digits, a leading "chaîne"/"channel" dropped. */
fun voiceChannelQuery(query: String): String =
    CHANNEL_PREFIX_RE.replaceFirst(nameKey(query).split(' ').joinToString(" ") { NUMBER_WORDS[it]?.toString() ?: it }, "").trim()

/**
 * Channels for a typed or spoken query: the voice reading first ("chaîne 5" is number 5, "France deux" is
 * France 2), then the plain search; with neither, names also match without spaces ("TF 1" finds TF1).
 */
fun voiceChannels(rows: List<ChannelRow>, query: String, limit: Int = 8): List<ChannelRow> {
    val q = voiceChannelQuery(query)
    val hits = LinkedHashSet<ChannelRow>()
    hits += searchChannels(rows, q, limit)
    hits += searchChannels(rows, query, limit)
    val compact = q.replace(" ", "")
    if (hits.isEmpty() && compact.isNotEmpty()) rows.filterTo(hits) { nameKey(it.name).replace(" ", "").contains(compact) }
    return hits.take(maxOf(0, limit))
}

/** Servers whose Jellyfin /Items search found nothing the cache had (caps.programSearch = memory). */
private val memorySearch = HashSet<String>()

private suspend fun LiveTvRepository.memoryPrograms(q: String): List<ProgramLite> = withContext(Dispatchers.Default) {
    val k = nameKey(q)
    val now = this@memoryPrograms.now()
    val out = ArrayList<ProgramLite>()
    for (r in channels.value) for (p in programs(r.id, now - HOUR, now + 8 * 24 * HOUR)) if (nameKey(p.title).contains(k)) out.add(p)
    out.sortedBy { it.start }.take(30)
}

/** Programmes from an hour ago to [guideEnd] (Emby asks the server; Jellyfin probes /Items and falls back to the loaded tiles). */
suspend fun LiveTvRepository.searchPrograms(q: String, guideEnd: Long): List<ProgramLite> {
    val caps = this.caps.value
    if (caps.programSearch == ProgramSearch.MEMORY || api.serverId in memorySearch) return memoryPrograms(q)
    val now = this.now()
    return try {
        val items = ((api.json(Dialect.searchPrograms(api.kind, api.userId, q, now, guideEnd)) as? JsonObject)?.get("Items") as? JsonArray).orEmpty()
        val list = items.mapNotNull { (it as? JsonObject)?.let { o -> normalizeProgram(o, api.kind, caps.categorySource) } }.filter { it.end > now - HOUR }
        if (list.isEmpty() && api.kind == ServerKind.JELLYFIN) {
            memoryPrograms(q).also { if (it.isNotEmpty()) memorySearch.add(api.serverId) }
        } else {
            list.sortedBy { it.start }.take(30)
        }
    } catch (_: LiveApiException) {
        memoryPrograms(q)
    }
}
