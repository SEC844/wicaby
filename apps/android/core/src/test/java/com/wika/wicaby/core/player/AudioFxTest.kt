package com.wika.wicaby.core.player

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sin

class AudioFxTest {
    private val rate = 48_000
    private val all = AudioFx.Config(dialogue = true, night = true, normalize = true, boost = true)

    @After
    fun tearDown() {
        AudioFx.config = AudioFx.Config()
        AudioFx.eq = AudioFx.Eq()
        AudioFx.music = false
    }

    // Music spec MU-11: a 1 kHz sine through the processor with the 1 kHz band at +6 dB comes out 6 dB louder.
    private fun throughProcessor(src: FloatArray): FloatArray {
        val p = AudioFxProcessor()
        p.configure(AudioProcessor.AudioFormat(rate, 2, C.ENCODING_PCM_FLOAT))
        p.flush()
        val input = ByteBuffer.allocateDirect(src.size * 4).order(ByteOrder.nativeOrder())
        src.forEach { input.putFloat(it) }
        input.flip()
        p.queueInput(input)
        val out = p.output
        return FloatArray(out.remaining() / 4) { out.float }
    }

    private val sixAt1k = AudioFx.FLAT.mapIndexed { i, g -> if (AudioFx.EQ_FREQS[i] == 1000) 6f else g }

    @Test
    fun equalizerBandRaisesOneKilohertzBySixDb() {
        AudioFx.music = true
        AudioFx.eq = AudioFx.Eq(sixAt1k)
        val src = sine(0.1f, 2)
        val out = throughProcessor(src)
        val db = 20 * log10(peak(out, out.size / 2) / peak(src, src.size / 2))
        assertEquals(6.0f, db, 0.5f)
        // A neighbour two octaves away hardly moves.
        val far = sine(0.1f, 2, hz = 250.0)
        val farOut = throughProcessor(far)
        assertEquals(0f, 20 * log10(peak(farOut, farOut.size / 2) / peak(far, far.size / 2)), 0.5f)
    }

    @Test
    fun equalizerOnlyForMusicAndFlatIsIdentity() {
        AudioFx.eq = AudioFx.Eq(sixAt1k)
        val src = sine(0.1f, 2)
        assertArrayEquals(src, throughProcessor(src), 0f)
        AudioFx.music = true
        AudioFx.eq = AudioFx.Eq()
        assertArrayEquals(src, throughProcessor(src), 0f)
    }

    @Test
    fun equalizerPresetsRoundTrip() {
        for ((name, bands) in AudioFx.EQ_PRESETS) assertEquals(name, AudioFx.presetOf(bands.toList()))
        assertEquals("custom", AudioFx.presetOf(sixAt1k))
        assertEquals(listOf(31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000), AudioFx.EQ_FREQS.toList())
    }

    private fun sine(amp: Float, channels: Int, frames: Int = rate, hz: Double = 1000.0) = FloatArray(frames * channels) { i ->
        (amp * sin(2 * PI * hz * (i / channels) / rate)).toFloat()
    }

    private fun run(buf: FloatArray, channels: Int, c: AudioFx.Config) = buf.also { AudioFxChain(rate, channels).process(it, it.size / channels, c) }

    private fun peak(buf: FloatArray, from: Int = 0) = buf.drop(from).maxOf { abs(it) }

    @Test
    fun allOffIsIdentity() {
        val src = sine(0.99f, 2)
        assertArrayEquals(src.copyOf(), run(src.copyOf(), 2, AudioFx.Config()), 0f)
    }

    @Test
    fun boostIsGainOfOnePointFiveBelowTheCeiling() {
        val out = run(sine(0.2f, 2), 2, AudioFx.Config(boost = true))
        assertEquals(0.3f, peak(out), 0.002f)
    }

    @Test
    fun limiterHoldsTheCeilingOnABoostedFullScaleSignal() {
        val out = run(sine(1f, 2), 2, AudioFx.Config(boost = true))
        assertTrue(peak(out) <= AudioFxChain.CEILING)
        // Steady state sits right at the ceiling, not far below it.
        assertTrue(peak(out, out.size / 2) > AudioFxChain.CEILING * 0.95f)
    }

