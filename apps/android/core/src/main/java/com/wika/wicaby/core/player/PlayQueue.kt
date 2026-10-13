package com.wika.wicaby.core.player

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.toMutableStateList
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.SafeNames

// The play queue, as desktop's main/playback/play-queue.ts: item ids of the signed-in server and the
// position in it. Shuffle starts one; "Play next" / "Add to queue" (remote PlayNext / PlayLast) splice
// into it. While one is set, Playback's next item comes from it instead of the next episode.
// [fromStart]: every entry plays from 0, not its resume point (a shuffle, B28).
class PlayQueue(ids: List<String>, startIndex: Int = 0, val fromStart: Boolean = false) {
    val ids = ids.toMutableStateList()
    var index by mutableIntStateOf(startIndex.coerceIn(0, (ids.size - 1).coerceAtLeast(0)))
        private set

    val id: String? get() = ids.getOrNull(index)
    val nextId: String? get() = ids.getOrNull(index + 1)

    /** PlayNext: right after the current entry; PlayLast: at the end. */
    fun add(next: Boolean, more: List<String>) {
        if (next) ids.addAll(index + 1, more) else ids.addAll(more)
    }

    /** Makes entry [i] the current one; its id, or null when out of range. */
    fun jump(i: Int): String? = ids.getOrNull(i)?.also { index = i }

    /** Drops entry [i]; never the one playing. */
    fun remove(i: Int): Boolean {
        if (i == index || i !in ids.indices) return false
        ids.removeAt(i)
        if (i < index) index--
        return true
    }

    companion object {
        /**
         * Music (stopgap until .dev/specs/music-spec.md): every track [item] stands for, in play order. An album or a
         * folder: its tracks by disc and number; an artist: theirs by album; a playlist: its own order; a track: its
         * album, so play goes on from it (alone when it has none).
         */
        suspend fun tracks(api: Api, item: Item): List<String> {
            val q: Array<Pair<String, Any?>> = when {
                item.isAudio && item.albumId == null -> return listOf(item.id)
                item.isAudio -> arrayOf("ParentId" to item.albumId, "SortBy" to "ParentIndexNumber,IndexNumber,SortName")
                item.type == "MusicArtist" -> arrayOf("ArtistIds" to item.id, "SortBy" to "Album,ParentIndexNumber,IndexNumber,SortName")
                item.type == "Playlist" -> arrayOf("ParentId" to item.id)
                else -> arrayOf("ParentId" to item.id, "SortBy" to "ParentIndexNumber,IndexNumber,SortName")
            }
            return api.items(*q, "Recursive" to true, "IncludeItemTypes" to "Audio", "Limit" to 500, "EnableImages" to false)
                .items.map { it.id }.filter(SafeNames::isValidId)
        }

        /** Desktop lib/queue.svelte.ts: everything playable under [parentId] (series, season, collection, playlist, library), in random order. */
        suspend fun shuffle(api: Api, parentId: String): List<String> =
            api.items(
                "ParentId" to parentId, "Recursive" to true, "IncludeItemTypes" to "Movie,Episode,Video,MusicVideo,Audio",
                // SortBy=Random samples a big library server-side; the local shuffle covers cached answers.
                "SortBy" to "Random", "Limit" to 500,
            ).items.map { it.id }.filter(SafeNames::isValidId).shuffled()
    }
}
