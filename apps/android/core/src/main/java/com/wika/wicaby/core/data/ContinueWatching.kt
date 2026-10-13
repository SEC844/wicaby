package com.wika.wicaby.core.data

import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.livetv.parseServerDate
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

// One card removed from Continue Watching: `serverId:userId:itemId`, and the card's date then ("" = none).
@Serializable
data class HiddenEntry(val key: String, val played: String = "")

// The merged row and the series dates it was sorted with (removing a card stores its date).
data class ContinueRow(val items: List<Item>, val seriesDates: Map<String, String>)

// Merged "Continuer à regarder" (feature-specs.md X-01), as on the desktop (renderer/lib/continue.ts):
// in-progress items and next-up episodes in one row, one card per series, most recently watched first,
// minus the cards the user removed. The pure part is tested in ContinueWatchingTest.
object ContinueWatching {
    const val HIDE_CAP = 500

    private fun time(d: String?): Long = parseServerDate(d?.takeIf { it.isNotEmpty() }) ?: 0L

    fun inProgress(item: Item) = (item.userData?.playbackPositionTicks ?: 0) > 0

    // The date a card sorts and un-hides by: its own last play when in progress, its series' for a next-up one.
    fun recency(item: Item, series: Map<String, String>): String =
        if (inProgress(item)) item.userData?.lastPlayedDate.orEmpty()
        else item.seriesId?.let { series[it] } ?: item.userData?.lastPlayedDate.orEmpty()

    fun merge(resume: List<Item>, nextUp: List<Item>, series: Map<String, String>): List<Item> {
        // Emby's Resume can mix in rows without a position: those are next-up material.
        val (started, rest) = resume.partition(::inProgress)
        val seen = started.mapTo(HashSet()) { it.seriesId ?: it.id }
        val out = started.toMutableList()
        for (it in rest + nextUp) if (seen.add(it.seriesId ?: it.id)) out += it
        return newestFirst(out, series)
    }

    // Newest first; undated cards after the dated ones, in server order (sortedWith is stable).
    private fun newestFirst(out: List<Item>, series: Map<String, String>): List<Item> {
        val t = out.associateWith { time(recency(it, series)) }
        return out.sortedWith(compareByDescending<Item> { t.getValue(it) > 0 }.thenByDescending { t.getValue(it) })
    }

    // The card line: "Suivant : S2·É5" on a next-up episode, the time left on an in-progress film; null keeps the
    // card's own line (an in-progress episode shows its code and title, with the progress bar).
    fun subtitle(item: Item): String? = when {
        inProgress(item) && !item.isEpisode ->
            runtimeText((item.runTimeTicks ?: 0) - (item.userData?.playbackPositionTicks ?: 0))?.let { Core.str(R.string.continue_time_left, it) }
        !inProgress(item) && item.isEpisode && item.indexNumber != null -> Core.str(R.string.next_episode_short, item.parentIndexNumber ?: 0, item.indexNumber)
        else -> null
    }

    fun key(serverId: String, userId: String, itemId: String) = "$serverId:$userId:$itemId"

    // Hidden until the card's date grows (it was played again).
    fun isHidden(list: List<HiddenEntry>, key: String, played: String): Boolean {
        val e = list.firstOrNull { it.key == key } ?: return false
        return time(played) <= time(e.played)
    }

    // Newest last; the oldest entries go past HIDE_CAP.
    fun withHidden(list: List<HiddenEntry>, key: String, played: String): List<HiddenEntry> =
        (list.filter { it.key != key } + HiddenEntry(key, played)).takeLast(HIDE_CAP)

    fun withoutHidden(list: List<HiddenEntry>, key: String): List<HiddenEntry> = list.filter { it.key != key }

    private val codec = ListSerializer(HiddenEntry.serializer())

    fun decode(s: String): List<HiddenEntry> = if (s.isBlank()) emptyList() else runCatching { json.decodeFromString(codec, s) }.getOrDefault(emptyList())

    fun encode(list: List<HiddenEntry>): String = json.encodeToString(codec, list)

    private fun Api.keyOf(item: Item) = key(server.id, userId.orEmpty(), item.id)

    // Resume, next up and the series dates (one batched call), minus the hidden cards.
    suspend fun load(api: Api): ContinueRow = coroutineScope {
        val resume = async { api.resume() }
        val nextUp = async { api.nextUp() }
        val r = resume.await()
        val n = nextUp.await()
        val ids = (r + n).filter { !inProgress(it) }.mapNotNull { it.seriesId }.distinct()
        // Without dates the next-up cards keep the server order, after the dated ones.
        val series = runCatching { api.seriesUserData(ids) }.getOrDefault(emptyMap())
        val hidden = decode(Core.prefs.continueHidden())
        ContinueRow(merge(r, n, series).filterNot { isHidden(hidden, api.keyOf(it), recency(it, series)) }, series)
    }

    // TP-06: every signed-in server's row in one (desktop Home.svelte): newest first, one card per title.
    // Alone, exactly load(primary). shortcut: series dates are keyed by series id only; two Emby servers
    // with a clashing numeric id share a date, upgrade to server-scoped keys if that ever shows.
    suspend fun loadAll(primary: Api): ContinueRow {
        // File sources join only with "Show file sources on Home" on (caps homeOptIn, file-sources spec D10).
        val apis = listOf(primary) + Servers.online.filter { it.server.id != primary.server.id } + com.wika.wicaby.core.files.FileSources.forHome()
        if (apis.size == 1) return load(primary)
        val rows = Servers.each(apis) { a ->
            load(a).let { r -> r.copy(items = r.items.map { if (it.serverId == null) it.copy(serverId = a.server.id) else it }) }
        }
        val series = rows.fold(emptyMap<String, String>()) { m, r -> m + r?.seriesDates.orEmpty() }
        return ContinueRow(Servers.dedupe(newestFirst(rows.flatMap { it?.items.orEmpty() }, series)), series)
    }

    // Emby also hides an in-progress item on the server (a 404 there means unsupported: the local list covers it);
    // next-up cards and Jellyfin hide locally only.
    suspend fun remove(api: Api, item: Item, series: Map<String, String>) {
        Core.prefs.setContinueHidden(encode(withHidden(decode(Core.prefs.continueHidden()), api.keyOf(item), recency(item, series))))
        if (api.server.isEmby && inProgress(item)) runCatching { api.hideFromResume(item.id, true) }
    }

    suspend fun undo(api: Api, item: Item) {
        if (api.server.isEmby && inProgress(item)) runCatching { api.hideFromResume(item.id, false) }
        Core.prefs.setContinueHidden(encode(withoutHidden(decode(Core.prefs.continueHidden()), api.keyOf(item))))
    }
}
