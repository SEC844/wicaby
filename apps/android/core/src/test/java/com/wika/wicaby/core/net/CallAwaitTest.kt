package com.wika.wicaby.core.net

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
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
}
