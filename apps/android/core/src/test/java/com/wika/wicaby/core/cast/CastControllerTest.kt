package com.wika.wicaby.core.cast

import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.json
import com.wika.wicaby.core.net.ServerTransport
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.player.SessionReporter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.kxml2.io.KXmlParser
import java.util.concurrent.CopyOnWriteArrayList

// cast/CastController (cast spec CA-08 checks) with mockwebserver3 as both the server and the renderer: the handoff,
// the token in the stream URL per server, progress reports as this device's own session, end of media, losing the
// device, a transcode seek (StartTimeTicks + RelTime), the LAN-only refusal, and §8.4: reports in order on one DeviceId
// (local Stopped before the cast's Playing, an old cast's before a new one's) and no direct cast of live recordings.
class CastControllerTest {
    private lateinit var server: MockWebServer
    private lateinit var tv: MockWebServer
    private val reports = CopyOnWriteArrayList<RecordedRequest>()
    private val soap = CopyOnWriteArrayList<RecordedRequest>()
    private val infos = CopyOnWriteArrayList<RecordedRequest>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // Renderer state, as mock-dlna.mjs keeps it.
    @Volatile private var state = "NO_MEDIA_PRESENT"
    @Volatile private var relTime = "00:00:00"
    @Volatile private var uri = ""
    @Volatile private var down = false
    @Volatile private var transcode = false
    // /LiveTv/Recordings?IsInProgress=true, null for a server without Live TV (404).
    @Volatile private var recording: String? = null
    // When the server finished answering the slow Stopped (ns), and when each Playing arrived.
    @Volatile private var stoppedDone = 0L
    private val playingAt = CopyOnWriteArrayList<Long>()
    private val recordingQueries = CopyOnWriteArrayList<RecordedRequest>()

    // CK/fixtures/cast/, copied onto the test classpath by :core's copyCastFixtures (processTestResources).
    private fun fx(name: String) = javaClass.getResource("/cast/$name")!!.readText()

    private val item = """{"Id":"m1","Name":"Film","Type":"Movie","MediaType":"Video","RunTimeTicks":${7_200_000L * TICKS_PER_MS}}"""

    private fun song(id: String, n: Int) =
        """{"Id":"$id","Name":"Song $n","Type":"Audio","MediaType":"Audio","Album":"Album & Co","AlbumId":"al1","AlbumPrimaryImageTag":"p","Artists":["Artist"],"IndexNumber":$n,"RunTimeTicks":${180_000L * TICKS_PER_MS}}"""

    private fun info() = if (transcode) {
        """{"PlaySessionId":"ps-${infos.size - 1}","MediaSources":[{"Id":"src1","Container":"mkv","SupportsDirectPlay":false,"SupportsTranscoding":true,""" +
            """"TranscodingUrl":"/videos/m1/stream.ts?MediaSourceId=src1&ApiKey=old&PlaySessionId=ps-${infos.size - 1}","MediaStreams":[]}]}"""
    } else {
        """{"PlaySessionId":"ps-${infos.size - 1}","MediaSources":[{"Id":"src1","Container":"mov,mp4,m4a","SupportsDirectPlay":true,"DefaultAudioStreamIndex":1,""" +
            """"MediaStreams":[{"Index":3,"Type":"Subtitle","Codec":"srt","DeliveryMethod":"External","DeliveryUrl":"/Videos/m1/src1/Subtitles/3/0/Stream.srt?api_key=x"}]}]}"""
    }

    private fun soapReply(action: String, values: String = "") = MockResponse.Builder().body(
        """<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">$values</u:${action}Response></s:Body></s:Envelope>""",
    ).build()

    @Volatile private var qc = false
    private val logouts = CopyOnWriteArrayList<RecordedRequest>()

