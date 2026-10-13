package com.wika.wicaby.core.player

import androidx.media3.common.PlaybackException
import java.io.EOFException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.SocketException
import java.net.UnknownHostException

/**
 * What Playback does after a VOD player error (plezy-triage B01/B03). Pure, so the rules are unit tested:
 * - TRANSCODE: the server converts instead (direct play and stream off), once per item. Decoder, parsing,
 *   audio sink and other source errors on a direct play or direct stream.
 * - TRANSCODE_LOW: the same at a lower bitrate, after an OutOfMemoryError (any method, once).
 * - RELOAD: a passing network or server hiccup: reload at the position with [Backoff].
 * - NONE: show the error (with Retry).
 */
object Recovery {
    enum class Fix { TRANSCODE, TRANSCODE_LOW, RELOAD, NONE }

    /** The bitrate cap of TRANSCODE_LOW (b/s): 4K HEVC remuxes are what fill a small heap. */
    const val LOW_BITRATE = 20_000_000

    fun decide(code: Int, cause: Throwable?, httpStatus: Int, playMethod: String, fellBack: Boolean): Fix {
        val chain = generateSequence(cause) { it.cause }.take(8).toList()
        // Loader turns an OOM while buffering into a source error (field evidence on a 192 MB heap TV).
        if (chain.any { it is OutOfMemoryError }) return if (fellBack) Fix.NONE else Fix.TRANSCODE_LOW
        if (transient(code, chain, httpStatus)) return Fix.RELOAD
        if (fellBack || playMethod == "Transcode") return Fix.NONE
        return when {
            code in 3001..3004 || code in 4001..4005 || code in 5001..5004 -> Fix.TRANSCODE
            // The static stream refused (415, 404 on a remux…): the server can still convert it. Not a refusal.
            code == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS && httpStatus != 401 && httpStatus != 403 -> Fix.TRANSCODE
            code == PlaybackException.ERROR_CODE_IO_UNSPECIFIED || code == PlaybackException.ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE -> Fix.TRANSCODE
            else -> Fix.NONE
        }
    }

    private fun transient(code: Int, chain: List<Throwable>, httpStatus: Int): Boolean = when (code) {
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
        PlaybackException.ERROR_CODE_TIMEOUT,
        // A codec taken back while the app sat in the background: a plain reload gets a new one.
        PlaybackException.ERROR_CODE_DECODING_RESOURCES_RECLAIMED -> true
        PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> httpStatus >= 500
        // A read cut mid-stream (connection reset, timeout, server gone) surfaces unspecified.
        PlaybackException.ERROR_CODE_IO_UNSPECIFIED -> chain.any {
            it is SocketException || it is InterruptedIOException || it is UnknownHostException || it is ConnectException || it is EOFException
        }
        else -> false
    }
}

/**
 * Reconnect delays: 1, 2, 4, 8, 16 s, then 30 s, until [giveUpMs] after the first failure (the last wait is
 * cut to end there). [next] gives the wait before the next attempt, or null once it is time to give up.
 */
class Backoff(private val now: () -> Long, private val giveUpMs: Long = 60_000, private val maxMs: Long = 30_000) {
    private var since = -1L
    private var attempts = 0

    fun next(): Long? {
        val t = now()
        if (since < 0) since = t
        val left = giveUpMs - (t - since)
        if (left <= 0) return null
        val wait = if (attempts >= 15) maxMs else minOf(maxMs, 1_000L shl attempts)
        attempts++
        return minOf(wait, left)
    }

    fun reset() {
        since = -1
        attempts = 0
    }
}
