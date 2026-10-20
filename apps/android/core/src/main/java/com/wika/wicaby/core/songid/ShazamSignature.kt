package com.wika.wicaby.core.songid

import android.util.Base64
import com.wika.wicaby.core.data.json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import java.io.ByteArrayOutputStream
import java.net.URLEncoder
import java.util.zip.CRC32
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.sin

/**
 * "What's this song?": the Shazam audio signature and the reading of its answer, the twin of desktop's
 * shared/song-id.ts (both run tools/checks/fixtures/song-id/signature.json). Ported from SongRec (Marin M., GPL-3.0,
 * github.com/marin-m/SongRec, python-version/fingerprinting/algorithm.py and signature_format.py).
 */
object ShazamSignature {
    const val SAMPLE_RATE = 16_000
    // What one recognition sends: 12 s of 16 kHz mono, as SongRec does.
    const val SNIPPET_MS = 12_000L

    class Result(val uri: String, val sampleMs: Int, val peaks: Int)

    private class Peak(val pass: Int, val magnitude: Int, val bin: Int)

    // numpy.hanning(2050)[1:-1]: the window without its zero ends.
    private val HANNING = DoubleArray(2048) { 0.5 - 0.5 * cos(2 * Math.PI * (it + 1) / 2049) }
    private val COS = DoubleArray(1024) { cos(-2 * Math.PI * it / 2048) }
    private val SIN = DoubleArray(1024) { sin(-2 * Math.PI * it / 2048) }

