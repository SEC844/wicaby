package com.wika.wicaby.core.songid

import android.content.Context
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import android.media.MediaCodec
import android.media.MediaDataSource
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.nio.ByteOrder
import java.text.Normalizer
import java.util.UUID
import kotlin.math.max
import kotlin.math.min

/**
 * "What's this song?" in a film or episode, the twin of desktop's main/playback/song-id.ts: the 12 s around the
 * position decoded again from the same file (MediaExtractor + MediaCodec, nothing played, no microphone) to 16 kHz
 * mono, turned into a Shazam signature ([ShazamSignature]) and sent to the discovery endpoint SongRec uses
 * (github.com/marin-m/SongRec, GPL-3.0). Only that signature leaves the device. The user asks for each one; the
 * player says so before the first.
 */
object SongId {
    enum class Error { UNAVAILABLE, NOMATCH, RATE_LIMITED, FAILED }

    class Outcome(val song: ShazamSignature.Song? = null, val error: Error? = null)

    private const val SHAZAM = "https://amp.shazam.com/discovery/v5/en/US/android/-/tag"
    // SongRec's client identity: an Android user agent, which the endpoint answers.
    private const val USER_AGENT = "Dalvik/2.1.0 (Linux; U; Android 6.0.1; SM-G920F Build/MMB29K)"

    suspend fun identify(context: Context, http: OkHttpClient, source: Uri?, positionMs: Long): Outcome = withContext(Dispatchers.IO) {
        source ?: return@withContext Outcome(error = Error.UNAVAILABLE)
        val pcm = runCatching { decode(context, http, source, positionMs) }
            .onFailure { Log.w("Wicaby", "song id: decode failed", it) }.getOrNull()
        if (pcm == null || pcm.size < ShazamSignature.SAMPLE_RATE * 4) return@withContext Outcome(error = Error.UNAVAILABLE)
        val sig = ShazamSignature.of(pcm)
        if (sig.peaks == 0) return@withContext Outcome(error = Error.NOMATCH)
        val now = System.currentTimeMillis()
        // A fixed, coarse location and zone, as SongRec sends: nothing about the user.
        val body = buildJsonObject {
            putJsonObject("geolocation") { put("altitude", 300); put("latitude", 45); put("longitude", 2) }
            putJsonObject("signature") { put("samplems", sig.sampleMs); put("timestamp", now); put("uri", sig.uri) }
            put("timestamp", now)
            put("timezone", "Europe/Paris")
        }
        val req = Request.Builder()
            .url("$SHAZAM/${UUID.randomUUID().toString().uppercase()}/${UUID.randomUUID()}?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&video=v3")
            .header("Content-Language", "en_US")
            .header("User-Agent", USER_AGENT)
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        runCatching {
            http.newCall(req).execute().use { r ->
                when {
                    r.code == 429 -> Outcome(error = Error.RATE_LIMITED)
                    !r.isSuccessful -> Outcome(error = Error.FAILED)
                    else -> ShazamSignature.songOf(r.body.string())?.let { Outcome(song = it) } ?: Outcome(error = Error.NOMATCH)
                }
            }
        }.getOrElse {
            Log.w("Wicaby", "song id: request failed", it)
            Outcome(error = Error.FAILED)
        }
    }

    private val prefs get() = Core.app.getSharedPreferences("wicaby_song_id", Context.MODE_PRIVATE)

    /** The one-line notice (a fingerprint goes to Shazam) was shown: later uses start at once. */
    var noticeSeen: Boolean
        get() = prefs.getBoolean("notice", false)
        set(v) = prefs.edit().putBoolean("notice", v).apply()

    /** The track in this server's music: found by title, kept when one of its artists is in Shazam's artist line ("A & B"). */
    suspend fun findInLibrary(api: Api, song: ShazamSignature.Song): Item? {
        val artist = norm(song.artist)
        return api.items("SearchTerm" to song.title, "IncludeItemTypes" to "Audio", "Recursive" to true, "Limit" to 25).items
            .firstOrNull { i -> (i.artists + listOfNotNull(i.albumArtist)).any { a -> norm(a).let { it.isNotEmpty() && artist.contains(it) } } }
    }

    internal fun norm(s: String) =
        Normalizer.normalize(s.lowercase(), Normalizer.Form.NFKD).replace(Regex("\\p{M}+"), "").replace(Regex("[^\\p{L}\\p{N}]+"), " ").trim()

