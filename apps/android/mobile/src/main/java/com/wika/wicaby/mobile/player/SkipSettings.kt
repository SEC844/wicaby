package com.wika.wicaby.mobile.player

import android.content.Context
import androidx.core.content.edit
import com.wika.wicaby.core.player.SegmentKind

// What the player does in an intro, recap, preview or commercial (core player/Segments.kt), per
// kind as on TV: offer a "Passer" button, skip on its own, or nothing. SharedPreferences, so the
// player reads it synchronously.
object SkipSettings {
    const val ASK = 0
    const val AUTO = 1
    const val OFF = 2

    private fun prefs(context: Context) = context.getSharedPreferences("wicaby_player", Context.MODE_PRIVATE)

    private fun key(kind: SegmentKind) = "skip_" + kind.name.lowercase()

    fun mode(context: Context, kind: SegmentKind): Int = prefs(context).getInt(key(kind), ASK)

    fun set(context: Context, kind: SegmentKind, mode: Int) = prefs(context).edit { putInt(key(kind), mode) }
}
