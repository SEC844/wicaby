package com.wika.wicaby.core.player

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// The process-wide report queue (cast spec §8.4): a hung server does not make it grow, and after{} holds what follows.
class SessionReporterTest {
    private lateinit var server: MockWebServer
    private val got = CopyOnWriteArrayList<RecordedRequest>()
    private val hang = CountDownLatch(1)

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                got += request
                // The first Playing hangs until the test lets it go, as a server that accepts but does not answer.
                if (request.url.encodedPath == "/Sessions/Playing" && got.size == 1) hang.await(5, TimeUnit.SECONDS)
                return MockResponse.Builder().code(204).build()
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        hang.countDown()
        server.close()
    }

    private fun reporter() = SessionReporter(Api(Server("s", "S", server.url("/").toString().trimEnd('/'), "jellyfin"), "phone", "t", "u"))

    private fun pos(n: Int) = buildJsonObject { put("PositionTicks", n) }

    @Test
    fun hungServerKeepsOnlyTheLatestProgressAndPing() = runBlocking {
        val r = reporter()
        r.report("/Sessions/Playing", pos(0))
        withTimeout(5_000) { while (got.isEmpty()) delay(10) }
        for (n in 1..50) {
            r.report("/Sessions/Playing/Progress", pos(n))
            r.ping("ps-$n")
        }
        val stopped = r.stopped(pos(99))
        hang.countDown()
        assertTrue(withTimeout(5_000) { stopped.await() })
        assertEquals(listOf("/Sessions/Playing", "/Sessions/Playing/Progress", "/Sessions/Playing/Ping", "/Sessions/Playing/Stopped"), got.map { it.url.encodedPath })
        assertTrue(got[1].body!!.utf8().contains("\"PositionTicks\":50"))
        assertEquals("ps-50", got[2].url.queryParameter("PlaySessionId"))
    }

    @Test
    fun afterHoldsLaterReports() = runBlocking {
        hang.countDown()
        val r = reporter()
        val gate = CompletableDeferred<Unit>()
        r.after { gate.await() }
        r.report("/Sessions/Playing", pos(1))
        // A Progress queued behind the barrier is not merged into anything queued before it.
        r.report("/Sessions/Playing/Progress", pos(2))
        delay(300)
        assertTrue(got.isEmpty())
        gate.complete(Unit)
        withTimeout(5_000) { while (got.size < 2) delay(10) }
        assertEquals(listOf("/Sessions/Playing", "/Sessions/Playing/Progress"), got.map { it.url.encodedPath })
    }
}
