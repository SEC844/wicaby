package com.wika.wicaby.core.plex

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.io.IOException
import java.math.BigDecimal

// PX-13: the Kotlin Plex dialect against the golden vectors the desktop checks too, read in place (the
// ParityFixturesTest pattern): tools/checks/fixtures/plex/vectors.json and decision.json (plex-map-check.mjs), and
// connections.json (plex-connections-check.mjs), plus the race cases of that check. Same cases, same outputs.
class PlexVectorsTest {
    private val dir = File("../../../tools/checks/fixtures/plex")

    private fun cases(name: String): List<JsonObject> =
        Json.parseToJsonElement(File(dir, name).readText()).jsonObject["cases"]!!.jsonArray.map { it.jsonObject }

    // Plain JSON, as JSON.stringify leaves it: numbers by value (1 == 1.0), keys unordered.
    private fun norm(e: JsonElement?): Any? = when (e) {
        null, JsonNull -> null
        is JsonObject -> e.mapValues { norm(it.value) }.filterValues { it != null }.toSortedMap()
        is JsonArray -> e.map { norm(it) }
        is JsonPrimitive -> if (!e.isString && e.content != "true" && e.content != "false") BigDecimal(e.content).stripTrailingZeros().toPlainString() else e.content to e.isString
    }

    private fun str(e: JsonElement?) = e?.takeUnless { it is JsonNull }?.let { (it as JsonPrimitive).content }
    private fun obj(e: JsonElement?) = e as? JsonObject
    private fun bool(e: JsonElement?) = str(e) == "true"
    private fun int(e: JsonElement?) = str(e)?.toDouble()?.toInt()
    private fun j(s: String?): JsonElement = s?.let(::JsonPrimitive) ?: JsonNull
    private fun j(m: Map<String, String>?): JsonElement = m?.toJson() ?: JsonNull

