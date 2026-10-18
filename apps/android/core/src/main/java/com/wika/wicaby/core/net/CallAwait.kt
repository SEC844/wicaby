package com.wika.wicaby.core.net

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dispatcher
import okhttp3.Response
import okhttp3.ResponseBody
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

// A call a cancelled coroutine aborts (a blocking execute() would run to its timeout): races stop at the first answer.
internal suspend fun Call.await(): Response = suspendCancellableCoroutine { c ->
    c.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) = c.resumeWithException(e)
        // Cancelled meanwhile (a probe that lost its race): the response is closed, not leaked.
        override fun onResponse(call: Call, response: Response) = c.resume(response) { _, r, _ -> r.close() }
    })
}

// A blocking execute() (no per-host dispatcher queue) that a cancelled coroutine still aborts; [use]
// reads the response before it closes. Run it on an IO dispatcher.
internal suspend fun <T> Call.executeUse(use: (Response) -> T): T = coroutineScope {
    val watch = launch(start = CoroutineStart.UNDISPATCHED) { try { awaitCancellation() } finally { this@executeUse.cancel() } }
    try {
        execute().use(use)
    } catch (e: IOException) {
        ensureActive() // aborted by our own cancel: a CancellationException, not a network failure
        throw e
    } finally {
        watch.cancel()
    }
}

// What a server answer may hold as text: a hostile or broken body is an IOException, not an OutOfMemoryError.
internal const val BODY_CAP = 64L shl 20

internal fun ResponseBody.cappedString(cap: Long = BODY_CAP): String {
    val src = source()
    if (src.request(cap + 1)) throw IOException("answer over $cap bytes")
    return src.buffer.readString(contentType()?.charset() ?: Charsets.UTF_8)
}

// The first [n] bytes of an error answer, for its message.
internal fun ResponseBody.head(n: Long = 256): String {
    val src = source()
    src.request(n)
    return src.buffer.readUtf8(minOf(n, src.buffer.size))
}

// Probes run on their own dispatcher: on Core.http's (5 calls per host, shared with image loads)
// they would wait behind a poster grid and lose their race to a farther address.
internal val probeDispatcher by lazy { Dispatcher() }
