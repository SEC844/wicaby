package com.wika.wicaby.core.player

import kotlin.math.roundToLong

// X-04 merged and accelerated seeking (feature-specs.md §4), the twin of D/shared/stepped-seek.ts:
// both replay tools/checks/fixtures/seek/stepped-seek.json. Pure; shared with mobile double-tap.
object SteppedSeek {
    // The seek commits this long after the last press (or on key-up after a hold).
    const val MERGE_MS = 800L

    data class Pending(val origin: Long, val target: Long, val repeats: Int)

    // Hold acceleration by key-repeat count: ×1 for 1–5, ×1.5 to 15, ×3 to 30, ×6 to 60, then ×10 (the cap).
    fun multiplier(repeats: Int): Double = when {
        repeats <= 5 -> 1.0
        repeats <= 15 -> 1.5
        repeats <= 30 -> 3.0
        repeats <= 60 -> 6.0
        else -> 10.0
    }

    // One press of ±stepMs. The target stays inside [0, duration] (no upper bound while the duration is unknown).
    fun press(p: Pending?, positionMs: Long, durationMs: Long, stepMs: Long, repeat: Boolean): Pending {
        val repeats = if (repeat && p != null) p.repeats + 1 else 1
        val max = if (durationMs > 0) durationMs else Long.MAX_VALUE
        val target = ((p?.target ?: positionMs) + (stepMs * multiplier(repeats)).roundToLong()).coerceIn(0, max)
        return Pending(p?.origin ?: positionMs, target, repeats)
    }

    // What the badge shows: the distance actually applied, to the nearest second.
    fun appliedSeconds(p: Pending): Long = Math.round((p.target - p.origin) / 1000.0)
}