    @Before
    fun setUp() {
        newXmlParser = { KXmlParser() }
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                return when {
                    // CA-11: Quick Connect only when a test turns it on (else 404: the user token).
                    qc && path.startsWith("/QuickConnect/") -> MockResponse.Builder().body(if (path.endsWith("/Initiate")) """{"Code":"1","Secret":"s"}""" else "true").build()
                    qc && path == "/Users/AuthenticateWithQuickConnect" -> MockResponse.Builder().body("""{"AccessToken":"cast-token"}""").build()
                    path == "/Sessions/Logout" -> { logouts += request; MockResponse.Builder().code(204).build() }
                    path.endsWith("/PlaybackInfo") -> { infos += request; MockResponse.Builder().body(info()).build() }
                    path.contains("/Items/m1") -> MockResponse.Builder().body(item).build()
                    path.contains("/Items/s1") -> MockResponse.Builder().body(song("s1", 1)).build()
                    path.contains("/Items/s2") -> MockResponse.Builder().body(song("s2", 2)).build()
                    path.endsWith("/LiveTv/Recordings") -> {
                        recordingQueries += request
                        recording?.let { MockResponse.Builder().body("""{"Items":[{"Id":"$it","Type":"Movie"}],"TotalRecordCount":1}""").build() }
                            ?: MockResponse.Builder().code(404).build()
                    }
                    path.contains("/Sessions/Playing") -> {
                        reports += request
                        if (path.endsWith("/Sessions/Playing")) playingAt += System.nanoTime()
                        // A local session's slow Stopped: whatever reports next must wait for it.
                        if (path.endsWith("/Stopped") && request.body?.utf8()?.contains("\"local\"") == true) {
                            Thread.sleep(300)
                            stoppedDone = System.nanoTime()
                        }
                        MockResponse.Builder().code(204).build()
                    }
                    else -> MockResponse.Builder().code(404).build()
                }
            }
        }
        server.start()
        tv = MockWebServer()
        tv.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "GET") return MockResponse.Builder().body(fx("dlna-desc-sony.xml")).build()
                if (down) return MockResponse.Builder().code(503).build()
                soap += request
                val action = request.headers["SOAPACTION"].orEmpty().substringAfter('#').trim('"')
                val body = request.body?.utf8().orEmpty()
                return when (action) {
                    "GetProtocolInfo" -> MockResponse.Builder().body(fx("dlna-protocolinfo-sony.xml")).build()
                    "GetTransportInfo" -> soapReply(action, "<CurrentTransportState>$state</CurrentTransportState>")
                    "GetPositionInfo" -> soapReply(action, "<TrackURI>${Dlna.escape(uri)}</TrackURI><RelTime>$relTime</RelTime>")
                    "SetAVTransportURI" -> {
                        uri = Regex("<CurrentURI>(.*?)</CurrentURI>").find(body)!!.groupValues[1].replace("&amp;", "&")
                        state = "STOPPED"
                        soapReply(action)
                    }
                    "Play" -> { state = "PLAYING"; soapReply(action) }
                    "Pause" -> { state = "PAUSED_PLAYBACK"; soapReply(action) }
                    "Stop" -> { state = "STOPPED"; soapReply(action) }
                    "GetVolume" -> soapReply(action, "<CurrentVolume>20</CurrentVolume>")
                    "GetMute" -> soapReply(action, "<CurrentMute>0</CurrentMute>")
                    else -> soapReply(action)
                }
            }
        }
        tv.start()
    }

    @After
    fun tearDown() {
        scope.cancel()
        server.close()
        tv.close()
        Core.transport = ServerTransport.Direct
    }

    private fun api(kind: String) = Api(Server("srv1", "NAS", server.url("/").toString().trimEnd('/'), kind), "phone", "user-token", "u1")

    // The disposable tokens' store (Prefs on a device).
    @Volatile private var stored = ""

    private fun controller(api: Api, lan: Boolean = true, beforePlaying: suspend () -> Unit = {}): Pair<CastController, CastTarget> {
        val r = runBlocking { DlnaClient().describe(tv.url("/desc.xml").toString())!! }
        val c = CastController(
            api, DlnaDevice(r), scope = scope, lanBase = { if (lan) server.url("/").toString().toHttpUrl() else null },
            fastPollMs = 40, slowPollMs = 40, reportMs = 200, pingMs = 100_000, startWaitMs = 1_000, beforePlaying = beforePlaying,
            tokens = EphemeralTokens(load = { stored }, save = { stored = it }),
        )
        return c to r.target()
    }

    private fun actions() = soap.map { it.headers["SOAPACTION"].orEmpty().substringAfter('#').trim('"') }
    private fun body(r: RecordedRequest): JsonObject = json.parseToJsonElement(r.body!!.utf8()).jsonObject

    private suspend fun until(what: String, ok: () -> Boolean) {
        try {
            withTimeout(5_000) { while (!ok()) delay(20) }
        } catch (_: Exception) {
            fail("timed out waiting for $what")
        }
    }

    // The end's Stopped is queued behind other reports: await the server's answer (it recorded the request first).
    private suspend fun stopReported(c: CastController) = assertTrue(withTimeout(5_000) { c.stopReport!!.await() })

    @Test
    fun handoffReportsAndEnd() = runBlocking {
        val (c, t) = controller(api("jellyfin"))
        c.play(t, listOf("m1"), positionTicks = 600_000 * TICKS_PER_MS, sub = 3)
        assertTrue(c.awaitPlaying(t, "m1"))

        // The renderer's PlaybackInfo: its own DLNA profile (Sony, from the Sink) and the handoff position.
        val pi = body(infos.single())
        assertEquals("Wicaby DLNA (BRAVIA (mock profile))", pi.getValue("DeviceProfile").jsonObject.getValue("Name").jsonPrimitive.content)
        assertEquals(600_000 * TICKS_PER_MS, pi.getValue("StartTimeTicks").jsonPrimitive.long)
        assertEquals(40_000_000L, pi.getValue("MaxStreamingBitrate").jsonPrimitive.long)

        // A static stream on the LAN origin with ApiKey (Jellyfin), then a seek to the handoff position.
        val url = uri.toHttpUrl()
        assertEquals("/Videos/m1/stream.mp4", url.encodedPath)
        assertEquals("user-token", url.queryParameter("ApiKey"))
        assertNull(url.queryParameter("api_key"))
        assertEquals("true", url.queryParameter("Static"))
        assertEquals("ps-0", url.queryParameter("PlaySessionId"))
        val set = soap.first { it.headers["SOAPACTION"]!!.contains("SetAVTransportURI") }.body!!.utf8()
        // The token sits only in the URLs, never in the title; the subtitle got the right key too.
        assertTrue(set.contains("/Videos/m1/src1/Subtitles/3/0/Stream.srt?ApiKey=user-token"))
        assertFalse(set.contains("api_key"))
        assertEquals(listOf("GetProtocolInfo", "GetTransportInfo", "SetAVTransportURI", "Play", "GetTransportInfo", "Seek"), actions().take(6))
        assertTrue(soap.none { it.headers["Authorization"] != null || it.headers["X-Emby-Authorization"] != null })

        // Reported as this device's own session: Playing at once, then Progress with the cast's PlaySessionId.
        until("playing report") { reports.any { it.url.encodedPath == "/Sessions/Playing" } }
        val playing = body(reports.first { it.url.encodedPath == "/Sessions/Playing" })
        assertEquals("ps-0", playing.getValue("PlaySessionId").jsonPrimitive.content)
        assertEquals("DirectPlay", playing.getValue("PlayMethod").jsonPrimitive.content)
        assertEquals(0, playing.getValue("QueueableMediaTypes").jsonArray.size)
        assertEquals("src1", playing.getValue("MediaSourceId").jsonPrimitive.content)
        relTime = "00:10:05"
        until("progress") { reports.any { it.url.encodedPath == "/Sessions/Playing/Progress" } }
        until("position") { c.state.value?.positionTicks == 605_000 * TICKS_PER_MS }
        val mirrored = c.mirror(t).first()
        assertEquals("m1", mirrored.itemId)
        assertEquals(20, mirrored.session!!.playState!!.volumeLevel)

        // Pause from the panel: AVTransport Pause and a Progress "Pause".
        c.transport(t, "PlayPause")
        assertEquals("PAUSED_PLAYBACK", state)
        until("pause report") { reports.any { body(it)["EventName"]?.jsonPrimitive?.content == "Pause" } }
        c.transport(t, "Unpause")

        // End of media: STOPPED after PLAYING -> Stopped with the last position, the cast is over.
        state = "STOPPED"
        until("end") { c.ended.value != null }
        assertEquals(CastController.End.Finished, c.ended.value)
        assertNull(c.state.value)
        stopReported(c)
        val stopped = reports.filter { it.url.encodedPath == "/Sessions/Playing/Stopped" }
        assertEquals(1, stopped.size)
        assertEquals(605_000 * TICKS_PER_MS, body(stopped[0]).getValue("PositionTicks").jsonPrimitive.long)
    }

    // Music: a song queue on the renderer, with its metadata and cover (no token), the next song at the end of one,
    // each its own play, next/previous from the remote panel, the end with the queue.
    @Test
    fun songQueue() = runBlocking {
        val (c, t) = controller(api("jellyfin"))
        c.play(t, listOf("s1", "s2"), startIndex = 0)
        assertTrue(c.awaitPlaying(t, "s1"))
        val set = soap.first { it.headers["SOAPACTION"]!!.contains("SetAVTransportURI") }.body!!.utf8()
        assertTrue(set, set.contains("object.item.audioItem.musicTrack"))
        assertTrue(set, set.contains("&lt;upnp:artist&gt;Artist&lt;/upnp:artist&gt;"))
        assertTrue(set, set.contains("&lt;upnp:album&gt;Album &amp;amp; Co&lt;/upnp:album&gt;"))
        val art = Regex("albumArtURI .*?JPEG_TN&quot;&gt;(.*?)&lt;/upnp:albumArtURI").find(set)!!.groupValues[1]
        assertTrue(art, art.contains("/Items/al1/Images/Primary"))
        assertFalse("no token in the cover URL: $art", art.contains("user-token"))
        assertEquals(2, c.mirror(t).first().session!!.nowPlayingQueue.size)

        // The song ends: the next one loads; Stopped for the first, Playing for the second.
        state = "STOPPED"
        until("the next song") { c.state.value?.item?.id == "s2" }
        assertNull(c.ended.value)
        val plays = { reports.filter { it.url.encodedPath != "/Sessions/Playing/Progress" }.map { it.url.encodedPath.substringAfterLast('/') + " " + body(it)["ItemId"]?.jsonPrimitive?.content } }
        until("Playing s2") { plays().contains("Playing s2") }
        assertEquals(listOf("Playing s1", "Stopped s1", "Playing s2"), plays())
        assertEquals(180_000 * TICKS_PER_MS, body(reports.first { it.url.encodedPath.endsWith("/Stopped") }).getValue("PositionTicks").jsonPrimitive.long)

        // Previous within 5 s: the song before; next: back.
        c.transport(t, "PreviousTrack")
        until("previous") { c.state.value?.item?.id == "s1" }
        c.transport(t, "NextTrack")
        until("next") { c.state.value?.item?.id == "s2" }

        // The last song ends: so does the cast.
        until("playing") { state == "PLAYING" }
        delay(100)
        state = "STOPPED"
        until("end") { c.ended.value != null }
        assertEquals(CastController.End.Finished, c.ended.value)
    }

    @Test
    fun embyGetsApiKeyLowercase() = runBlocking {
        val (c, t) = controller(api("emby"))
        c.play(t, listOf("m1"))
        val url = uri.toHttpUrl()
        assertTrue(url.encodedPath.startsWith("/emby/Videos/m1/stream."))
        assertEquals("user-token", url.queryParameter("api_key"))
        assertNull(url.queryParameter("ApiKey"))
        c.stop()
        assertEquals(CastController.End.Stopped, c.ended.value)
        assertTrue(actions().contains("Stop"))
        stopReported(c)
        assertEquals(1, reports.count { it.url.encodedPath == "/emby/Sessions/Playing/Stopped" })
    }

    // CA-11: on Jellyfin with Quick Connect the renderer gets a disposable token, never the user's; it is revoked
    // (Logout with that token) when the cast ends.
    @Test
    fun jellyfinQuickConnectGivesTheRendererADisposableToken() = runBlocking {
        qc = true
        val (c, t) = controller(api("jellyfin"))
        c.play(t, listOf("m1"), sub = 3)
        assertEquals("cast-token", uri.toHttpUrl().queryParameter("ApiKey"))
        val set = soap.first { it.headers["SOAPACTION"]!!.contains("SetAVTransportURI") }.body!!.utf8()
        assertTrue(set.contains("Stream.srt?ApiKey=cast-token"))
        assertFalse(soap.any { it.body?.utf8().orEmpty().contains("user-token") })
        assertTrue(stored.contains("cast-token"))
        c.stop()
        until("logout") { logouts.isNotEmpty() }
        assertTrue(logouts.single().headers["Authorization"]!!.contains("Token=\"cast-token\""))
        until("store emptied") { stored.isEmpty() }
    }

    // A restart (track change) keeps the cast's token; Emby never asks Quick Connect.
    @Test
    fun oneTokenPerCast() = runBlocking {
        qc = true
        val (c, t) = controller(api("jellyfin"))
        c.play(t, listOf("m1"))
        c.command(t, "SetAudioStreamIndex", mapOf("Index" to "2"))
        assertEquals("cast-token", uri.toHttpUrl().queryParameter("ApiKey"))
        assertEquals(2, infos.size)
        assertTrue(logouts.isEmpty())
        c.stop()
        until("logout") { logouts.size == 1 }
    }

    @Test
    fun lostAfterThreeFailedPolls() = runBlocking {
        val (c, t) = controller(api("jellyfin"))
        c.play(t, listOf("m1"), positionTicks = 0)
        relTime = "00:00:30"
        until("position") { c.state.value?.positionTicks == 30_000 * TICKS_PER_MS }
        down = true
        until("lost") { c.ended.value != null }
        assertEquals(CastController.End.Lost, c.ended.value)
        stopReported(c)
        val stopped = reports.single { it.url.encodedPath == "/Sessions/Playing/Stopped" }
        assertEquals(30_000 * TICKS_PER_MS, body(stopped).getValue("PositionTicks").jsonPrimitive.long)
    }

    @Test
    fun transcodeSeekRestartsAtStartTimeTicks() = runBlocking {
        transcode = true
        val (c, t) = controller(api("jellyfin"))
        c.play(t, listOf("m1"), positionTicks = 0)
        val first = uri.toHttpUrl()
        assertEquals("/videos/m1/stream.ts", first.encodedPath)
        assertEquals(listOf("user-token"), first.queryParameterValues("ApiKey"))
        assertTrue(soap.none { it.headers["SOAPACTION"]!!.endsWith("#Seek\"") })

        c.transport(t, "Seek", 1_200_000 * TICKS_PER_MS)
        // A new PlaybackInfo at StartTimeTicks, the old session Stopped, the new one Playing.
        assertEquals(1_200_000 * TICKS_PER_MS, body(infos[1]).getValue("StartTimeTicks").jsonPrimitive.long)
        assertEquals((1_200_000 * TICKS_PER_MS).toString(), uri.toHttpUrl().queryParameter("StartTimeTicks"))
        fun sessions() = reports.map { it.url.encodedPath }.filter { !it.endsWith("Progress") }
        until("new session") { sessions().size >= 3 }
        assertEquals(listOf("/Sessions/Playing", "/Sessions/Playing/Stopped", "/Sessions/Playing"), sessions())
        // The renderer counts from the start of the new stream: reported position = StartTimeTicks + RelTime.
        relTime = "00:00:07"
        until("position") { c.state.value?.positionTicks == (1_200_000 + 7_000) * TICKS_PER_MS }
        assertEquals("Transcode", body(reports.last { it.url.encodedPath == "/Sessions/Playing" }).getValue("PlayMethod").jsonPrimitive.content)
        c.stop()
    }

    @Test
    fun volumeAndTracks() = runBlocking {
        val (c, t) = controller(api("jellyfin"))
        c.play(t, listOf("m1"))
        assertTrue(c.command(t, "SetVolume", mapOf("Volume" to "250")))
        fun last(action: String) = soap.last { it.headers["SOAPACTION"]!!.endsWith("#$action\"") }.body!!.utf8()
        val sv = last("SetVolume")
        assertTrue(sv.contains("<DesiredVolume>100</DesiredVolume>") && sv.contains("<Channel>Master</Channel>"))
        assertFalse(c.command(t, "SetVolume", mapOf("Volume" to "x")))
        assertTrue(c.command(t, "Mute"))
        assertTrue(last("SetMute").contains("<DesiredMute>1</DesiredMute>"))
        assertTrue(c.state.value!!.muted)
        assertFalse(c.command(t, "DisplayMessage"))
        // An audio switch restarts the stream with the new index (§2.3).
        assertTrue(c.command(t, "SetAudioStreamIndex", mapOf("Index" to "2")))
        assertEquals(2, body(infos.last()).getValue("AudioStreamIndex").jsonPrimitive.content.toInt())
        c.stop()
    }

    @Test
    fun lanOnlySendsNothing() = runBlocking {
        val (c, t) = controller(api("jellyfin"), lan = false)
        try {
            c.play(t, listOf("m1"))
            fail("cast through the mesh")
        } catch (_: LanOnlyException) {
        }
        assertTrue(soap.isEmpty())
        assertTrue(infos.isEmpty())
    }

    @Test
    fun plexSendsNothing() = runBlocking {
        val (c, t) = controller(api("plex"))
        assertTrue(runCatching { c.play(t, listOf("m1")) }.exceptionOrNull() is java.io.IOException)
        assertTrue(soap.isEmpty())
        assertTrue(infos.isEmpty())
    }

    @Test
    fun lanBaseRules() = runBlocking {
        fun api(address: String) = Api(Server("s", "S", address, "jellyfin"), "phone", "t", "u")
        assertEquals("http://192.168.1.5:8096/", CastController.lanBase(api("http://192.168.1.5:8096/jellyfin")).toString())
        assertNull(CastController.lanBase(api("https://192.168.1.5:8920")))
        assertNull(CastController.lanBase(api("http://100.100.1.1:8096")))
        assertNull(CastController.lanBase(api("http://8.8.8.8:8096")))
        assertNull(CastController.lanBase(api("http://127.0.0.1:8096")))
        // Reached through the mesh forwarder (ServerTransport rewrites it onto 127.0.0.1:<port>/tok/).
        Core.transport = object : ServerTransport {
            override fun forward(origin: String) = "http://127.0.0.1:41234/tok"
        }
        assertNull(CastController.lanBase(api("http://192.168.1.5:8096")))
    }

    @Test
    fun localStoppedReachesServerBeforeCastPlaying() = runBlocking {
        val api = api("jellyfin")
        var localEnded = false
        // What Casting passes: local playback stops (Playback queues its Stopped) once the renderer plays.
        val (c, t) = controller(api) {
            localEnded = true
            SessionReporter(api).stopped(buildJsonObject { put("ItemId", "local") })
        }
        c.play(t, listOf("m1"))
        assertTrue(localEnded)
        until("playing report") { playingAt.isNotEmpty() }
        val paths = reports.map { it.url.encodedPath }.filter { !it.endsWith("Progress") }
        assertEquals(listOf("/Sessions/Playing/Stopped", "/Sessions/Playing"), paths)
        assertTrue("Playing sent while the local Stopped was still in flight", playingAt.first() > stoppedDone)
        c.stop()
    }

    @Test
    fun recastToSameRendererStopsOldCastFirst() = runBlocking {
        val api = api("jellyfin")
        val (old, t) = controller(api)
        old.play(t, listOf("m1"))
        // Casting.stopDirect()?.join() before the new send: the old cast's Stopped, then its Stop on the renderer.
        old.stop()
        val (cur, _) = controller(api)
        cur.play(t, listOf("m1"))
        val loads = actions().withIndex().filter { it.value == "SetAVTransportURI" }.map { it.index }
        assertTrue(actions().indexOf("Stop") in loads[0]..loads[1])
        // The old controller, already over, never tells the renderer again (it now plays the new cast).
        val n = soap.size
        old.stop()
        assertEquals(n, soap.size)
        delay(200)
        assertEquals("PLAYING", state)
        assertTrue(cur.state.value != null)
        until("reports") { reports.count { it.url.encodedPath == "/Sessions/Playing" } == 2 }
        val paths = reports.map { it.url.encodedPath }.filter { !it.endsWith("Progress") }
        assertEquals(listOf("/Sessions/Playing", "/Sessions/Playing/Stopped", "/Sessions/Playing"), paths)
        cur.stop()
    }

    @Test
    fun stoppedBeforeFirstPollEnds() = runBlocking {
        val (c, t) = controller(api("jellyfin"))
        c.play(t, listOf("m1"))
        // Stopped on the TV before the first poll: the start already saw PLAYING, so the cast ends.
        state = "STOPPED"
        until("end") { c.ended.value != null }
        assertEquals(CastController.End.Finished, c.ended.value)
    }

    @Test
    fun noDirectCastOfChannelsProgrammesOrRecordingsInProgress() = runBlocking {
        val api = api("emby")
        fun item(id: String, type: String = "Movie") = Item(id, type = type)
        assertFalse(CastController.directAllowed(api, item("c1", "TvChannel")))
        assertFalse(CastController.directAllowed(api, item("p1", "Program")))
        // No Live TV on the server: nothing is recording.
        assertTrue(CastController.directAllowed(api, item("m1")))
        recording = "rec1"
        assertFalse(CastController.directAllowed(api, item("rec1")))
        assertTrue(CastController.directAllowed(api, item("m1")))
        assertEquals(3, recordingQueries.size)
        assertTrue(recordingQueries.all { it.url.queryParameter("IsInProgress") == "true" && it.url.queryParameter("UserId") == "u1" })
    }

    // CA-10: a Cast Default Media Receiver behind the same controller (GmsDevice in mobile gplay). It gets its own
    // profile and bitrate, an Emby stream with api_key, every External subtitle (the receiver's VTT tracks) with the
    // chosen one marked, its container for the URL, and the controller reports as for DLNA.
    @Test
    fun castDeviceGetsPreparedEmbyStream() = runBlocking {
        val loads = CopyOnWriteArrayList<CastStream>()
        val device = object : CastDevice {
            @Volatile var st = "NO_MEDIA_PRESENT"
            override val target = CastTarget("c:route1", CastTarget.Kind.Cast, "Living room", "Chromecast", mediaTypes = setOf("Video"))
            override val name = "Living room"
            override val id = "cast-1"
            override val client = "Chromecast"
            override val bitrate = CastProfiles.CAST_BITRATE
            override suspend fun profile() = CastProfiles.cast("Chromecast", jellyfin = false)
            override fun container(direct: Boolean, containers: List<String>, audio: Boolean) = if (direct) "mp4" else "m3u8"
            override suspend fun load(stream: CastStream) { loads += stream; st = "PLAYING" }
            override suspend fun state() = st
            override suspend fun position() = 1_000L to loads.last().url
            override suspend fun play() { st = "PLAYING" }
            override suspend fun pause() { st = "PAUSED_PLAYBACK" }
            override suspend fun stop() { st = "STOPPED" }
            override suspend fun seek(ms: Long) = Unit
            override suspend fun volume() = 40 to false
            override suspend fun setVolume(v: Int) = Unit
            override suspend fun setMute(on: Boolean) = Unit
        }
        val c = CastController(
            api("emby"), device, scope = scope, lanBase = { server.url("/").toString().toHttpUrl() },
            fastPollMs = 40, slowPollMs = 40, reportMs = 200, pingMs = 100_000, startWaitMs = 1_000,
        )
        c.play(device.target, listOf("m1"), sub = 3)
        val pi = body(infos.single())
        assertEquals("Wicaby Cast (Chromecast)", pi.getValue("DeviceProfile").jsonObject.getValue("Name").jsonPrimitive.content)
        assertEquals(20_000_000L, pi.getValue("MaxStreamingBitrate").jsonPrimitive.long)
        val s = loads.single()
        val url = s.url.toHttpUrl()
        // Emby's API path ("/emby/Videos/…").
        assertEquals("/emby/Videos/m1/stream.mp4", url.encodedPath)
        assertEquals("user-token", url.queryParameter("api_key"))
        assertNull(url.queryParameter("ApiKey"))
        assertEquals(listOf(3), s.subtitles.map { it.index })
        assertEquals("user-token", s.subtitles.single().url.toHttpUrl().queryParameter("api_key"))
        assertEquals(3, s.subtitle)
        until("playing report") { reports.any { it.url.encodedPath == "/emby/Sessions/Playing" } }
        assertEquals("Chromecast", c.mirror(device.target).first().session?.client)
        c.stop()
        assertEquals("STOPPED", device.st)
    }
}
