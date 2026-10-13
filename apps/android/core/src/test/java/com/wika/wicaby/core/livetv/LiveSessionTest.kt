package com.wika.wicaby.core.livetv

import com.wika.wicaby.core.data.MediaStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// C-2 (spec §17.5): LiveSession and LiveTuner against a fake server that keeps a tuner pool the way
// MK-1 does (open streams, releases by Close or Stopped, double releases), with short timeouts.
class LiveSessionTest {
    private val fast = LiveTiming(tuneTimeoutMs = 300, firstFrameMs = 300, stallMs = 100, pauseReleaseMs = 100, closeRetryMs = 10, sweepMs = 500)

    /** MK-1 in miniature. */
    class FakeServer(var tuners: Int = 2) : LiveApi {
        override val kind = ServerKind.EMBY
        override val userId = "u"
        override val deviceId = "dev"
        val open = linkedMapOf<String, String>() // LiveStreamId → channel
        val requests = mutableListOf<Req>()
        var doubleReleases = 0
        var closes = 0
        var stopReleases = 0
        var lateAnswers = 0
        var killed = 0
        var pbiDelayMs = 0L
        var stopDelayMs = 0L
        var killStatus = 204
        /** A media source for a channel at a rung (no LiveStreamId: the server adds it). */
        var source: (String, Int) -> String = { _, _ -> """"Id":"ms","Container":"ts","SupportsDirectPlay":true,"SupportsDirectStream":true,"MediaStreams":[{"Index":0,"Type":"Video"},{"Index":1,"Type":"Audio","Language":"fre"},{"Index":2,"Type":"Audio","Language":"eng"}]""" }
        private var n = 0

        fun count(path: String) = requests.count { it.path.endsWith(path) }

        override suspend fun request(r: Req): String {
            requests += r
            when {
                r.path.endsWith("/PlaybackInfo") -> {
                    val ch = r.path.split('/')[2]
                    if (open.size >= tuners) throw LiveHttpException(500, "No tuners available")
                    val id = "ls${++n}"
                    open[id] = ch // the server opens it whether or not the client still waits
                    val rung = if (r.query["AutoOpenLiveStream"] == "true" && (r.body as JsonObject)["EnableDirectPlay"]!!.jsonPrimitive.content == "false") {
                        if ((r.body as JsonObject).containsKey("AllowVideoStreamCopy")) 2 else 1
                    } else 0
                    if (pbiDelayMs > 0) {
                        delay(pbiDelayMs)
                        lateAnswers++
                    }
                    return """{"PlaySessionId":"ps$n","MediaSources":[{${source(ch, rung)},"LiveStreamId":"$id"}]}"""
                }
                r.path == "/LiveStreams/Close" -> {
                    assertNull("Close carries no body", r.body)
                    assertNotNull("Close has PlaySessionId (Emby)", r.query["PlaySessionId"])
                    if (open.remove(r.query["LiveStreamId"]) == null) {
                        doubleReleases++
                        throw LiveHttpException(404, "")
                    }
                    closes++
                    return ""
                }
                r.path == "/Sessions/Playing/Stopped" -> {
                    if (stopDelayMs > 0) delay(stopDelayMs)
                    val id = (r.body as JsonObject)["LiveStreamId"]?.jsonPrimitive?.content
                    if (open.remove(id) == null) doubleReleases++ else stopReleases++
                    return ""
                }
                r.path == "/Videos/ActiveEncodings" -> {
                    if (killStatus >= 400) throw LiveHttpException(killStatus, "")
                    killed++
                    return ""
                }
                else -> return ""
            }
        }

        override fun url(r: Req) = r.toUrl()
        override fun resolve(u: String) = u
    }

    /** The player: [frame] decides what a load does (true: first frame after 20 ms; false: an error). */
    class FakePort(private val scope: CoroutineScope) : LivePort {
        var tuner: LiveTuner? = null
        val loads = mutableListOf<String>()
        var stops = 0
        var frame: (String) -> Boolean = { true }
        override var playWhenReady = true
        override var buffering = false

        override fun attach(t: LiveTuner?) {
            tuner = t
        }

