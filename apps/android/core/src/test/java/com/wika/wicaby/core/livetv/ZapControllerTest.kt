package com.wika.wicaby.core.livetv

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections

// ZapController: the timers around zapReduce / digitReduce (the pure logic is in zap.json).
class ZapControllerTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val tunes: MutableList<String> = Collections.synchronizedList(mutableListOf())
    private val zap = ZapController(scope, { tunes.add(it) }).apply {
        setList(listOf(ZapEntry("a", "1", "A"), ZapEntry("b", "2", "B"), ZapEntry("c", "3", "C"), ZapEntry("h", "70", "H")), hiddenIds = listOf("h"))
    }

    @After
    fun tearDown() = scope.cancel()

    @Test
    fun pressesMergeIntoOneTune() = runBlocking {
        zap.tune("a")
        zap.adopted("a")
        tunes.clear()
        zap.press(1)
        zap.press(1)
        assertEquals("c", zap.banner.value)
        assertTrue("nothing before 400 ms", tunes.isEmpty())
        withTimeout(2_000) { while (tunes.isEmpty()) delay(10) }
        delay(100)
        assertEquals(listOf("c"), tunes.toList())
        zap.adopted("c")
        zap.lastChannel()
        assertEquals("a", tunes.last())
    }

    @Test
    fun heldKeyTunesOnKeyUp() = runBlocking {
        zap.tune("a")
        zap.adopted("a")
        tunes.clear()
        zap.press(1, repeat = true)
        delay(600)
        assertTrue(tunes.isEmpty())
        zap.keyUp()
        assertEquals(listOf("b"), tunes.toList())
    }

    // TV: the first press arrives with repeatCount 0 and Android repeats only after ~500 ms; the 400 ms
    // merge timer must not tune that first step while the key is still down.
    @Test
    fun keyHeld600msTunesOnce() = runBlocking {
        zap.tune("a")
        zap.adopted("a")
        tunes.clear()
        zap.press(1, keyDown = true)
        delay(500)
        assertTrue("no tune while the key is down", tunes.isEmpty())
        zap.press(1, repeat = true, keyDown = true)
        delay(100)
        zap.keyUp()
        delay(600)
        assertEquals(listOf("c"), tunes.toList())
    }

    @Test
    fun shortPressStillMergesAfterKeyUp() = runBlocking {
        zap.tune("a")
        zap.adopted("a")
        tunes.clear()
        zap.press(1, keyDown = true)
        delay(80)
        zap.keyUp()
        assertTrue("the merge window is still open", tunes.isEmpty())
        withTimeout(2_000) { while (tunes.isEmpty()) delay(10) }
        delay(100)
        assertEquals(listOf("b"), tunes.toList())
    }

    @Test
    fun digitsCommitAndHiddenChannelsSayso() = runBlocking {
        zap.digit('2') // unique, nothing extends it: commits at once
        assertEquals(listOf("b"), tunes.toList())
        zap.digit('7')
        assertEquals("7", zap.digits.value?.buf)
        val pending = async(start = CoroutineStart.UNDISPATCHED) { zap.results.first() }
        zap.digit('0') // reaches the hidden channel
        assertEquals("h", tunes.last())
        val r = withTimeout(1_000) { pending.await() }
        assertTrue(r is DigitResult.Commit && r.hidden)
    }

    @Test
    fun digitTimeoutCommits() = runBlocking {
        zap.digitTimeoutMs = 200
        zap.setList(zap.entries, emptyList(), listOf(DigitChannel("a", "1"), DigitChannel("x", "10")))
        zap.digit('1') // waits: 10 exists
        assertTrue(tunes.isEmpty())
        withTimeout(2_000) { while (tunes.isEmpty()) delay(10) }
        assertEquals(listOf("a"), tunes.toList())
    }
}