    @Test
    fun noSampleAboveZeroDbfsWithEveryEffect() {
        for (ch in listOf(1, 2, 6, 8)) {
            val out = run(sine(1f, ch), ch, all)
            assertTrue("$ch channels", out.all { abs(it) <= AudioFxChain.CEILING && abs(it) < 1f })
        }
    }

    @Test
    fun compressorGainFollowsTheRatio() {
        assertEquals(1f, AudioFxChain.compressorGain(0.05f), 0f)
        assertEquals(1f, AudioFxChain.compressorGain(AudioFxChain.NIGHT_THRESHOLD), 0f)
        // 0 dBFS is 20 dB over the threshold: 4:1 keeps 5 dB of it, so -15 dB of gain.
        assertEquals(0.1778f, AudioFxChain.compressorGain(1f), 0.0005f)
    }

    @Test
    fun nightModeNarrowsTheGapBetweenQuietAndLoud() {
        val quiet = peak(run(sine(0.01f, 2), 2, AudioFx.Config(night = true)), rate)
        val loud = peak(run(sine(0.9f, 2), 2, AudioFx.Config(night = true)), rate)
        // In: 39 dB apart. Out: the quiet one gets the +6 dB make-up, the loud one is squeezed.
        assertEquals(0.02f, quiet, 0.001f)
        assertTrue(loud / quiet < 90f / 4)
    }

    @Test
    fun dialogueRaisesTheCentreChannelOnly() {
        val frame = floatArrayOf(0.2f, 0.2f, 0.2f, 0.2f, 0.2f, 0.2f)
        val out = run(frame, 6, AudioFx.Config(dialogue = true))
        assertEquals(0.2f * AudioFxChain.DIALOGUE_CENTRE, out[2], 1e-6f)
        assertEquals(0.2f * AudioFxChain.DIALOGUE_OTHERS, out[0], 1e-6f)
    }

    @Test
    fun dialogueOnStereoBoostsSpeechNotBass() {
        val voice = peak(run(sine(0.1f, 2, hz = 1000.0), 2, AudioFx.Config(dialogue = true)), rate)
        val bass = peak(run(sine(0.1f, 2, hz = 50.0), 2, AudioFx.Config(dialogue = true)), rate)
        assertTrue(voice > 0.18f)
        assertTrue(bass < 0.11f)
    }

    @Test
    fun normalizeLiftsAQuietPassageButNotPastEightTimes() {
        val out = run(sine(0.01f, 2, frames = rate * 6), 2, AudioFx.Config(normalize = true))
        val end = peak(out, out.size - rate)
        assertTrue(end > 0.06f)
        assertTrue(end <= 0.081f)
    }

    @Test
    fun processorKeepsSixteenBitInRangeWithoutWrapping() {
        AudioFx.config = AudioFx.Config(boost = true)
        val p = AudioFxProcessor()
        p.configure(AudioProcessor.AudioFormat(rate, 2, C.ENCODING_PCM_16BIT))
        p.flush()
        val frames = 4800
        val src = sine(1f, 2, frames)
        val input = ByteBuffer.allocateDirect(src.size * 2).order(ByteOrder.nativeOrder())
        src.forEach { input.putShort((it * 32767).toInt().toShort()) }
        input.flip()
        p.queueInput(input)
        val out = p.output
        assertEquals(src.size * 2, out.remaining())
        val max = (AudioFxChain.CEILING * 32768).toInt() + 1
        var prev = 0
        repeat(src.size) {
            val v = out.short.toInt()
            assertTrue(abs(v) <= max)
            // A wrapped sample would jump by most of the range between neighbours of one channel.
            if (it % 2 == 0) {
                assertTrue(abs(v - prev) < 16_000)
                prev = v
            }
        }
    }

    @Test
    fun processorOnlyTakesSixteenBitAndFloat() {
        val f = AudioFxProcessor().configure(AudioProcessor.AudioFormat(rate, 2, C.ENCODING_PCM_16BIT))
        assertEquals(C.ENCODING_PCM_16BIT, f.encoding)
        assertTrue(!AudioFxProcessor().apply { configure(AudioProcessor.AudioFormat(rate, 2, C.ENCODING_PCM_24BIT)) }.isActive)
    }
}