        override fun load(url: String, hls: Boolean, title: String) {
            loads += url
            playWhenReady = true
            val ok = frame(url)
            scope.launch {
                delay(20)
                if (ok) tuner?.onFirstFrame() else tuner?.onError("ERROR_CODE_IO_BAD_HTTP_STATUS", 404)
            }
        }

        override fun stop() {
            stops++
        }
    }

    class Host : LiveHost {
        var state: LiveState? = null
        var reportingTo: LiveOpen? = null
        var failure: String? = null
        override var streams: List<MediaStream> = emptyList()
        override var audioIndex: Int? = null
        override var subtitleIndex: Int? = null

        override fun loading(open: LiveOpen, audio: Int?, subtitle: Int?) {
            streams = open.source.ms.mediaStreams
            audioIndex = audio
            subtitleIndex = subtitle
        }

        override fun reporting(open: LiveOpen?, channel: ZapEntry) {
            reportingTo = open
        }

        override fun failed(message: String, cause: Throwable?) {
            failure = message
        }

        override fun state(s: LiveState?) {
            state = s
        }
    }

    private class Rig(scope: CoroutineScope, timing: LiveTiming, val server: FakeServer = FakeServer()) {
        val session = LiveSession(scope, timing = timing)
        val port = FakePort(scope)
        val host = Host()
        val tuner = LiveTuner(session, server, "srv", port, host, scope, 20_000_000, { null }, str = { id, arg -> "s$id${arg ?: ""}" })
    }

    private fun ch(id: String) = ZapEntry(id, id, "Chaîne $id")

    private suspend fun idle(ms: Long = 150) = delay(ms)

    private fun ledgerClean(r: Rig) {
        assertEquals("doubleReleases", 0, r.server.doubleReleases)
        assertEquals("doubleReleaseAttempts", 0, r.session.snapshot().counters["doubleReleaseAttempts"])
    }

    @Test
    fun zapIsMakeBeforeBreakAndReleasesOnce() = runBlocking {
        val r = Rig(this, fast)
        r.tuner.tune(ch("a")).join()
        assertEquals(listOf("a"), r.server.open.values.toList())
        r.tuner.tune(ch("b")).join()
        idle()
        // a released by its Stopped report after b's first frame; b open; Playing reports carry the id.
        assertEquals(listOf("b"), r.server.open.values.toList())
        assertEquals(1, r.server.stopReleases)
        assertTrue(r.server.requests.filter { it.path == "/Sessions/Playing" }.all { (it.body as JsonObject).containsKey("LiveStreamId") })
        assertEquals("a", r.host.state?.lastChannelId)
        r.tuner.stop()
        idle()
        assertTrue(r.server.open.isEmpty())
        ledgerClean(r)
    }

    @Test
    fun supersedeClosesTheAnswerOfTheTuneLeft() = runBlocking {
        // Every superseded request still opens a stream on the server: a pool large enough for all.
        val r = Rig(this, fast, FakeServer(tuners = 100))
        r.server.pbiDelayMs = 100
        // 20 rapid tunes: one adopted, every other answer closed, never a Stopped for them (S10).
        repeat(20) { r.tuner.tune(ch("c$it")) }
        delay(400)
        idle()
        assertEquals(listOf("c19"), r.server.open.values.toList())
        assertEquals(0, r.server.stopReleases)
        assertEquals(19, r.server.closes)
        assertEquals(1, r.server.count("/Sessions/Playing"))
        r.tuner.stop()
        idle()
        assertTrue(r.server.open.isEmpty())
        ledgerClean(r)
    }

    @Test
    fun lateAnswerIsClosedOnArrival() = runBlocking {
        val r = Rig(this, fast)
        r.server.pbiDelayMs = 500 // past the 300 ms tune deadline (S16)
        r.tuner.tune(ch("a")).join()
        assertEquals("s${com.wika.wicaby.core.R.string.errors_livetv_tune_timeout}", r.host.failure)
        assertEquals(1, r.session.snapshot().counters["timeouts"])
        delay(400)
        assertEquals(1, r.session.snapshot().counters["late"])
        assertTrue("the late stream is closed", r.server.open.isEmpty())
        assertEquals(1, r.server.closes)
        ledgerClean(r)
    }

