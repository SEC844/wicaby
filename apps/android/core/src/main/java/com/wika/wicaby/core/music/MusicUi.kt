package com.wika.wicaby.core.music

/**
 * The album's release type (music-feishin-navidrome spec C4), the Kotlin twin of desktop's shared/music-ui.ts
 * releaseType: both run tools/checks/fixtures/music/ui-vectors.json.
 */
object MusicUi {
    enum class Release { ALBUM, EP, SINGLE, COMPILATION }

    private val VARIOUS = Regex("^(various( artists)?|va|v\\.a\\.|artistes? divers|divers)$", RegexOption.IGNORE_CASE)
    private const val HALF_HOUR_MS = 30 * 60_000L

    // shortcut: Emby and Jellyfin send no release type, so it is guessed from the track count and length (up to 3 tracks
    // a single, up to 6 an EP, both under 30 min). Upgrade to OpenSubsonic releaseTypes with Navidrome.
    fun releaseType(trackCount: Int, durationMs: Long, albumArtist: String?): Release = when {
        VARIOUS.matches(albumArtist?.trim().orEmpty()) -> Release.COMPILATION
        trackCount < 1 || durationMs >= HALF_HOUR_MS -> Release.ALBUM
        trackCount <= 3 -> Release.SINGLE
        trackCount <= 6 -> Release.EP
        else -> Release.ALBUM
    }
}
