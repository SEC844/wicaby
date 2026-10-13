package com.wika.wicaby.core.player

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.audio.AudioProcessor.StreamMetadata
import androidx.media3.common.audio.BaseAudioProcessor
import java.nio.ByteBuffer
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

// Desktop parity (mpv-player.ts audioFilters + volumeBoost): Enhance Dialogue, Reduce Loud Sounds
// (night mode), Normalize Volume and the 150 % boost, as one chain on decoded PCM. A bitstream
// (HDMI passthrough) never reaches an AudioProcessor, so it plays untouched, like mpv's S/PDIF path.
object AudioFx {
    data class Config(val dialogue: Boolean = false, val night: Boolean = false, val normalize: Boolean = false, val boost: Boolean = false) {
        val any get() = dialogue || night || normalize || boost
    }

    // Read on the audio thread for every buffer, so a change applies during playback.
    @Volatile
    var config = Config()

    // True while the sink plays a bitstream (set by Engine's sink): the player shows the effects disabled.
    var bitstream by mutableStateOf(false)
}

// The DSP, on interleaved float samples (±1 = 0 dBFS). Plain Kotlin so unit tests drive it directly.
class AudioFxChain(private val sampleRate: Int, private val channels: Int) {
    // Android PCM order puts the front centre third in 3.0, 5.0, 5.1, 6.1 and 7.1 (4 is quad: no centre).
    private val centre = channels == 3 || channels in 5..8
    private val hp = Biquad(sampleRate, 300.0, highPass = true)
    private val lp = Biquad(sampleRate, 3400.0, highPass = false)
    private val front = min(channels, 2)

    private fun coef(seconds: Double) = exp(-1.0 / (seconds * sampleRate)).toFloat()
    private val compAttack = coef(0.005)
    private val compRelease = coef(0.2)
    private val normRelease = coef(2.0)
    private val normFall = coef(0.01)
    private val normRise = coef(1.0)
    private val limRelease = coef(0.08)

    private var compEnv = 0f
    private var normEnv = 0f
    private var normGain = 1f
    private var limGain = 1f

    fun process(buf: FloatArray, frames: Int, c: AudioFx.Config) {
        if (!c.any) return
        for (f in 0 until frames) {
            val o = f * channels
            if (c.dialogue) {
                if (centre) {
                    // Desktop's pan: centre +3 dB, the rest -3 dB.
                    for (ch in 0 until channels) buf[o + ch] *= if (ch == 2) DIALOGUE_CENTRE else DIALOGUE_OTHERS
                } else {
                    // Stereo/mono: the 300–3400 Hz band of the mid added back, about +6 dB on speech.
                    var mid = 0f
                    for (ch in 0 until front) mid += buf[o + ch]
                    val voice = lp.run(hp.run(mid / front))
                    for (ch in 0 until front) buf[o + ch] += voice
                }
            }
            if (c.night) {
                // Desktop's acompressor: -20 dB threshold, 4:1, 5 ms attack, 200 ms release, +6 dB make-up.
                val peak = peakOf(buf, o)
                compEnv = if (peak > compEnv) compAttack * compEnv + (1 - compAttack) * peak else compRelease * compEnv + (1 - compRelease) * peak
                gain(buf, o, compressorGain(compEnv) * NIGHT_MAKEUP)
            }
            if (c.normalize) {
                // shortcut: a peak AGC (target 0.9, at most 8x) instead of dynaudnorm's look-ahead Gaussian smoothing; the limiter catches onsets.
                normEnv = max(peakOf(buf, o), normRelease * normEnv)
                val target = min(NORM_MAX_GAIN, NORM_PEAK / max(normEnv, 1e-6f))
                val k = if (target < normGain) normFall else normRise
                normGain = k * normGain + (1 - k) * target
                gain(buf, o, normGain)
            }
            if (c.boost) gain(buf, o, BOOST)
            limit(buf, o)
        }
    }

    // Brick-wall limiter without look-ahead: the gain drops at once to keep every sample under the ceiling.
    private fun limit(buf: FloatArray, o: Int) {
        limGain = limRelease * limGain + (1 - limRelease)
        val peak = peakOf(buf, o)
        if (peak * limGain > CEILING) limGain = CEILING / peak
        gain(buf, o, limGain)
        for (ch in 0 until channels) buf[o + ch] = buf[o + ch].coerceIn(-CEILING, CEILING)
    }