    @Test
    fun busyReleasesTheCurrentChannelThenLearnsBreakBeforeMake() = runBlocking {
        val r = Rig(this, fast, FakeServer(tuners = 1))
        r.tuner.tune(ch("a")).join()
        assertEquals(ZapPolicy.MBB, r.session.policy("srv"))
        r.tuner.tune(ch("b")).join()
        idle()
        // Busy → a released → retry succeeds; the notice once; policy now BBM (S15).
        assertEquals(listOf("b"), r.server.open.values.toList())
        assertEquals(ZapPolicy.BBM, r.session.policy("srv"))
        assertEquals("s${com.wika.wicaby.core.R.string.player_live_tuner_released}", r.host.state?.notice)
        val pbis = r.server.count("/PlaybackInfo")
        r.tuner.tune(ch("c")).join()
        idle()
        // Next zap: released first, a single PlaybackInfo.
        assertEquals(pbis + 1, r.server.count("/PlaybackInfo"))
        assertEquals(listOf("c"), r.server.open.values.toList())
        r.tuner.stop()
        idle()
        assertTrue(r.server.open.isEmpty())
        ledgerClean(r)
    }

    @Test
    fun ladderClosesEachFailedRungAndRestoresThePreviousChannel() = runBlocking {
        val r = Rig(this, fast)
        r.tuner.tune(ch("a")).join()
        val aUrl = r.port.loads.last()
        r.port.frame = { !it.contains("/x/") }
        r.tuner.tune(ch("x")).join()
        idle()
        // Three rungs tried and closed; the previous channel reloaded and still adopted (S18).
        assertEquals(3, r.server.count("/Items/x/PlaybackInfo"))
        assertEquals(3, r.server.closes)
        assertEquals(aUrl, r.port.loads.last())
        assertEquals(listOf("a"), r.server.open.values.toList())
        assertEquals("s${com.wika.wicaby.core.R.string.player_live_zap_failed}Chaîne x", r.host.state?.notice)
        assertEquals("a", r.host.state?.channel?.id)
        assertNotNull(r.tuner.adopted)
        r.tuner.stop()
        idle()
        assertTrue(r.server.open.isEmpty())
        ledgerClean(r)
    }

    @Test
    fun ladderEndsOnTheRungThatPlays() = runBlocking {
        val r = Rig(this, fast)
        r.server.source = { _, rung ->
            if (rung == 2) """"Id":"ms","Container":"ts","TranscodingUrl":"/videos/x/master.m3u8?videocodec=h264","TranscodingSubProtocol":"hls""""
            else """"Id":"ms","Container":"ts","SupportsDirectPlay":true"""
        }
        r.port.frame = { it.endsWith("h264") }
        r.tuner.tune(ch("x")).join()
        val open = r.tuner.adopted!!
        assertEquals(2, open.rung)
        assertEquals(Dialect.PlayMethod.Transcode, open.playMethod)
        assertTrue(open.isHls)
        assertEquals(2, r.server.closes)
        r.tuner.stop()
        idle()
        // The transcode's encodings are killed after its Stopped report.
        assertEquals(1, r.server.killed)
        assertTrue(r.server.open.isEmpty())
        ledgerClean(r)
    }

    @Test
    fun directStreamOnlySourcePlaysTheStaticUrl() = runBlocking {
        val r = Rig(this, fast)
        r.server.source = { _, _ -> """"Id":"ms","Container":"mpegts","SupportsDirectPlay":false,"SupportsDirectStream":true""" }
        r.tuner.tune(ch("h")).join()
        val open = r.tuner.adopted!!
        // S17: no noPlayMethod; static URL with the LiveStreamId; PlayMethod DirectStream in the reports.
        assertEquals(Dialect.PlayMethod.DirectStream, open.playMethod)
        val url = r.port.loads.single()
        assertTrue(url, url.startsWith("/Videos/h/stream.mpegts?Static=true&MediaSourceId=ms&LiveStreamId=ls1&DeviceId=dev&PlaySessionId=ps1"))
        val playing = r.server.requests.single { it.path == "/Sessions/Playing" }.body as JsonObject
        assertEquals("DirectStream", playing["PlayMethod"]!!.jsonPrimitive.content)
        r.tuner.stop()
        idle()
        ledgerClean(r)
    }

