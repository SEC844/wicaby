package com.wika.wicaby.core.livetv

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Reminders: the pure parts (fire time, pruning, deep-link channel lookup and its cold-start retry).
class RemindersTest {
    private fun row(id: String, number: String, name: String) = ChannelRow(id, "srv", number, null, name, null, false, emptyList(), false, 0)

    private fun reminder(at: Long) = Reminder("srv", "u", "p$at", "ch", at + 120_000, "T", "C", 2, false, at)

    @Test
    fun fireTimeAppliesLeadAndSkew() {
        assertEquals(1_000_000L - 120_000L, fireAt(1_000_000L, 2))
        // Server clock 5 min ahead of the device: fire 5 min earlier on the device clock.
        assertEquals(1_000_000L - 60_000L - 300_000L, fireAt(1_000_000L, 1, 300_000L))
    }

    @Test
    fun pruneDropsOnlyLongMissed() {
        val now = 10_000_000L
        val kept = pruneReminders(listOf(reminder(now + 1), reminder(now - Reminders.LATE_MS), reminder(now - Reminders.LATE_MS - 1)), now)
        assertEquals(listOf(now + 1, now - Reminders.LATE_MS), kept.map { it.at })
    }

    // Android 12+: window = max(60 s asked, min(10 min, 0.75 × futurity)), delivered at its end at worst.
    @Test
    fun hopsLandWithinTheMinuteEvenWhenDeliveredLate() {
        for (lead in listOf(30_000L, 81_000L, 100_000L, 139_000L, 600_000L, 1_400_001L, 3_600_000L, 86_400_000L)) {
            val at = 1_000_000_000L
            var now = at - lead
            var hops = 0
            while (true) {
                val t = nextHop(at, now)
                val window = maxOf(Reminders.WINDOW_MS, minOf(600_000L, ((t - now) * 0.75).toLong()))
                now = t + window
                hops++
                if (t == at || now >= at) break
            }
            assertTrue("lead $lead: late by ${now - at} ms", now - at <= Reminders.WINDOW_MS)
            assertTrue("lead $lead: $hops hops", hops <= 8)
        }
    }

    @Test
    fun resolvesByIdThenNumberThenName() {
        val list = listOf(row("12", "5", "France 2"), row("a", "12", "TF1"), row("b", "", "Arte"))
        assertEquals("12", resolveChannel("12", list)?.id)
        assertEquals("a", resolveChannel("TF1", list)?.id)
        assertEquals("12", resolveChannel("5", list)?.id)
        assertEquals("b", resolveChannel("arte", list)?.id)
        assertNull(resolveChannel("", list))
    }

    @Test
    fun coldStartRetriesUntilChannelsArrive() = runBlocking {
        var calls = 0
        val hit = resolveChannelWithRetry("5", delayMs = 1) {
            calls++
            when (calls) {
                1 -> null
                2 -> throw IllegalStateException("not connected")
                else -> listOf(row("x", "5", "M6"))
            }
        }
        assertEquals("x", hit?.id)
        assertEquals(3, calls)
        calls = 0
        assertNull(resolveChannelWithRetry("9", delayMs = 1) { calls++; emptyList() })
        assertEquals(5, calls)
    }
}