    private val run: Map<String, (List<JsonElement?>) -> JsonElement> = mapOf(
        "providerIds" to { a -> PlexGuid.providerIds(a[0]).toJson() },
        "imageTag" to { a -> j(PlexImages.imageTag(str(a[0]))) },
        "imagePaths" to { a -> PlexImages.imagePaths(a[0]).toJson() },
        "parseImageRoute" to { a -> PlexImages.parseImageRoute(str(a[0])!!)?.let { JsonObject(mapOf("id" to JsonPrimitive(it.id), "type" to JsonPrimitive(it.type))) } ?: JsonNull },
        "transcodePath" to { a -> JsonPrimitive(PlexImages.transcodePath(str(a[0])!!, str(a[1])!!, obj(a.getOrNull(2)).toQuery())) },
        "itemType" to { a -> j(PlexMap.itemType(a[0])) },
        "toView" to { a -> PlexMap.toView(a[0]) },
        "toUserData" to { a -> PlexMap.toUserData(a[0]) },
        "toStream" to { a -> PlexMap.toStream(a[0]) ?: JsonNull },
        "toMediaSources" to { a -> JsonArray(PlexMap.toMediaSources(a[0])) },
        "toItem" to { a -> PlexMap.toItem(a[0]) ?: JsonNull },
        "toItemsResult" to { a -> PlexMap.toItemsResult(a[0], int(a.getOrNull(1)) ?: 0) },
        "toExtras" to { a -> JsonArray(PlexMap.toExtras(a[0], bool(a[1]))) },
        "toSegments" to { a -> PlexMap.toSegments(a[0]) },
        "toHubs" to { a -> JsonArray(PlexMap.toHubs(a[0])) },
        "toChapters" to { a -> PlexMap.toChapters(a[0])?.let(::JsonArray) ?: JsonNull },
        "parseId" to { a -> PlexMap.parseId(str(a[0])!!)?.let { JsonObject(mapOf("kind" to JsonPrimitive(it.kind), "key" to JsonPrimitive(it.key))) } ?: JsonNull },
        "msToTicks" to { a -> PlexMap.msToTicks(a[0])?.let(::JsonPrimitive) ?: JsonNull },
        "ticksToMs" to { a -> JsonPrimitive(PlexMap.ticksToMs(a[0])) },
        "epochToIso" to { a -> j(PlexMap.epochToIso(a[0])) },
        "playablePart" to { a -> PlexMap.playablePart(a[0], str(a.getOrNull(1)))?.get("id") ?: JsonNull },
        "partQueue" to { a -> JsonArray(PlexMap.partQueue(a[0], str(a.getOrNull(1))).map { it["id"]!! }) },
        "seasonsFlattened" to { a -> JsonPrimitive(PlexMap.seasonsFlattened(a[0])) },
        "accountSubtitles" to { a -> PlexMap.accountSubtitles(a.getOrNull(0)) },
        "itemsRequest" to { a -> PlexQuery.itemsRequest(obj(a[0]).toQuery()).toJson() },
        "resumeRequest" to { a -> PlexQuery.resumeRequest(obj(a[0]).toQuery()).toJson() },
        "nextUpRequest" to { a -> PlexQuery.nextUpRequest(obj(a[0]).toQuery()).toJson() },
        "latestRequest" to { a -> PlexQuery.latestRequest(obj(a[0]).toQuery()).toJson() },
        "answerMeta" to { a -> JsonArray(PlexQuery.answerMeta(PmsReq.fromJson(a[0]), a.getOrNull(1))) },
        "metadataRequest" to { a -> PlexQuery.metadataRequest(str(a[0])!!).toJson() },
        "playedRequest" to { a -> PlexQuery.playedRequest(str(a[0])!!, bool(a[1])).toJson() },
        "userDataRequest" to { a -> PlexQuery.userDataRequest(str(a[0])!!, a.getOrNull(1)).toJson() },
        "timelineRequest" to { a -> PlexQuery.timelineRequest(str(a[0])!!, a.getOrNull(1)).toJson() },
        "transcodeRequest" to { a -> PlexQuery.transcodeRequest(str(a[0])!!, str(a[1]).orEmpty()).toJson() },
        "itemsUri" to { a -> JsonPrimitive(PlexQuery.itemsUri(str(a[0])!!, a[1]!!.jsonArray.map { str(it)!! })) },
        "withGenreIds" to { a -> PlexQuery.withGenreIds(PmsReq.fromJson(a[0]), a[1]!!.jsonArray).toJson() },
        "translate" to { a ->
            val t = PlexRoutes.translate(str(a[0])!!, str(a[1])!!, obj(a.getOrNull(2)).toQuery(), a.getOrNull(3), PlexRoutes.Ctx(str(obj(a.getOrNull(4))?.get("machineId")).orEmpty()))
            val out = linkedMapOf<String, JsonElement>("op" to JsonPrimitive(t.op), "params" to t.params.toJson())
            if (t.req != null) out["req"] = t.req!!.toJson() else out["adapter"] = JsonPrimitive(true)
            JsonObject(out)
        },
        "matchRoute" to { a ->
            PlexRoutes.matchRoute(str(a[0])!!, str(a[1])!!)?.let {
                JsonObject(mapOf("op" to JsonPrimitive(it.route.op), "media" to JsonPrimitive(it.route.media), "params" to it.params.toJson()))
            } ?: JsonNull
        },
        "profileExtra" to { a -> JsonPrimitive(PlexDecision.profileExtra(a[0])) },
        "decisionRequest" to { a -> PlexDecision.decisionRequest(str(a[0])!!, a[1], a[2], str(a[3])!!, str(a[4])!!, int(a.getOrNull(5))).toJson() },
        "toPlaybackInfo" to { a -> PlexDecision.toPlaybackInfo(a[0], a[1], PlexDecision.Request.fromJson(a[2])) },
        "decisionFailure" to { a -> j(PlexDecision.decisionFailure(int(a[0])!!, str(a[1]).orEmpty())) },
        "remoteCapKbps" to { a -> JsonPrimitive(PlexDecision.remoteCapKbps(a.getOrNull(0))) },
        "trackPut" to { a ->
            PlexDecision.trackPut(a[0], str(a.getOrNull(1)), int(a.getOrNull(2)), int(a.getOrNull(3)))?.let {
                JsonObject(mapOf("path" to JsonPrimitive(it.first), "query" to it.second.toJson()))
            } ?: JsonNull
        },
        "partPaths" to { a -> JsonArray(PlexDecision.partPaths(a[0], str(a.getOrNull(1)))) },
        "partWindow" to { a ->
            PlexDecision.partWindow(a[0]!!.jsonArray.map { it["durationMs"].num()?.toLong() }, str(a[1])!!.toDouble().toLong())?.let { w ->
                JsonObject(listOfNotNull("index" to JsonPrimitive(w.index), "startMs" to JsonPrimitive(w.startMs), w.endMs?.let { "endMs" to JsonPrimitive(it) }).toMap())
            } ?: JsonNull
        },
        // livetv.json (PX-11).
        "liveChannelId" to { a -> j(PlexLiveMap.liveChannelId(str(a[0])!!)) },
        "parseLiveId" to { a -> PlexLiveMap.parseLiveId(str(a[0])!!)?.toJson() ?: JsonNull },
        "liveDvrs" to { a -> JsonArray(PlexLiveMap.liveDvrs(a[0]).map { it.toJson() }) },
        "toLiveInfo" to { a -> PlexLiveMap.toLiveInfo(dvrs(a[0]), a.getOrNull(1)?.let { bool(it) }) },
        "liveGate" to { a -> JsonPrimitive(PlexLiveMap.liveGate(dvrs(a[0]), a.getOrNull(1)?.let { bool(it) })) },
        "channelsRequest" to { a -> PlexLiveMap.channelsRequest(PlexLiveMap.LiveDvr.fromJson(a[0])).toJson() },
        "toChannels" to { a -> JsonArray(PlexLiveMap.toChannels(a[0], PlexLiveMap.LiveDvr.fromJson(a[1]))) },
        "gridRequest" to { a -> PlexLiveMap.gridRequest(PlexLiveMap.LiveDvr.fromJson(a[0]), long(a[1]), long(a[2])).toJson() },
        "toPrograms" to { a -> JsonArray(PlexLiveMap.toPrograms(a[0])) },
        "programWindow" to { a -> PlexLiveMap.programWindow(obj(a[0]).toQuery(), long(a[1])).let { (f, t) -> JsonObject(mapOf("from" to JsonPrimitive(f), "to" to JsonPrimitive(t))) } },
        "selectPrograms" to { a -> JsonArray(PlexLiveMap.selectPrograms(a[0]!!.jsonArray.map { it.jsonObject }, obj(a[1]).toQuery(), long(a[2]))) },
        "timerDefaults" to { a -> PlexLiveMap.timerDefaults(a[0]) },
        "parseTimerId" to { a -> PlexLiveMap.parseTimerId(str(a[0])!!)?.toJson() ?: JsonNull },
        "toTimers" to { a -> JsonArray(PlexLiveMap.toTimers(a[0], a.getOrNull(1))) },
        "toSeriesTimer" to { a -> PlexLiveMap.toSeriesTimer(a[0]) ?: JsonNull },
        "toSeriesTimers" to { a -> JsonArray(PlexLiveMap.toSeriesTimers(a[0])) },
        "templateRequest" to { a -> PlexLiveMap.templateRequest(str(a[0])!!).toJson() },
        "createRequest" to { a -> PlexLiveMap.createRequest(a[0], bool(a[1]), a.getOrNull(2)).toJson() },
        "updateRequest" to { a -> PlexLiveMap.updateRequest(str(a[0])!!, a.getOrNull(1), bool(a[2])).toJson() },
        "deleteRequest" to { a -> PlexLiveMap.deleteRequest(str(a[0])!!).toJson() },
        "recordingRequests" to { a -> JsonArray(PlexLiveMap.recordingRequests(a[0]).map { it.toJson() }) },
        "isRecording" to { a -> JsonPrimitive(PlexLiveMap.isRecording(a[0], a.getOrNull(1))) },
        "recordedMedia" to { a -> JsonArray(PlexLiveMap.recordedMedia(a[0]).map(::JsonPrimitive)) },
        "deleteRecordingRequests" to { a -> JsonArray(PlexLiveMap.deleteRecordingRequests(a[0], a.getOrNull(1)).map { it.toJson() }) },
        "tuneRequest" to { a -> PlexLiveMap.tuneRequest(PlexLiveMap.LiveDvr.fromJson(a[0]), str(a[1])!!).toJson() },
        "toLivePlayback" to { a -> PlexLiveMap.toLivePlayback(a[0], str(a[1])!!, a.getOrNull(2), str(a[3])!!, str(a[4])!!) },
    )

