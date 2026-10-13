package com.wika.wicaby.core.livetv

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.lang.management.ManagementFactory
import java.nio.file.Files
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

// LiveTvApi and LiveTvRepository over HTTP (mockwebserver3): golden requests, streamed decoding
// (parity with normalizeProgram, canonical channel ids, the allocation budget of §2.2 / §21.9),
// the retry rule (F9), clock skew (§21.4), and a lens change served from the cache (§7.1).
// Payloads were recorded from tools/mock-server (MOCK_LIVETV=iptv, anchor 2026-10-11T18:00Z):
// 25 channels, and their programmes over 6 h (18:00–24:00 UTC).
class DialectHttpTest {
    private lateinit var server: MockWebServer
    private lateinit var dir: File
    private lateinit var scope: CoroutineScope

    private val channelsJson = resource("channels-25.json").replace(Regex("\"TotalRecordCount\":[0-9]+"), "\"TotalRecordCount\":25")
    private val programsBytes = resource("programs-25x6h.json").toByteArray()
    private val programItems = Json.parseToJsonElement(String(programsBytes)).jsonObject["Items"]!!.jsonArray.map { it.jsonObject }
    private val channelIds = Json.parseToJsonElement(channelsJson).jsonObject["Items"]!!.jsonArray.map { (it.jsonObject["Id"] as JsonPrimitive).content }

    private val from = parseServerDate("2026-10-11T18:00:00Z")!!
    private val to = parseServerDate("2026-10-12T00:00:00Z")!!

    // Server behaviour, per test.
    @Volatile private var programsMode = "ok" // ok | 503 | slow
    @Volatile private var skewMs = 0L
    private val programsCalls = AtomicInteger()
    private val programKeys = java.util.concurrent.ConcurrentLinkedQueue<String>()

    private fun resource(name: String): String =
        javaClass.classLoader!!.getResourceAsStream("livetv/$name")!!.bufferedReader(Charsets.UTF_8).readText()

