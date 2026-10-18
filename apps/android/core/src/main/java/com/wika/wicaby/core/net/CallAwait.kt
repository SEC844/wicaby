package com.wika.wicaby.core.net

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dispatcher
import okhttp3.Response
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

// Probes run on their own dispatcher: on Core.http's (5 calls per host, shared with image loads)
// they would wait behind a poster grid and lose their race to a farther address.
internal val probeDispatcher by lazy { Dispatcher() }