    private fun dvrs(e: JsonElement?) = e!!.jsonArray.map(PlexLiveMap.LiveDvr::fromJson)

    private fun long(e: JsonElement?) = BigDecimal(str(e)!!).toLong()

    private fun runCase(c: JsonObject): JsonElement {
        val fn = run[str(c["fn"])] ?: error("unknown fn ${str(c["fn"])}")
        return try {
            fn(c["args"]!!.jsonArray.map { it.takeUnless { e -> e is JsonNull } })
        } catch (e: PlexUnmapped) {
            JsonObject(mapOf("throws" to JsonPrimitive(e.message), "status" to JsonPrimitive(e.status)))
        }
    }

    @Test
    fun mapAndDecisionVectors() {
        val all = cases("vectors.json") + cases("decision.json") + cases("livetv.json")
        val problems = ArrayList<String>()
        for (c in all) {
            val got = try {
                runCase(c)
            } catch (e: Throwable) {
                problems += "${str(c["name"])}: threw $e"
                continue
            }
            if (norm(got) != norm(c["out"])) problems += "${str(c["name"])}:\n    expected ${c["out"]}\n    got      $got"
        }
        if (problems.isNotEmpty()) fail("${problems.size} of ${all.size} Plex vectors differ:\n" + problems.joinToString("\n"))
        // Every function the desktop core exports for the adapter has a vector, and Android runs them all.
        val covered = all.map { str(it["fn"]) }.toSet()
        assertEquals(run.keys, covered)
        assertTrue("PX-03 asks for at least 80 vectors", all.size >= 80)
    }