    @Test
    fun requiresOpeningCallsOpenWithTheIdsInQueryAndBody() = runBlocking {
        val server = object : LiveApi by FakeServer() {
            val inner = FakeServer()
            override suspend fun request(r: Req): String = when (r.path) {
                "/LiveStreams/Open" -> {
                    assertEquals("ps1", r.query["PlaySessionId"])
                    assertEquals("ps1", (r.body as JsonObject)["PlaySessionId"]!!.jsonPrimitive.content)
                    """{"MediaSource":{"Id":"ms","Container":"ts","SupportsDirectPlay":true,"LiveStreamId":"opened1"}}"""
                }
                else -> inner.request(r).replace(""","LiveStreamId":"ls1"""", ""","RequiresOpening":true,"OpenToken":"tok"""")
            }
        }
        val session = LiveSession(this, timing = fast)
        val port = FakePort(this)
        val tuner = LiveTuner(session, server, "srv", port, Host(), this, 1, { null }, str = { _, _ -> "" })
        tuner.tune(ch("o")).join()
        assertEquals("opened1", tuner.adopted?.liveStreamId)
        assertTrue(port.loads.single().contains("LiveStreamId=opened1"))
        tuner.stop()
        idle()
        assertTrue(session.snapshot().open.isEmpty())
    }

    @Test
    fun pauseReleasesTheTunerAndPlayTunesAgain() = runBlocking {
        val r = Rig(this, fast)
        r.tuner.tune(ch("a")).join()
        r.port.playWhenReady = false
        r.tuner.onStateChanged()
        delay(200)
        // S20: Stopped report after the pause delay; openStreams 0, "Reprendre le direct".
        assertTrue(r.server.open.isEmpty())
        assertEquals(1, r.server.stopReleases)
        assertEquals(1, r.port.stops)
        assertTrue(r.host.state!!.pausedReleased)
        assertNull(r.host.reportingTo)
        r.port.playWhenReady = true
        r.tuner.onStateChanged()
        idle()
        assertEquals(listOf("a"), r.server.open.values.toList())
        assertFalse(r.host.state!!.pausedReleased)
        r.tuner.stop()
        idle()
        assertTrue(r.server.open.isEmpty())
        ledgerClean(r)
    }

    @Test
    fun stallRetunesOneRungLower() = runBlocking {
        val r = Rig(this, fast)
        r.tuner.tune(ch("a")).join()
        assertEquals(0, r.tuner.adopted!!.rung)
        r.port.buffering = true
        r.tuner.onStateChanged()
        r.port.buffering = false
        delay(300)
        // S19: the stalled stream released, the channel re-tuned at rung 1.
        assertEquals(1, r.tuner.adopted?.rung)
        assertEquals(1, r.server.stopReleases)
        assertEquals(1, r.server.open.size)
        r.tuner.stop()
        idle()
        ledgerClean(r)
    }

    @Test
    fun audioLanguageCarriesOverBetweenChannels() = runBlocking {
        val r = Rig(this, fast)
        r.tuner.tune(ch("a")).join()
        r.host.audioIndex = 2 // the user picked "eng"
        r.tuner.tune(ch("b")).join()
        assertEquals(2, r.host.audioIndex)
        r.tuner.stop()
        idle()
    }

    @Test
    fun inBandCaptionWithoutLanguageCarriesOverByCodec() = runBlocking {
        val r = Rig(this, fast)
        r.server.source = { ch, _ ->
            val subs = if (ch == "a") {
                """,{"Index":3,"Type":"Subtitle","Codec":"eia_608"}"""
            } else {
                """,{"Index":4,"Type":"Subtitle","Codec":"dvbsub","Language":"fre"},{"Index":5,"Type":"Subtitle","Codec":"eia_608"}"""
            }
            """"Id":"ms","Container":"ts","SupportsDirectPlay":true,"MediaStreams":[{"Index":0,"Type":"Video"}$subs]"""
        }
        r.tuner.tune(ch("a")).join()
        r.host.subtitleIndex = 3 // the user turned the in-band CC on
        r.tuner.tune(ch("b")).join()
        assertEquals(5, r.host.subtitleIndex)
        r.host.subtitleIndex = -1 // then off
        r.tuner.tune(ch("a")).join()
        assertEquals(-1, r.host.subtitleIndex)
        r.tuner.stop()
        idle()
    }

    @Test
    fun stopSweepsOnlyItsOwnStreams() = runBlocking {
        // Mobile: the old screen's Stopped report is still out when the new screen tunes.
        val server = FakeServer()
        val session = LiveSession(this, timing = fast)
        fun tuner() = LiveTuner(session, server, "srv", FakePort(this), Host(), this, 1, { null }, str = { _, _ -> "" })
        val a = tuner()
        a.tune(ch("a")).join()
        server.stopDelayMs = 200
        a.stop()
        val b = tuner()
        b.tune(ch("b")).join()
        delay(500)
        assertEquals(listOf("b"), server.open.values.toList())
        assertTrue(session.isOpen(b.adopted?.liveStreamId))
        assertEquals(0, server.closes)
        server.stopDelayMs = 0
        b.stop()
        idle()
        assertTrue(server.open.isEmpty())
        assertEquals(0, server.doubleReleases)
    }

    @Test
    fun streamsLeftByADeadProcessAreClosedOnTheNextTune() = runBlocking {
        val server = FakeServer(tuners = 1)
        val store = MemoryOpenStreams()
        val dead = LiveSession(this, timing = fast, openStore = store)
        LiveTuner(dead, server, "srv", FakePort(this), Host(), this, 1, { null }, str = { _, _ -> "" }).tune(ch("a")).join()
        assertEquals(1, store.lines.size) // the process dies here: no Stopped report, no sweep
        val session = LiveSession(this, timing = fast, openStore = store)
        val t = LiveTuner(session, server, "srv", FakePort(this), Host(), this, 1, { null }, str = { _, _ -> "" })
        t.tune(ch("b")).join()
        // Closed before the PlaybackInfo, so the one tuner is free: no busy round.
        assertEquals(listOf("b"), server.open.values.toList())
        assertEquals(1, server.closes)
        assertEquals(1, session.snapshot().counters["orphans"])
        assertEquals(0, session.snapshot().counters["busy"])
        t.stop()
        idle()
        assertTrue(store.lines.isEmpty())
        assertEquals(0, server.doubleReleases)
    }

    @Test
    fun killEncodesStopsAfterOne404() = runBlocking {
        val server = FakeServer().apply { killStatus = 404 }
        val session = LiveSession(this, timing = fast)
        val tuneOnce: suspend () -> Unit = {
            val tuner = LiveTuner(session, server, "srv", FakePort(this), Host(), this, 1, { null }, str = { _, _ -> "" })
            server.source = { _, _ -> """"Id":"ms","TranscodingUrl":"/t.m3u8?videocodec=h264"""" }
            tuner.tune(ch("t")).join()
            tuner.stop()
            idle()
        }
        tuneOnce()
        tuneOnce()
        assertEquals(1, server.count("/Videos/ActiveEncodings"))
        assertEquals(setOf("srv"), session.snapshot().killEncodesOff)
    }

    @Test
    fun busyClassification() {
        assertTrue(isBusyHttp(500, "No tuners available"))
        assertTrue(isBusyHttp(409, "Tuner is busy"))
        assertFalse(isBusyHttp(500, "Error opening the tuner stream"))
        assertFalse(isBusyHttp(404, "No tuners available"))
        assertEquals(AnswerClass.BUSY, classifyAnswer(LiveInfo(emptyList(), null, "NoCompatibleStream"), false))
        assertEquals(AnswerClass.REFUSED, classifyAnswer(LiveInfo(emptyList(), null, "NotAllowed"), false))
        assertEquals(AnswerClass.BUSY, classifyAnswer(LiveInfo(emptyList(), "p", null), true))
        assertEquals(AnswerClass.EMPTY, classifyAnswer(LiveInfo(emptyList(), "p", null), false))
        assertTrue(isBusyStream(503, 1_000))
        assertFalse(isBusyStream(503, 4_000))
    }
}