    private fun httpDate(ms: Long): String =
        SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US).apply { timeZone = TimeZone.getTimeZone("GMT") }.format(Date(ms))

    private fun reply(body: String) = MockResponse.Builder().code(200).addHeader("Content-Type", "application/json")
        .addHeader("Date", httpDate(System.currentTimeMillis() + skewMs)).body(body).build()

    private fun programsFor(r: RecordedRequest): String {
        val ids = r.url.queryParameter("ChannelIds")!!.split(',').toSet()
        val min = parseServerDate(r.url.queryParameter("MinEndDate"))!!
        val max = parseServerDate(r.url.queryParameter("MaxStartDate"))!!
        val items = programItems.filter { o ->
            (o["ChannelId"] as JsonPrimitive).content in ids &&
                parseServerDate(o["EndDate"])!! > min && parseServerDate(o["StartDate"])!! < max
        }
        return JsonObject(mapOf("Items" to JsonArray(items))).toString()
    }

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("livetv").toFile()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                return when {
                    path == "/emby/LiveTv/Channels" -> reply(channelsJson)
                    path == "/emby/LiveTv/Programs" -> {
                        programsCalls.incrementAndGet()
                        programKeys.add("${request.url.queryParameter("ChannelIds")}@${request.url.queryParameter("MinEndDate")}")
                        when (programsMode) {
                            "503" -> MockResponse.Builder().code(503).body("busy").build()
                            "slow" -> MockResponse.Builder().code(200).headersDelay(2, TimeUnit.SECONDS).body("{\"Items\":[]}").build()
                            else -> reply(programsFor(request))
                        }
                    }
                    path == "/emby/LiveTv/Timers" -> reply("{\"Items\":[]}")
                    path == "/emby/LiveTv/Info" -> reply("{\"Services\":[{\"Tuners\":[\"a\",\"b\"]}]}")
                    path.startsWith("/emby/DisplayPreferences/") -> reply("{\"Id\":\"wicaby-livetv\",\"CustomPrefs\":{}}")
                    path.startsWith("/emby/Users/") -> MockResponse.Builder().code(204).build()
                    else -> MockResponse.Builder().code(404).build()
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        scope.cancel()
        server.close()
        dir.deleteRecursively()
    }

    private fun api() = LiveTvApi(Api(Server("srv", "Mock", server.url("/").toString().trimEnd('/'), "emby"), "dev", "tok", "u1"))

    // ---- Golden requests ----

    private fun assertSent(req: Req, r: RecordedRequest) {
        assertEquals(req.method, r.method)
        assertEquals("/emby" + req.path, r.url.encodedPath)
        val sent = r.url.queryParameterNames.associateWith { r.url.queryParameter(it) }
        assertEquals(req.query, sent)
        if (req.body != null) assertEquals(req.body, Json.parseToJsonElement(r.body!!.utf8()))
        assertEquals("tok", r.headers["X-Emby-Token"])
    }

    @Test
    fun goldenRequests() = runBlocking {
        val api = api()
        api.channelsPage(0, 200)
        assertSent(Dialect.channelsPage(ServerKind.EMBY, "u1", 0, 200), server.takeRequest())
        api.programsTile(listOf("ltc-001", "ltc-002"), from, to, genres = true)
        assertSent(Dialect.programsTile(ServerKind.EMBY, "u1", listOf("ltc-001", "ltc-002"), from, to, true), server.takeRequest())
        val doc = api.displayPrefs()
        assertSent(Dialect.displayPrefs(ServerKind.EMBY, "u1"), server.takeRequest())
        val body = prefsBody(doc, mapOf("lt.sort" to "name"))
        api.saveDisplayPrefs(body)
        val post = server.takeRequest()
        assertSent(Dialect.saveDisplayPrefs(ServerKind.EMBY, "u1", body), post)
        assertEquals(JsonPrimitive("wicaby"), Json.parseToJsonElement(post.body!!.utf8()).jsonObject["Client"])
        api.setFavorite("ltc-003", true)
        assertSent(Dialect.setFavorite(ServerKind.EMBY, "u1", "ltc-003", true), server.takeRequest())
        api.timers()
        assertSent(Dialect.timers(ServerKind.EMBY), server.takeRequest())
    }

    @Test
    fun channelsAreNormalized() = runBlocking {
        val (rows, total) = api().channelsPage(0, 200)
        assertEquals(25, rows.size)
        assertTrue(total!! >= 25)
        assertEquals(channelIds, rows.map { it.id })
        assertEquals((0 until 25).toList(), rows.map { it.serverIndex })
    }

    // ---- Streamed decoding ----

    @Test
    fun streamedDecodeMatchesNormalizeProgram() {
        for (kind in ServerKind.entries) for (genres in listOf(false, true)) {
            val streamed = decodePrograms(ByteArrayInputStream(programsBytes), kind, genres) { it }.programs
            val tree = programItems.mapNotNull { normalizeProgram(it, kind, if (genres) CategorySource.GENRES else null) }
            assertEquals("$kind genres=$genres", tree, streamed)
        }
        assertTrue(decodePrograms(ByteArrayInputStream(programsBytes), ServerKind.EMBY, false) { it }.sawHdKey)
        assertFalse(decodePrograms(ByteArrayInputStream("{\"Items\":[{\"Id\":\"p\",\"ChannelId\":\"c\"}]}".toByteArray()), ServerKind.EMBY, false) { it }.sawHdKey)
    }

    @Test
    fun channelIdsAreCanonical() {
        val rows = channelIds.associateWith { String(it.toCharArray()) } // the ChannelRow instances
        val ans = decodePrograms(ByteArrayInputStream(programsBytes), ServerKind.EMBY, false) { rows[it] ?: it }
        assertTrue(ans.programs.size > 200)
        ans.programs.forEach { assertSame(rows[it.channelId], it.channelId) }
    }

    @Test
    fun decodingA25ChannelBy6HourTileAllocatesUnder4MB() {
        val bean = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        val rows = channelIds.associateWith { it }
        repeat(5) { decodePrograms(ByteArrayInputStream(programsBytes), ServerKind.EMBY, false) { rows[it] ?: it } } // class loading, JIT
        val before = bean.currentThreadAllocatedBytes
        val ans = decodePrograms(ByteArrayInputStream(programsBytes), ServerKind.EMBY, false) { rows[it] ?: it }
        val used = bean.currentThreadAllocatedBytes - before
        assertEquals(programItems.size, ans.programs.size)
        println("decodePrograms: ${programsBytes.size} B JSON, ${ans.programs.size} programmes, $used B allocated")
        // Total allocation bounds the peak from above.
        assertTrue("allocated $used B", used < 4L * 1024 * 1024)
    }

    // ---- Failures, retry rule, clock ----

    @Test
    fun timeoutIsClassifiedAndNotRetryable() = runBlocking {
        programsMode = "slow"
        val api = api().apply { tileDeadlineMs = 300 }
        try {
            api.programsTile(listOf("ltc-001"), from, to, false)
            fail("no timeout")
        } catch (e: LiveApiException) {
            assertEquals(LiveApiException.Fail.TIMEOUT, e.fail)
            assertFalse(e.retryable)
        }
        programsMode = "503"
        try {
            api.programsTile(listOf("ltc-001"), from, to, false)
            fail("no error")
        } catch (e: LiveApiException) {
            assertEquals(LiveApiException.Fail.HTTP, e.fail)
            assertEquals(503, e.status)
            assertTrue(e.retryable)
        }
    }

    @Test
    fun clockSkewAfterThreeAnswers() = runBlocking {
        skewMs = 10 * 60_000L
        val api = api()
        api.timers()
        api.timers()
        assertEquals(0L, api.clockSkewMs.value)
        api.timers()
        assertTrue(kotlin.math.abs(api.clockSkewMs.value - skewMs) < 5_000)
        assertTrue(kotlin.math.abs(api.now() - (System.currentTimeMillis() + skewMs)) < 5_000)
    }

    // ---- Repository ----

    private fun repo(api: LiveTvApi = api(), cacheClock: () -> Long = api::now): LiveTvRepository {
        val tuning = PlatformTuning.TV_LOW
        val cache = GuideCache(dir, tuning, cacheClock, scope)
        val prefs = LivePrefs({ api.displayPrefs() }, { api.saveDisplayPrefs(it) }, scope)
        return LiveTvRepository(api, cache, prefs, tuning, scope).also { it.open() }
    }

    private fun view(rows: List<String>) = Viewport(rows, 0, 9, from, from + SLAB_MS, PlatformTuning.TV_LOW)

    /** Waits until no programmes request arrived for [quietMs]. */
    private suspend fun settle(quietMs: Long = 400) = withTimeout(30_000) {
        var last = -1
        while (true) {
            val n = programsCalls.get()
            if (n == last) break
            last = n
            delay(quietMs)
        }
    }

    @Test
    fun repositoryLoadsChannelsAndTiles() = runBlocking {
        val r = repo()
        withTimeout(5_000) { while (r.channelsLoad.value != ChannelsLoad.READY || r.rows.value.size < 25) delay(10) }
        assertEquals(2, withTimeout(5_000) { while (r.caps.value.tunerCount == null) delay(10); r.caps.value.tunerCount })
        r.gate.setSelected(true)
        r.setViewport(view(r.rows.value.map { it.id }))
        settle()
        assertTrue(programsCalls.get() > 0)
        val first = r.rows.value.first()
        val progs = r.programs(first.id, from, from + SLAB_MS)
        assertTrue(progs.isNotEmpty())
        assertSame("canonical id", first.id, progs.first().channelId)
        assertEquals(Tri.TRUE, r.caps.value.hdFlag) // the mock sends IsHD
    }

    @Test
    fun lensChangeIsServedFromTheCache() = runBlocking {
        val lens1 = channelIds
        val lens2 = channelIds.take(10).reversed() + channelIds.drop(10) // same rows, another order
        val r1 = repo()
        r1.setViewport(view(lens1))
        settle()
        val afterFirst = programsCalls.get()
        assertTrue(afterFirst > 0)
        // Same repository, other lens order: memory hits.
        r1.setViewport(view(lens2))
        settle()
        assertEquals(afterFirst, programsCalls.get())
        r1.cache.flush()
        // A new repository (cold memory) on the same folder: bucket files hit. Its startup purge runs at
        // the fixture's time, else the 15:00Z slab counts as ended > 6 h ago once the wall clock passes 00:00Z.
        val r2 = repo(cacheClock = { from + 3_600_000L })
        r2.setViewport(view(lens2))
        settle()
        assertEquals(afterFirst, programsCalls.get())
        withTimeout(5_000) { while (r2.programs(lens2[0], from, from + SLAB_MS).isEmpty()) delay(10) }
    }

    @Test
    fun tilesRetryOnceOn5xxOnly() = runBlocking {
        programsMode = "503"
        val r = repo()
        r.setViewport(view(channelIds))
        settle(RETRY_DELAY_MS + 1_000)
        val counts = programKeys.groupingBy { it }.eachCount()
        assertTrue(counts.isNotEmpty())
        assertTrue("each tile sent twice: $counts", counts.values.all { it == 2 })
        withTimeout(5_000) { while (!r.rowFailed(channelIds[0], from, from + SLAB_MS)) delay(10) }
    }

    @Test
    fun tilesAreNotRetriedOnTimeout() = runBlocking {
        programsMode = "slow"
        val api = api().apply { tileDeadlineMs = 300 }
        val r = repo(api)
        r.setViewport(view(channelIds))
        withTimeout(10_000) { while (!r.rowFailed(channelIds[0], from, from + SLAB_MS)) delay(10) }
        delay(2_500) // past the 2 s retry delay
        val counts = programKeys.groupingBy { it }.eachCount()
        assertTrue("each tile sent once: $counts", counts.values.all { it == 1 })
        // "Réessayer" sends it again.
        programsMode = "ok"
        r.retryRow(channelIds[0])
        withTimeout(10_000) { while (r.rowFailed(channelIds[0], from, from + SLAB_MS)) delay(10) }
    }

    @Test
    fun favoriteIsRefusedUntilChannelsCameFromTheServer() = runBlocking {
        val r = repo()
        withTimeout(5_000) { while (r.channelsLoad.value != ChannelsLoad.READY || r.prefs.load.value != PrefsLoad.OK) delay(10) }
        val id = channelIds[3]
        val was = r.channels.value.first { it.id == id }.favorite
        assertTrue(r.setFavorite(id, !was))
        assertEquals(!was, r.channels.value.first { it.id == id }.favorite)
    }
}