    private fun peakOf(buf: FloatArray, o: Int): Float {
        var p = 0f
        for (ch in 0 until channels) p = max(p, abs(buf[o + ch]))
        return p
    }

    private fun gain(buf: FloatArray, o: Int, g: Float) {
        for (ch in 0 until channels) buf[o + ch] *= g
    }

    // RBJ cookbook second-order Butterworth, transposed direct form II.
    private class Biquad(fs: Int, f: Double, highPass: Boolean) {
        private val b0: Float
        private val b1: Float
        private val b2: Float
        private val a1: Float
        private val a2: Float
        private var z1 = 0f
        private var z2 = 0f

        init {
            val w = 2 * PI * f / fs
            val cw = cos(w)
            val alpha = sin(w) / (2 * 0.7071)
            val a0 = 1 + alpha
            val n = if (highPass) (1 + cw) / 2 else (1 - cw) / 2
            b0 = (n / a0).toFloat()
            b1 = ((if (highPass) -2 * n else 2 * n) / a0).toFloat()
            b2 = b0
            a1 = (-2 * cw / a0).toFloat()
            a2 = ((1 - alpha) / a0).toFloat()
        }

        fun run(x: Float): Float {
            val y = b0 * x + z1
            z1 = b1 * x - a1 * y + z2
            z2 = b2 * x - a2 * y
            return y
        }
    }

    companion object {
        const val CEILING = 0.944f // -0.5 dBFS
        const val BOOST = 1.5f // desktop volume-max 150
        const val NIGHT_THRESHOLD = 0.1f
        const val NIGHT_RATIO = 4f
        const val NIGHT_MAKEUP = 2f
        const val NORM_PEAK = 0.9f
        const val NORM_MAX_GAIN = 8f
        const val DIALOGUE_CENTRE = 1.41f
        const val DIALOGUE_OTHERS = 0.71f

        // Above the threshold the level grows at 1/ratio (in dB).
        fun compressorGain(env: Float): Float =
            if (env <= NIGHT_THRESHOLD) 1f else (env / NIGHT_THRESHOLD).pow(1 / NIGHT_RATIO - 1)
    }
}

// Media3 hook for AudioFxChain on 16-bit or float PCM. Always active for those formats (a copy when every
// effect is off) so a toggle takes effect without reconfiguring the sink.
class AudioFxProcessor : BaseAudioProcessor() {
    private var chain: AudioFxChain? = null
    private var scratch = FloatArray(0)

    override fun onConfigure(inputAudioFormat: AudioFormat): AudioFormat =
        if (inputAudioFormat.encoding == C.ENCODING_PCM_16BIT || inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT) inputAudioFormat else AudioFormat.NOT_SET

    override fun onFlush(streamMetadata: StreamMetadata) {
        chain = AudioFxChain(inputAudioFormat.sampleRate, inputAudioFormat.channelCount)
    }

    override fun onReset() {
        chain = null
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val bytes = inputBuffer.remaining()
        if (bytes == 0) return
        val out = replaceOutputBuffer(bytes)
        val c = AudioFx.config
        val ch = chain
        if (!c.any || ch == null) {
            out.put(inputBuffer).flip()
            return
        }
        val float = inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT
        val n = bytes / if (float) 4 else 2
        if (scratch.size < n) scratch = FloatArray(n)
        val s = scratch
        val p = inputBuffer.position()
        if (float) for (i in 0 until n) s[i] = inputBuffer.getFloat(p + 4 * i)
        else for (i in 0 until n) s[i] = inputBuffer.getShort(p + 2 * i) / 32768f
        inputBuffer.position(inputBuffer.limit())
        ch.process(s, n / inputAudioFormat.channelCount, c)
        if (float) for (i in 0 until n) out.putFloat(s[i])
        else for (i in 0 until n) out.putShort((s[i] * 32768f).roundToInt().coerceIn(-32768, 32767).toShort())
        out.flip()
    }
}
