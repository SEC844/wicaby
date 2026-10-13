package com.wika.wicaby.core.cast

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.SocketMessage
import com.wika.wicaby.core.data.json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

// cast/RemoteTargets against mockwebserver3 (cast spec CA-03 checks): the picker's filters, the exact /Playing
// query, string command arguments, and the mirror's polling around Sessions pushes.
class RemoteTargetsTest {
    private lateinit var srv: MockWebServer
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    @Volatile private var sessions = "[]"

    @Before
    fun setUp() {
        srv = MockWebServer()
        srv.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return if (request.method == "GET") MockResponse.Builder().code(200).body(sessions).build() else MockResponse.Builder().code(204).build()
            }
        }
        srv.start()
    }

    @After
    fun tearDown() = srv.close()

    private fun api(kind: String = "jellyfin") = Api(Server("srv1", "Home server", srv.url("/").toString().trimEnd('/'), kind), "phone", "tok", "u1")

    private fun session(id: String, device: String, client: String = "Wicaby", remote: Boolean = true, types: String = """["Audio","Video"]""", cmds: String = "[]", extra: String = "") =
        """{"Id":"$id","DeviceId":"$device","DeviceName":"Dev $id","Client":"$client","SupportsRemoteControl":$remote,"PlayableMediaTypes":$types,"SupportedCommands":$cmds$extra}"""

    private val target = CastTarget("s:srv1:tv1", CastTarget.Kind.Session, "TV", "Wicaby", "srv1", "tv1", "dev-tv", setOf("SetVolume", "displaymessage"))

    @Test
    fun listFiltersAndRelabelsDlna() = runBlocking {
        sessions = "[" + listOf(
            session("self", "phone"),
            session("noremote", "d2", remote = false),
            session("audio", "d3", types = """["Audio"]"""),
            session("tv", "d4", cmds = """["SetVolume"]"""),
            session("dlna", "uuid-mock-tv", client = "DLNA"),
        ).joinToString(",") + "]"
        val list = RemoteTargets(api()).list(Item(id = "m1", mediaType = "Video"))
        assertEquals(listOf("tv", "dlna"), list.map { it.sessionId })
        val tv = list[0]
        assertEquals(CastTarget.Kind.Session, tv.kind)
        assertEquals("s:srv1:tv", tv.key)
        assertEquals("Wicaby", tv.detail)
        assertTrue(tv.supports("setvolume"))
        assertFalse(tv.supports("Mute"))
        val dlna = list[1]
        assertEquals(CastTarget.Kind.Dlna, dlna.kind)
        assertEquals("Home server", dlna.detail)
        assertEquals("uuid-mock-tv", dlna.deviceId)
        val url = requests.single().url
        assertEquals("/Sessions", url.encodedPath)
        assertEquals("u1", url.queryParameter("ControllableByUserId"))
    }

    @Test
    fun playIsQueryOnly() = runBlocking {
        RemoteTargets(api("emby")).play(target, listOf("e1", "e2"), startIndex = 1, positionTicks = 600_000_000, msid = "mediasource_3", audio = 2, sub = -1)
        val r = requests.single()
        assertEquals("POST", r.method)
        assertEquals("/emby/Sessions/tv1/Playing", r.url.encodedPath)
        assertEquals(
            "ItemIds=e1%2Ce2&StartIndex=1&PlayCommand=PlayNow&StartPositionTicks=600000000&MediaSourceId=mediasource_3&AudioStreamIndex=2&SubtitleStreamIndex=-1",
            r.url.encodedQuery,
        )
        assertEquals(0L, r.bodySize)
        // A channel: no position, version nor tracks.
        requests.clear()
        RemoteTargets(api()).play(target, listOf("ch1"))
        assertEquals("ItemIds=ch1&PlayCommand=PlayNow", requests.single().url.encodedQuery)
    }

    @Test
    fun commandArgumentsAreStringsAndGated() = runBlocking {
        val rt = RemoteTargets(api())
        assertTrue(rt.command(target, "SetVolume", mapOf("Volume" to "35")))
        val r = requests.single()
        assertEquals("/Sessions/tv1/Command", r.url.encodedPath)
        val body = json.parseToJsonElement(r.body!!.utf8()).jsonObject
        assertEquals("SetVolume", body.getValue("Name").jsonPrimitive.content)
        val v = body.getValue("Arguments").jsonObject.getValue("Volume").jsonPrimitive
        assertTrue("Volume must be a JSON string", v.isString)
        assertEquals("35", v.content)
        // Not listed in SupportedCommands: nothing is sent.
        assertFalse(rt.command(target, "SetAudioStreamIndex", mapOf("Index" to "1")))
        assertTrue(rt.message(target, "Wicaby", "x".repeat(600)))
        assertEquals(500, json.parseToJsonElement(requests.last().body!!.utf8()).jsonObject.getValue("Text").jsonPrimitive.content.length)
        assertEquals(2, requests.size)
        rt.transport(target, "Seek", 42)
        assertEquals("/Sessions/tv1/Playing/Seek", requests.last().url.encodedPath)
        assertEquals("42", requests.last().url.queryParameter("SeekPositionTicks"))
    }

    @Test
    fun mirrorPollsThenFollowsPushesThenFallsBackAfter3s() = runBlocking {
        val playing = ""","NowPlayingItem":{"Id":"m1","RunTimeTicks":100000000000},"PlayState":{"PositionTicks":10000000,"IsPaused":false}"""
        sessions = "[" + session("tv1", "dev-tv", extra = playing) + "]"
        val messages = MutableSharedFlow<SocketMessage>(extraBufferCapacity = 8)
        val sent = CopyOnWriteArrayList<String>()
        val rt = RemoteTargets(api(), messages, { type, data: JsonElement? -> sent += "$type ${data ?: ""}".trim(); true })
        val gets = { requests.count { it.method == "GET" } }
        // Off the test thread, which sleeps.
        val job = launch(Dispatchers.IO) {
            rt.mirror(target).collect {}
        }
        Thread.sleep(300)
        assertEquals(listOf("SessionsStart \"0,1500\""), sent.toList())
        assertEquals(1, gets())
        assertEquals("dev-tv", requests[0].url.queryParameter("DeviceId"))
        // A push for this session: polling pauses while pushes keep coming.
        val push = SocketMessage.parse("""{"MessageType":"Sessions","Data":[${session("tv1", "dev-tv", extra = playing)}]}""")!!
        val start = System.nanoTime()
        while (System.nanoTime() - start < 2_800_000_000) {
            messages.emit(push)
            Thread.sleep(400)
        }
        assertEquals("no poll while pushes arrive", 1, gets())
        // No push for 3 s: polling resumes.
        Thread.sleep(3_600)
        assertTrue("polling did not resume after 3 s (${gets()} GETs)", gets() >= 2)
        job.cancel()
        job.join()
        assertEquals("SessionsStop", sent.last())
    }

    @Test
    fun mirrorAdvancesPositionAndAwaitsItem() = runBlocking {
        sessions = "[" + session("tv1", "dev-tv", extra = ""","NowPlayingItem":{"Id":"m1","RunTimeTicks":100000000000},"PlayState":{"PositionTicks":0,"IsPaused":false}""") + "]"
        val rt = RemoteTargets(api(), MutableSharedFlow(), { _, _ -> false }, tickMs = 100)
        val later = rt.mirror(target).first { it.positionTicks >= 3_000_000 }
        assertEquals("m1", later.itemId)
        assertFalse(later.paused)
        assertTrue(rt.awaitPlaying(target, "m1", 2_000))
        // ignore:true receivers never show the item: the handoff gives up.
        assertFalse(rt.awaitPlaying(target, "other", 1_000))
        sessions = "[]"
        assertNull(rt.mirror(target).first().session)
    }
}