    @Test
    fun connectionRankingVectors() {
        val all = cases("connections.json")
        for (c in all) {
            val conns = c["connections"]!!.jsonArray.map { plexJson.decodeFromJsonElement(PlexConnection.serializer(), it) }
            val o = obj(c["options"])
            val r = PlexConnections.rankConnections(conns, bool(o?.get("httpsRequired")), o?.get("subnets")?.jsonArray?.map { str(it)!! }, str(o?.get("lastGood")))
            val got = JsonObject(
                mapOf(
                    "waves" to JsonArray(r.waves.map { w -> JsonArray(w.map(::JsonPrimitive)) }),
                    "dropped" to JsonArray(r.dropped.map { JsonObject(mapOf("uri" to JsonPrimitive(it.uri), "why" to JsonPrimitive(it.why))) }),
                ),
            )
            assertEquals(str(c["name"]), norm(c["out"]), norm(got))
        }
        assertTrue(all.size >= 10)
        assertTrue(PlexConnections.inSubnet("10.0.0.200", "10.0.0.0/24") && !PlexConnections.inSubnet("10.0.1.1", "10.0.0.0/24"))
        assertTrue(PlexConnections.inSubnet("1.2.3.4", "0.0.0.0/0") && !PlexConnections.inSubnet("x", "10.0.0.0/8"))
    }

    // ---- raceWaves: the race cases of plex-connections-check.mjs, with the same fake probe and short delays ----

    private val delays = listOf(0L, 60L, 150L)

    // The first race of a JVM pays for the dispatcher's threads: not the cases' timing.
    init {
        race(listOf(listOf("warm")), Fake(mapOf("warm" to (1L to true))))
    }

    private class Fake(private val table: Map<String, Pair<Long, Boolean>>) {
        val started: MutableList<String> = java.util.Collections.synchronizedList(ArrayList())
        val probe: suspend (String) -> String = { uri ->
            started += uri
            val (ms, ok) = table.getValue(uri)
            delay(ms)
            if (!ok) throw IOException("down")
            uri
        }
    }

    private fun race(waves: List<List<String>>, f: Fake): Pair<String, Long> = runBlocking {
        val t = System.nanoTime()
        val (uri, _) = PlexConnections.raceWaves(waves, delays, f.probe)
        uri to (System.nanoTime() - t) / 1_000_000
    }

