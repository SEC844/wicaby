package com.wika.wicaby.core.music

import kotlinx.serialization.Serializable

// Jellyfin 10.9+ /Audio/{id}/Lyrics (music spec §3.5): Start in ticks; 10.11's word Cues are left aside.
@Serializable
data class JellyfinLyrics(val metadata: Meta? = null, val lyrics: List<Row> = emptyList()) {
    @Serializable
    data class Meta(val isSynced: Boolean? = null)

    @Serializable
    data class Row(val text: String? = null, val start: Long? = null)

    /** Desktop shared/music.ts lyricsFromJellyfin. Metadata.Offset is left alone (whether the server applied it is unverified). */
    fun toLyrics(): Lyrics? {
        if (lyrics.isEmpty()) return null
        val synced = metadata?.isSynced ?: lyrics.any { it.start != null }
        return Lyrics(synced, lyrics.map { LyricLine(if (synced) it.start?.let { s -> Math.round(s / 10_000.0) } else null, it.text.orEmpty()) })
    }
}
