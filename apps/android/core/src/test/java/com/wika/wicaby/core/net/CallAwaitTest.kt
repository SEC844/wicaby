package com.wika.wicaby.core.net

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket

class CallAwaitTest {
    // A host that accepts and never answers: cancelling the coroutine aborts the call at once, not at its timeout.
    @Test
    fun cancellingTheCoroutineCancelsTheCall() = runBlocking {
        ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { mute ->
            val call = OkHttpClient().newCall(Request.Builder().url("http://127.0.0.1:${mute.localPort}/").build())
            val start = System.nanoTime()
            assertNull(withTimeoutOrNull(200) { call.await() })
            assertTrue(call.isCanceled())
            assertTrue((System.nanoTime() - start) / 1_000_000 < 5_000)
        }
    }

    @Test
    fun cancellingTheCoroutineCancelsABlockingCall() = runBlocking {
        ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { mute ->
            val call = OkHttpClient().newCall(Request.Builder().url("http://127.0.0.1:${mute.localPort}/").build())
            val start = System.nanoTime()
            assertNull(withTimeoutOrNull(200) { withContext(Dispatchers.IO) { call.executeUse { it.code } } })
            assertTrue(call.isCanceled())
            assertTrue((System.nanoTime() - start) / 1_000_000 < 5_000)
        }
    }

    @Test
    fun bodiesAreReadWithinCaps() {
        assertEquals("abc", "abc".toResponseBody().cappedString(3))
        assertTrue(runCatching { "abcd".toResponseBody().cappedString(3) }.exceptionOrNull() is java.io.IOException)
        assertEquals("ab", "abcd".toResponseBody().head(2))
        assertEquals("abcd", "abcd".toResponseBody().head(256))
    }
}