    @Test
    fun raceLocalUpWinsBeforeRemoteStarts() {
        val f = Fake(mapOf("local" to (5L to true), "remote" to (5L to true), "relay" to (5L to true)))
        assertEquals("local", race(listOf(listOf("local"), listOf("remote"), listOf("relay")), f).first)
        assertTrue("remote never started", "remote" !in f.started)
    }

    @Test
    fun raceDeadLocalHandsOverToRemoteThenRelay() {
        val f = Fake(mapOf("local" to (100L to false), "remote" to (5L to true), "relay" to (5L to true)))
        assertEquals("remote", race(listOf(listOf("local"), listOf("remote"), listOf("relay")), f).first)
        assertTrue("the relay was not needed", "relay" !in f.started)
        val g = Fake(mapOf("local" to (5L to false), "remote" to (5L to false), "relay" to (5L to true)))
        val (uri, ms) = race(listOf(listOf("local"), listOf("remote"), listOf("relay")), g)
        assertEquals("relay", uri)
        assertTrue("each wave starts as soon as everything before it failed ($ms ms)", ms < 140)
        assertEquals(listOf("local", "remote", "relay"), g.started.toList())
    }

    @Test
    fun raceAllDownOrNothingThrows() {
        val f = Fake(mapOf("a" to (5L to false), "b" to (5L to false)))
        val e = runCatching { race(listOf(listOf("a"), emptyList(), listOf("b")), f) }.exceptionOrNull()
        assertEquals("unreachable", e?.message)
        assertEquals("no candidate", runCatching { race(listOf(emptyList(), emptyList(), emptyList()), f) }.exceptionOrNull()?.message)
    }

    @Test
    fun raceRankNotSpeedInsideAWave() {
        val f = Fake(mapOf("https" to (40L to true), "http" to (5L to true)))
        assertEquals("https beats a faster http", "https", race(listOf(listOf("https", "http")), f).first)
        assertEquals(listOf("https", "http"), f.started.toList())
        val r = PlexConnections.rankConnections(
            listOf(
                PlexConnection("http://192.168.1.5:32400", "http", "192.168.1.5", local = true),
                PlexConnection("https://192-168-1-5.abc.plex.direct:32400", "https", "192.168.1.5", local = true),
            ),
            subnets = listOf("192.168.1.0/24"),
        )
        val g = Fake(mapOf("http://192.168.1.5:32400" to (5L to true), "https://192-168-1-5.abc.plex.direct:32400" to (40L to true)))
        assertEquals("https://192-168-1-5.abc.plex.direct:32400", race(r.waves, g).first)
        val h = Fake(mapOf("last" to (30L to true), "other" to (5L to true)))
        assertEquals("lastGood first", "last", race(listOf(listOf("last", "other")), h).first)
        val k = Fake(mapOf("https" to (20L to false), "http" to (5L to true)))
        val (uri, ms) = race(listOf(listOf("https", "http")), k)
        assertEquals("https down: http", "http", uri)
        assertTrue("without waiting for the next wave ($ms ms)", ms < 55 + 100)
    }

    @Test
    fun racePendingLocalHoldsBackRemoteAndRelay() {
        // Home https hangs (plex.direct DNS rebind) while home http answers at once: remote and relay answers that come
        // in meanwhile must not win; home http does, when https gives up (the desktop's LAN-first fix).
        val f = Fake(mapOf("https" to (250L to false), "http" to (5L to true), "rhttps" to (5L to true), "relay" to (5L to true)))
        val (uri, ms) = race(listOf(listOf("https", "http"), listOf("rhttps"), listOf("relay")), f)
        assertEquals("a pending local holds back remote and relay", "http", uri)
        assertTrue("remote and relay answered first, yet lost ($ms ms)", ms >= 240 && "relay" in f.started)
        val g = Fake(mapOf("https" to (250L to false), "http" to (5L to true), "relay" to (5L to true)))
        assertEquals("no remote: home http, not the relay", "http", race(listOf(listOf("https", "http"), emptyList(), listOf("relay")), g).first)
        val h = Fake(mapOf("https" to (250L to false), "rhttps" to (5L to true)))
        val (u2, ms2) = race(listOf(listOf("https"), listOf("rhttps")), h)
        assertEquals("local gone: remote", "rhttps", u2)
        assertTrue("right after the local timeout ($ms2 ms)", ms2 < 300 + 100)
    }
}
