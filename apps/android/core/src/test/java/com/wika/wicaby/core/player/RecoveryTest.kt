package com.wika.wicaby.core.player

import androidx.media3.common.PlaybackException
import androidx.media3.exoplayer.upstream.Loader
import com.wika.wicaby.core.player.Recovery.Fix
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException
import java.net.SocketException
import java.net.SocketTimeoutException

class RecoveryTest {
    private fun decide(code: Int, cause: Throwable? = null, status: Int = 0, method: String = "DirectPlay", fellBack: Boolean = false) =
        Recovery.decide(code, cause, status, method, fellBack)

    @Test
    fun decoderAndParsingErrorsTranscodeOnce() {
        for (code in listOf(
            PlaybackException.ERROR_CODE_DECODER_INIT_FAILED, PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED, PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
            PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED, PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED,
        )) {
            assertEquals("$code", Fix.TRANSCODE, decide(code))
            assertEquals("$code direct stream", Fix.TRANSCODE, decide(code, method = "DirectStream"))
            // Once per item, and never from a transcode: the error (with Retry) instead of a loop (Plezy #800).
            assertEquals("$code again", Fix.NONE, decide(code, fellBack = true))
            assertEquals("$code transcoding", Fix.NONE, decide(code, method = "Transcode"))
        }
    }

    @Test
    fun outOfMemoryInASourceErrorTranscodesLower() {
        // The field log: "Source error … Caused by: java.lang.OutOfMemoryError" (Loader wraps it).
        val oom = Loader.UnexpectedLoaderException(OutOfMemoryError("Failed to allocate a 65552 byte allocation"))
        assertEquals(Fix.TRANSCODE_LOW, decide(PlaybackException.ERROR_CODE_IO_UNSPECIFIED, oom))
        assertEquals(Fix.TRANSCODE_LOW, decide(PlaybackException.ERROR_CODE_IO_UNSPECIFIED, oom, method = "Transcode"))
        assertEquals(Fix.NONE, decide(PlaybackException.ERROR_CODE_IO_UNSPECIFIED, oom, fellBack = true))
    }

    @Test
    fun networkErrorsReloadWhateverTheMethod() {
        for (method in listOf("DirectPlay", "DirectStream", "Transcode")) for (fellBack in listOf(false, true)) {
            assertEquals(Fix.RELOAD, decide(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED, method = method, fellBack = fellBack))
            assertEquals(Fix.RELOAD, decide(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT, method = method, fellBack = fellBack))
            assertEquals(Fix.RELOAD, decide(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, status = 503, method = method, fellBack = fellBack))
            assertEquals(Fix.RELOAD, decide(PlaybackException.ERROR_CODE_IO_UNSPECIFIED, IOException(SocketException("Connection reset")), method = method))
            assertEquals(Fix.RELOAD, decide(PlaybackException.ERROR_CODE_IO_UNSPECIFIED, SocketTimeoutException("timeout"), method = method))
        }
        // A codec reclaimed in the background: a plain reload.
        assertEquals(Fix.RELOAD, decide(PlaybackException.ERROR_CODE_DECODING_RESOURCES_RECLAIMED))
    }

    @Test
    fun otherSourceErrorsAndRefusals() {
        assertEquals(Fix.TRANSCODE, decide(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, status = 415))
        assertEquals(Fix.TRANSCODE, decide(PlaybackException.ERROR_CODE_IO_UNSPECIFIED, IllegalStateException("parser")))
        // A refusal is not fixed by the server's conversion.
        assertEquals(Fix.NONE, decide(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, status = 401))
        assertEquals(Fix.NONE, decide(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, status = 403))
        assertEquals(Fix.NONE, decide(PlaybackException.ERROR_CODE_DRM_UNSPECIFIED))
        assertEquals(Fix.NONE, decide(PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW))
    }

    @Test
    fun backoffDoublesToThirtyAndGivesUpAfterAMinute() {
        var now = 1_000L
        val b = Backoff({ now })
        val waits = generateSequence { b.next()?.also { now += it } }.toList()
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 29_000L), waits)
        assertNull(b.next())
        // A stream that plays again starts over.
        b.reset()
        assertEquals(1_000L, b.next())
    }

    @Test
    fun slowAttemptsCountTowardsTheMinute() {
        var now = 0L
        val b = Backoff({ now })
        assertEquals(1_000L, b.next())
        now += 1_000 + 20_000 // the wait, then an attempt that hung 20 s
        assertEquals(2_000L, b.next())
        now += 2_000 + 30_000
        assertEquals(4_000L, b.next())
        now += 4_000 + 3_000
        assertNull(b.next())
    }
}
