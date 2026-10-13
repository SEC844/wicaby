package com.wika.wicaby.core.player

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

// X-04: the golden vectors of CK/fixtures/seek/stepped-seek.json, shared with tools/checks/seek-check.mjs
// (D/shared/stepped-seek.ts). Gradle runs unit tests from the module directory.
class SteppedSeekTest {
    private val fx = Json.parseToJsonElement(File("../../../tools/checks/fixtures/seek/stepped-seek.json").readText()).jsonObject

    @Test
    fun multiplierCurve() {
        assertEquals(800L, SteppedSeek.MERGE_MS)
        for (row in fx.getValue("multiplier").jsonArray) {
            val (repeats, m) = row.jsonArray
            assertEquals("repeats ${repeats.jsonPrimitive.int}", m.jsonPrimitive.double, SteppedSeek.multiplier(repeats.jsonPrimitive.int), 0.0)
        }
    }

    @Test
    fun sequences() {
        for (c in fx.getValue("sequences").jsonArray.map { it.jsonObject }) {
            val name = c.getValue("name").jsonPrimitive.content
            var p: SteppedSeek.Pending? = null
            val position = c.getValue("position").jsonPrimitive.long
            for (repeat in c.getValue("presses").jsonArray) {
                p = SteppedSeek.press(p, position, c.getValue("duration").jsonPrimitive.long, c.getValue("step").jsonPrimitive.long, repeat.jsonPrimitive.boolean)
            }
            p!!
            assertEquals(name, position, p.origin)
            assertEquals(name, c.getValue("target").jsonPrimitive.long, p.target)
            assertEquals(name, c.getValue("repeats").jsonPrimitive.int, p.repeats)
            assertEquals(name, c.getValue("badge").jsonPrimitive.long, SteppedSeek.appliedSeconds(p))
        }
    }

    @Test
    fun chapters() {
        for (c in fx.getValue("chapters").jsonArray.map { it.jsonObject }) {
            val starts = c.getValue("starts").jsonArray.map { it.jsonPrimitive.long }
            val out = c.getValue("out")
            val got = chapterTarget(starts, c.getValue("position").jsonPrimitive.long, c.getValue("forward").jsonPrimitive.boolean)
            if (out is JsonNull) assertNull(c.toString(), got) else assertEquals(c.toString(), out.jsonPrimitive.long, got)
        }
    }

    @Test
    fun sleepTimerPromptsThenExpires() {
        val t0 = 1_000_000L
        SleepTimer.start(5, t0)
        assertEquals(SleepTimer.Action.NONE, SleepTimer.check(t0 + 5 * 60_000L - 1))
        assertEquals(SleepTimer.Action.PROMPT, SleepTimer.check(t0 + 5 * 60_000L))
        assertEquals(SleepTimer.Action.NONE, SleepTimer.check(t0 + 5 * 60_000L + 29_999))
        assertEquals(SleepTimer.Action.EXPIRE, SleepTimer.check(t0 + 5 * 60_000L + 30_000))
        assertNull(SleepTimer.state.value)
    }

    @Test
    fun sleepTimerContinueExtendAndEndOfVideo() {
        val t0 = 2_000_000L
        SleepTimer.start(10, t0)
        assertEquals(SleepTimer.Action.PROMPT, SleepTimer.check(t0 + 10 * 60_000L))
        SleepTimer.restart(t0 + 10 * 60_000L + 5_000) // Continue: the same duration again
        assertEquals(t0 + 20 * 60_000L + 5_000, SleepTimer.state.value!!.endsAt)
        SleepTimer.extend(t0 + 11 * 60_000L)
        assertEquals(t0 + 35 * 60_000L + 5_000, SleepTimer.state.value!!.endsAt)
        SleepTimer.start(null, t0)
        assertEquals(SleepTimer.Action.NONE, SleepTimer.check(t0 + 999 * 60_000L))
        assertEquals(true, SleepTimer.endOfVideo)
        assertEquals(true, SleepTimer.atEnd(t0, 45_000))
        assertEquals(false, SleepTimer.endOfVideo) // prompting: the next end does not prompt again
        assertEquals(SleepTimer.Action.EXPIRE, SleepTimer.check(t0 + 45_000))
        SleepTimer.cancel()
        assertEquals(false, SleepTimer.atEnd(t0))
    }
}