    // Mostly what was just heard: 10 s back, 2 s ahead. Null when the file has no audio track this device decodes.
    private fun decode(context: Context, http: OkHttpClient, uri: Uri, positionMs: Long): ShortArray? {
        val ex = MediaExtractor()
        var codec: MediaCodec? = null
        try {
            if (uri.scheme == "http" || uri.scheme == "https") ex.setDataSource(HttpSource(http, uri.toString())) else ex.setDataSource(context, uri, null)
            val track = (0 until ex.trackCount).firstOrNull { ex.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true } ?: return null
            val format = ex.getTrackFormat(track)
            ex.selectTrack(track)
            val startUs = max(0L, positionMs - 10_000) * 1000
            val endUs = startUs + ShazamSignature.SNIPPET_MS * 1000
            ex.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
            codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!).apply { configure(format, null, null, 0); start() }
            var rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            var float = false
            val mono = ArrayList<Float>(ShazamSignature.SAMPLE_RATE * 13 * 3)
            val info = MediaCodec.BufferInfo()
            var inputDone = false
            val deadline = SystemClock.elapsedRealtime() + 20_000
            while (SystemClock.elapsedRealtime() < deadline) {
                if (!inputDone) {
                    val i = codec.dequeueInputBuffer(10_000)
                    if (i >= 0) {
                        val n = ex.readSampleData(codec.getInputBuffer(i)!!, 0)
                        if (n < 0 || ex.sampleTime > endUs) {
                            codec.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            codec.queueInputBuffer(i, 0, n, ex.sampleTime, 0)
                            ex.advance()
                        }
                    }
                }
                val o = codec.dequeueOutputBuffer(info, 10_000)
                if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    val f = codec.outputFormat
                    rate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                    channels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                    // AudioFormat.ENCODING_PCM_FLOAT
                    float = f.containsKey("pcm-encoding") && f.getInteger("pcm-encoding") == 4
                } else if (o >= 0) {
                    if (info.presentationTimeUs in startUs until endUs && info.size > 0) {
                        val buf = codec.getOutputBuffer(o)!!.apply { position(info.offset); limit(info.offset + info.size) }.order(ByteOrder.nativeOrder())
                        // Down to mono: the mean of the channels.
                        if (float) {
                            val fb = buf.asFloatBuffer()
                            while (fb.remaining() >= channels) mono.add((0 until channels).sumOf { fb.get().toDouble() }.toFloat() / channels * 32767f)
                        } else {
                            val sb = buf.asShortBuffer()
                            while (sb.remaining() >= channels) mono.add((0 until channels).sumOf { sb.get().toInt() }.toFloat() / channels)
                        }
                    }
                    codec.releaseOutputBuffer(o, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0 || info.presentationTimeUs >= endUs) break
                }
            }
            return resample(mono, rate)
        } finally {
            runCatching { codec?.stop() }
            codec?.release()
            ex.release()
        }
    }

    // Linear interpolation to 16 kHz.
    internal fun resample(src: List<Float>, rate: Int): ShortArray {
        val step = rate.toDouble() / ShazamSignature.SAMPLE_RATE
        val n = min((src.size / step).toLong(), ShazamSignature.SAMPLE_RATE * ShazamSignature.SNIPPET_MS / 1000).toInt()
        return ShortArray(n) { i ->
            val x = i * step
            val a = x.toInt()
            val b = min(a + 1, src.size - 1)
            val v = src[a] + (src[b] - src[a]) * (x - a).toFloat()
            v.coerceIn(-32768f, 32767f).toInt().toShort()
        }
    }

    // MediaExtractor over the app's OkHttpClient, so the server's auth and the transport (mesh, LAN) apply as for
    // the player. Ranged reads in 512 KiB blocks, the last 32 kept (an MKV's index sits at the end).
    private class HttpSource(private val http: OkHttpClient, private val url: String) : MediaDataSource() {
        private var length = -1L
        private val blocks = object : LinkedHashMap<Long, ByteArray>(16, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, ByteArray>?) = size > 32
        }

        private fun block(index: Long): ByteArray = blocks.getOrPut(index) {
            val from = index * BLOCK
            val req = Request.Builder().url(url).header("Range", "bytes=$from-${from + BLOCK - 1}").build()
            http.newCall(req).execute().use { r ->
                if (r.code != 206) throw IOException("no range support (${r.code})")
                r.header("Content-Range")?.substringAfter('/')?.toLongOrNull()?.let { length = it }
                r.body.bytes()
            }
        }

        override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
            if (length < 0) block(0)
            if (position >= length) return -1
            val data = block(position / BLOCK)
            val at = (position % BLOCK).toInt()
            val n = min(size, data.size - at)
            if (n <= 0) return -1
            System.arraycopy(data, at, buffer, offset, n)
            return n
        }

        override fun getSize(): Long {
            if (length < 0) block(0)
            return length
        }

        override fun close() = blocks.clear()

        companion object {
            const val BLOCK = 512L * 1024
        }
    }
}
