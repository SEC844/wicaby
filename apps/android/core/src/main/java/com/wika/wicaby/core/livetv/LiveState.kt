package com.wika.wicaby.core.livetv

// What the player UI shows about a live channel (spec §14, the Kotlin mirror of contract.ts LiveState).
// Playback exposes it as `liveState`; LiveTuner fills the session part, ZapController (C-3) the zap part.

data class LiveNowNext(val id: String, val title: String, val start: Long, val end: Long, val episodeTitle: String? = null, val flags: Int = 0)

data class LiveState(
    val channel: ZapEntry,
    val serverId: String,
    /** Banner "12/300" and the lens name (ZapController). */
    val index: Int = 0,
    val count: Int = 0,
    val lensLabel: String = "",
    /** Merged zap target, before tuning. */
    val pending: ZapEntry? = null,
    val tuning: Boolean = false,
    val now: LiveNowNext? = null,
    val next: LiveNowNext? = null,
    val recording: Boolean = false,
    val lastChannelId: String? = null,
    /** §8.8: the stream was released after a long pause; play re-tunes ("Reprendre le direct"). */
    val pausedReleased: Boolean = false,
    val startOverItemId: String? = null,
    val policy: ZapPolicy = ZapPolicy.MBB,
    /** No video stream: the radio screen, and mobile keeps it playing in the background (F6). */
    val radio: Boolean = false,
    /** A transient message (tuner released, zap failed, recovering) and when it was raised. */
    val notice: String? = null,
    val noticeAt: Long = 0,
)
