package com.wika.wicaby.core.music

import kotlin.math.roundToLong

/** A line of lyrics; [startMs] is null for plain (unsynced) lyrics. */
data class LyricLine(val startMs: Long?, val text: String)

// lrclib: from lrclib.net (MU-13), shown with its source caption.
data class Lyrics(val synced: Boolean, val lines: List<LyricLine>, val lrclib: Boolean = false)

/**
 * The LRC parser (music spec MU-01), the twin of desktop's shared/music.ts parseLrc: same grammar, same vectors
 * (tools/checks/fixtures/music/lrc-cases.json). [mm:ss], [mm:ss.xx] and [mm:ss.xxx] stamps, several per line;
 * [offset:±ms] (positive = earlier); other tags ignored; enhanced <mm:ss.xx> word stamps stripped; blank stamped
 * lines kept as gaps; lines sorted by time (stable); BOM and CRLF tolerated. No stamp at all: plain lyrics.
 */
object Lrc {
    private val STAMP = Regex("""^\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?]""")
    private val TAG = Regex("""^\[([A-Za-z#]+):(.*)]$""")
    private val WORD = Regex("""<\d+:\d{1,2}(?:[.:]\d{1,3})?>""")
    private val SPACES = Regex("""\s+""")
    private val BOM = Char(0xFEFF).toString()
    private val LEADING_INT = Regex("""^\s*([+-]?\d+)""")

    fun parse(text: String): Lyrics {
        var offset = 0L
        val timed = mutableListOf<LyricLine>()
        val plain = mutableListOf<String>()
        for (raw in text.removePrefix(BOM).split(Regex("\r?\n"))) {
            var line = raw.trim()
            val tag = TAG.matchEntire(line)
            if (tag != null) {
                if (tag.groupValues[1].lowercase() == "offset") offset = LEADING_INT.find(tag.groupValues[2])?.groupValues?.get(1)?.toLongOrNull() ?: 0
                continue
            }
            val starts = mutableListOf<Long>()
            while (true) {
                val m = STAMP.find(line) ?: break
                val frac = m.groupValues[3]
                starts += (m.groupValues[1].toLong() * 60 + m.groupValues[2].toLong()) * 1000 + if (frac.isEmpty()) 0 else ("0.$frac".toDouble() * 1000).roundToLong()
                line = line.substring(m.value.length)
            }
            val words = line.replace(WORD, "").replace(SPACES, " ").trim()
            if (starts.isEmpty()) plain += words else starts.forEach { timed += LyricLine(it, words) }
        }
        if (timed.isEmpty()) {
            // Leading and trailing blank lines carry nothing; inner ones separate verses.
            val kept = plain.dropWhile { it.isEmpty() }.dropLastWhile { it.isEmpty() }
            return Lyrics(false, kept.map { LyricLine(null, it) })
        }
        return Lyrics(true, timed.map { it.copy(startMs = maxOf(0, it.startMs!! - offset)) }.sortedBy { it.startMs })
    }
}
