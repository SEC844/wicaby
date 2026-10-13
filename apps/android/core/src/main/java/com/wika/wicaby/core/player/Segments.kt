package com.wika.wicaby.core.player

import com.wika.wicaby.core.data.Chapter
import com.wika.wicaby.core.data.MediaSegment
import com.wika.wicaby.core.data.TICKS_PER_MS

// What a "Passer" button can skip, each kind with its own skip setting: Emby marks the intro
// (chapter markers), Jellyfin 10.10+ also has recap, preview and commercial media segments.
enum class SegmentKind { Intro, Recap, Preview, Commercial }

// A skippable span of the item, in ms.
data class SkipRange(val kind: SegmentKind, val startMs: Long, val endMs: Long)

// Intro range and credits start, normalised from Emby chapter markers or Jellyfin media segments,
// plus every skippable range (the intro included) in time order.
data class Segments(
    val introStart: Long? = null,
    val introEnd: Long? = null,
    val credits: Long? = null,
    val ranges: List<SkipRange> = emptyList(),
) {
    // Emby web hides the button 2 s before the end so a late press does not land in the episode.
    fun inIntro(ms: Long) = introStart != null && introEnd != null && ms >= introStart && ms < introEnd - 2_000

    // The skippable range playing at [ms], same 2 s rule; null outside every range.
    fun skippableAt(ms: Long): SkipRange? = ranges.firstOrNull { ms >= it.startMs && ms < it.endMs - 2_000 }
}

// Same rules as the desktop src/shared/markers.ts: both run tools/checks/fixtures/segments.json.
// A credits marker at 0 would mark the item watched as it starts.
private fun creditsMs(ticks: Long?): Long? = ticks?.takeIf { it > 0 }?.div(TICKS_PER_MS)

private val OTHER_KINDS = listOf(SegmentKind.Recap, SegmentKind.Preview, SegmentKind.Commercial)

private fun ranges(list: List<SkipRange>) = list.filter { it.endMs > it.startMs }.sortedBy { it.startMs }

// Emby stores markers as point chapters; an intro without IntroEnd ends at the next chapter,
// and one with nothing after it is no intro. A RecapStart/PreviewStart/CommercialStart runs to
// its next matching End (as on desktop); Emby 4.8/4.9 write none, a server or plugin may.
fun embySegments(chapters: List<Chapter>): Segments {
    val sorted = chapters.sortedBy { it.startPositionTicks }
    val start = sorted.firstOrNull { it.markerType == "IntroStart" }
    val after = start?.let { s -> sorted.filter { it.startPositionTicks > s.startPositionTicks } }.orEmpty()
    val end = after.firstOrNull { it.markerType == "IntroEnd" } ?: after.firstOrNull()
    val credits = creditsMs(sorted.firstOrNull { it.markerType == "CreditsStart" }?.startPositionTicks)
    val others = OTHER_KINDS.flatMap { k ->
        sorted.filter { it.markerType == "${k.name}Start" }.mapNotNull { c ->
            val e = sorted.firstOrNull { it.markerType == "${k.name}End" && it.startPositionTicks > c.startPositionTicks } ?: return@mapNotNull null
            SkipRange(k, c.startPositionTicks / TICKS_PER_MS, e.startPositionTicks / TICKS_PER_MS)
        }
    }
    if (start == null || end == null) return Segments(credits = credits, ranges = ranges(others))
    val s = start.startPositionTicks / TICKS_PER_MS
    val e = end.startPositionTicks / TICKS_PER_MS
    return Segments(s, e, credits, ranges(others + SkipRange(SegmentKind.Intro, s, e)))
}

// The earliest Intro, credits at the earliest Outro; every Recap, Preview and Commercial is a range too.
fun jellyfinSegments(items: List<MediaSegment>): Segments {
    val intro = items.filter { it.type == "Intro" }.minByOrNull { it.startTicks }
    val outro = items.filter { it.type == "Outro" }.minByOrNull { it.startTicks }
    val others = items.mapNotNull { m ->
        val kind = OTHER_KINDS.firstOrNull { it.name == m.type } ?: return@mapNotNull null
        SkipRange(kind, m.startTicks / TICKS_PER_MS, m.endTicks / TICKS_PER_MS)
    }
    val introRange = intro?.let { SkipRange(SegmentKind.Intro, it.startTicks / TICKS_PER_MS, it.endTicks / TICKS_PER_MS) }
    return Segments(intro?.startTicks?.div(TICKS_PER_MS), intro?.endTicks?.div(TICKS_PER_MS), creditsMs(outro?.startTicks), ranges(others + listOfNotNull(introRange)))
}

// Resume and watched rules shared by Emby (5 %/90 % defaults) and Jellyfin.
const val MIN_RESUME = 0.05
const val MAX_RESUME = 0.90

fun resumeFrom(positionMs: Long, durationMs: Long): Long {
    if (durationMs <= 0 || positionMs <= 0) return positionMs.coerceAtLeast(0)
    val f = positionMs.toDouble() / durationMs
    return if (f in MIN_RESUME..MAX_RESUME) positionMs else 0
}

// Watched at 90 % or once the credits have started, whichever comes first.
fun isWatched(positionMs: Long, durationMs: Long, creditsMs: Long?): Boolean =
    durationMs > 0 && (positionMs >= durationMs * MAX_RESUME || (creditsMs != null && creditsMs > 0 && positionMs >= creditsMs))

// When the "next episode" card appears: at the credits, or for the last 30 s.
fun upNextAt(durationMs: Long, creditsMs: Long?): Long? {
    if (durationMs <= 0) return null
    val fallback = durationMs - 30_000
    return if (creditsMs != null && creditsMs in 1 until durationMs) creditsMs else fallback.coerceAtLeast(0)
}

// "Toujours là ?" after this many episodes started by the countdown with no input.
const val STILL_WATCHING_AFTER = 3
