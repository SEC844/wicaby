package com.wika.wicaby.core.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Home layout, desktop ui.homeRows (Home.svelte, HomeSheet.svelte): per user, the row ids in display
// order and the hidden ones; rows the saved order does not know yet (a new library) keep their default place.
// `thumb`: the Latest rows shown as thumbnails instead of posters (Android only; desktop's rows are fixed).
object HomeRows {
    const val RESUME = "resume" // "Continue Watching", merged or not (desktop keeps the id when merged)
    const val NEXT_UP = "nextUp"
    const val UPCOMING = "upcoming"
    const val LIVE_NOW = "liveNow" // desktop: only when a server has Live TV
    const val BECAUSE = "because"
    const val MEMORIES = "memories" // photos "On this day" (PH-08): only when a photo library exists
    private const val LATEST = "latest:"

    fun latest(viewId: String) = LATEST + viewId
    fun latestViewId(id: String): String? = id.takeIf { it.startsWith(LATEST) }?.removePrefix(LATEST)

    // `thumb` has a new stored key: a stale 0.4.0-0.4.2 "Thumb" set kept a Latest row in thumbnails (a reported
    // Films row), so the old key is dropped once (ignoreUnknownKeys) and only picks made from now on count.
    @Serializable
    data class Pref(
        val order: List<String> = emptyList(),
        val hidden: Set<String> = emptySet(),
        @SerialName("thumbRows") val thumb: Set<String> = emptySet(),
    )

    // The rows Android has, in desktop's default order.
    fun defaults(latestViewIds: List<String>, merged: Boolean, live: Boolean = false, memories: Boolean = false): List<String> =
        listOfNotNull(RESUME, NEXT_UP.takeUnless { merged }, UPCOMING, LIVE_NOW.takeIf { live }) + latestViewIds.map(::latest) + listOfNotNull(MEMORIES.takeIf { memories }, BECAUSE)

    // Desktop's `rows`: the saved order, minus rows gone, plus new rows after their default neighbour.
    fun arrange(defaults: List<String>, pref: Pref?): List<String> {
        if (pref == null) return defaults
        val out = pref.order.filter { it in defaults }.distinct().toMutableList()
        defaults.forEachIndexed { i, id ->
            if (id in out) return@forEachIndexed
            out.add(if (i == 0) 0 else out.indexOf(defaults[i - 1]) + 1, id)
        }
        return out
    }

    fun move(rows: List<String>, from: Int, to: Int): List<String> {
        if (from !in rows.indices || to !in rows.indices || from == to) return rows
        return rows.toMutableList().apply { add(to, removeAt(from)) }
    }

    fun encode(p: Pref): String = json.encodeToString(Pref.serializer(), p)
    fun decode(s: String?): Pref? = s?.let { runCatching { json.decodeFromString(Pref.serializer(), it) }.getOrNull() }

    // desktop items.ts becauseSeeds: the n latest distinct titles played (an episode stands for its series).
    fun becauseSeeds(played: List<Item>, n: Int = 2): List<Item> {
        val out = mutableListOf<Item>()
        for (it in played) {
            val title = if (it.type == "Episode" && it.seriesId != null) Item(it.seriesId, name = it.seriesName ?: it.name, type = "Series", serverId = it.serverId) else it
            if (out.any { o -> o.id == title.id && o.serverId == title.serverId }) continue
            out += title
            if (out.size == n) break
        }
        return out
    }

    // desktop Home.svelte "liveNow": the channels airing something now.
    fun onNow(channels: List<Item>): List<Item> = channels.filter { it.currentProgram != null }

    // desktop items.ts unseen: what no other row shows yet, nor the same title on another server (Servers.dedupe).
    // Distinct too: MediaRow keys its cards by Servers.key.
    fun unseen(items: List<Item>, shown: List<Item>): List<Item> {
        val keys = shown.map(Servers::key).toSet()
        val kept = Servers.dedupe(shown + items).toSet()
        return items.filter { it in kept && Servers.key(it) !in keys }.distinctBy(Servers::key)
    }
}