    // In-place radix-2 FFT of 2048 points.
    private fun fft(re: DoubleArray, im: DoubleArray) {
        val n = re.size
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) {
                j = j xor bit
                bit = bit shr 1
            }
            j = j xor bit
            if (i < j) {
                re[i] = re[j].also { re[j] = re[i] }
                im[i] = im[j].also { im[j] = im[i] }
            }
        }
        var len = 2
        while (len <= n) {
            val step = n / len
            val half = len / 2
            for (i in 0 until n step len) for (k in 0 until half) {
                val wr = COS[k * step]
                val wi = SIN[k * step]
                val a = i + k
                val b = a + half
                val xr = re[b] * wr - im[b] * wi
                val xi = re[b] * wi + im[b] * wr
                re[b] = re[a] - xr
                im[b] = im[a] - xi
                re[a] += xr
                im[a] += xi
            }
            len = len shl 1
        }
    }

    // 0..3: 250-520 Hz, 520-1450 Hz, 1450-3500 Hz, 3500-5500 Hz; -1 outside.
    private fun bandOf(hz: Double) = when {
        hz < 250 -> -1
        hz < 520 -> 0
        hz < 1450 -> 1
        hz < 3500 -> 2
        hz <= 5500 -> 3
        else -> -1
    }

    private fun magnitudeOf(v: Double) = ln(max(1.0 / 64, v)) * 1477.3 + 6144

    private val BACK = intArrayOf(-1, -3, -6)
    private val NEIGHBOURS = intArrayOf(-10, -7, -4, -3, 1, 2, 5, 8)
    private val OTHERS = intArrayOf(-53, -45, 165, 172, 179, 186, 193, 200, 214, 221, 228, 235, 242, 249)

    // Signed 16-bit 16 kHz mono samples -> the peaks per band (SongRec SignatureGenerator.process_input).
    private fun peaksOf(samples: ShortArray): List<MutableList<Peak>> {
        val bands = List(4) { mutableListOf<Peak>() }
        val ring = ShortArray(2048)
        var ringPos = 0
        val ffts = Array(256) { DoubleArray(1025) }
        val spread = Array(256) { DoubleArray(1025) }
        var fftPos = 0
        var spreadPos = 0
        var written = 0
        val re = DoubleArray(2048)
        val im = DoubleArray(2048)
        fun at(pos: Int, off: Int) = ((pos + off) % 256 + 256) % 256

        var chunk = 0
        while (chunk + 128 <= samples.size) {
            System.arraycopy(samples, chunk, ring, ringPos, 128)
            chunk += 128
            ringPos = (ringPos + 128) and 2047
            for (i in 0 until 2048) {
                re[i] = ring[(ringPos + i) and 2047] * HANNING[i]
                im[i] = 0.0
            }
            fft(re, im)
            val out = ffts[fftPos]
            for (i in 0 until 1025) out[i] = max((re[i] * re[i] + im[i] * im[i]) / (1 shl 17), 1e-10)
            fftPos = (fftPos + 1) % 256

            // Peak spreading: over frequency (max of 3 bins), then into the 1st, 3rd and 6th previous outputs.
            val s = spread[spreadPos]
            out.copyInto(s)
            for (p in 0 until 1025) {
                if (p < 1023) s[p] = max(s[p], max(s[p + 1], s[p + 2]))
                var m = s[p]
                for (back in BACK) {
                    val former = spread[at(spreadPos, back)]
                    m = max(former[p], m)
                    former[p] = m
                }
            }
            spreadPos = (spreadPos + 1) % 256
            written++
            if (written < 46) continue

            // Peak recognition on the output 46 passes back.
            val f46 = ffts[at(fftPos, -46)]
            val s49 = spread[at(spreadPos, -49)]
            for (bin in 10 until 1015) {
                val v = f46[bin]
                if (v < 1.0 / 64 || v < s49[bin - 1]) continue
                var nb = 0.0
                for (off in NEIGHBOURS) nb = max(nb, s49[bin + off])
                if (v <= nb) continue
                for (off in OTHERS) nb = max(nb, spread[at(spreadPos, off)][bin - 1])
                if (v <= nb) continue
                val mag = magnitudeOf(v)
                val before = magnitudeOf(f46[bin - 1])
                val after = magnitudeOf(f46[bin + 1])
                val corrected = bin * 64 + (after - before) * 32 / (mag * 2 - before - after)
                val band = bandOf(corrected * (SAMPLE_RATE / 2.0 / 1024 / 64))
                if (band >= 0) bands[band].add(Peak(written - 46, mag.toInt(), corrected.toInt()))
            }
        }
        return bands
    }

    private fun ByteArrayOutputStream.u32(v: Long) {
        for (s in 0..24 step 8) write(((v shr s) and 0xff).toInt())
    }

    // The binary signature (SongRec DecodedMessage.encode_to_binary): a 48-byte header, then one TLV per band.
    private fun encode(bands: List<List<Peak>>, sampleCount: Int): ByteArray {
        val body = ByteArrayOutputStream()
        bands.forEachIndexed { band, peaks ->
            if (peaks.isEmpty()) return@forEachIndexed
            val buf = ByteArrayOutputStream()
            var pass = 0
            for (p in peaks) {
                if (p.pass - pass >= 255) {
                    buf.write(0xff)
                    buf.u32(p.pass.toLong())
                    pass = p.pass
                }
                buf.write(p.pass - pass)
                buf.write(p.magnitude and 0xff)
                buf.write((p.magnitude shr 8) and 0xff)
                buf.write(p.bin and 0xff)
                buf.write((p.bin shr 8) and 0xff)
                pass = p.pass
            }
            body.u32(0x60030040L + band)
            body.u32(buf.size().toLong())
            buf.writeTo(body)
            repeat((4 - buf.size() % 4) % 4) { body.write(0) }
        }
        val out = ByteArrayOutputStream()
        val size = body.size() + 8L
        // magic1, crc32 (below), size minus header, magic2, 3 void, sample rate id 3 (16 kHz) << 27, 2 void,
        // samples + 0.24 s, a fixed value; then the 0x40000000 chunk that repeats the size.
        for (v in longArrayOf(0xcafe2580, 0, size, 0x94119c00, 0, 0, 0, 3L shl 27, 0, 0, sampleCount + SAMPLE_RATE * 24L / 100, (15L shl 19) + 0x40000, 0x40000000, size)) out.u32(v)
        body.writeTo(out)
        val bytes = out.toByteArray()
        val crc = CRC32().apply { update(bytes, 8, bytes.size - 8) }.value
        for (i in 0 until 4) bytes[4 + i] = (crc shr (8 * i)).toByte()
        return bytes
    }

    /** 16 kHz mono s16 PCM -> the data: URI the discovery endpoint takes. */
    fun of(samples: ShortArray): Result {
        val bands = peaksOf(samples)
        val b64 = Base64.encodeToString(encode(bands, samples.size), Base64.NO_WRAP)
        return Result("data:audio/vnd.shazam.sig;base64,$b64", (samples.size * 1000L / SAMPLE_RATE).toInt(), bands.sumOf { it.size })
    }

    data class Song(val title: String, val artist: String, val album: String?, val coverUrl: String?, val shazamUrl: String?)

    /** The parts of a discovery answer the card shows; null when nothing matched. */
    fun songOf(body: String): Song? {
        val track = runCatching { json.parseToJsonElement(body).jsonObject["track"] as? JsonObject }.getOrNull() ?: return null
        fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }
        val title = track.str("title") ?: return null
        val images = track["images"] as? JsonObject
        val album = (track["sections"] as? JsonArray)?.mapNotNull { it as? JsonObject }?.firstOrNull { it.str("type") == "SONG" }
            ?.let { it["metadata"] as? JsonArray }?.mapNotNull { it as? JsonObject }?.firstOrNull { it.str("title") == "Album" }?.str("text")
        fun https(v: String?) = v?.takeIf { it.startsWith("https://") }
        return Song(title, track.str("subtitle") ?: "", album, https(images?.str("coverart")) ?: https(images?.str("coverarthq")), https(track.str("url")))
    }

    /** Search links on the big services: no account, no API, the browser does the rest. */
    fun links(song: Song): List<Pair<String, String>> {
        val q = URLEncoder.encode("${song.artist} ${song.title}".trim(), "UTF-8").replace("+", "%20")
        return listOf(
            "shazam" to (song.shazamUrl ?: "https://www.shazam.com/search?term=$q"),
            "spotify" to "https://open.spotify.com/search/$q",
            "youtube" to "https://www.youtube.com/results?search_query=$q",
            "apple" to "https://music.apple.com/search?term=$q",
        )
    }
}
