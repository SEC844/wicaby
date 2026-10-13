package com.wika.wicaby.core.plex

import android.util.Log
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.plex.PlexLiveMap.LiveDvr
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.Collections
import java.util.UUID

// Live TV and DVR for the Plex dialect (plex-spec §7, PX-11), the twin of desktop main/connection/plex-livetv.ts: what
// PlexApi answers for the Emby-shaped /LiveTv calls, a live channel's PlaybackInfo (the tune) and its reports. The pure
// mapping is LiveTvMap.kt; this holds what it needs between calls: the DVRs, the channel → DVR map, a short-lived grid
// cache, and the programmes the guide showed. Every PMS shape is unverified (PLEX-LIVETV-UNVERIFIED in LiveTvMap.kt).
class PlexLiveTv(
    private val send: suspend (PmsReq) -> JsonElement?,
    private val clientId: String,
    private val plexPass: suspend () -> Boolean?,
    private val items: suspend (List<JsonElement>) -> List<JsonObject>,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private class Channels(val list: List<JsonObject>, val dvrOf: Map<String, LiveDvr>)

    @Volatile
    private var dvrList: Pair<Long, List<LiveDvr>>? = null

    @Volatile
    private var channelList: Pair<Long, Channels>? = null
    private val grids: MutableMap<String, Pair<Long, List<JsonObject>>> = Collections.synchronizedMap(LinkedHashMap())
    private val programs: MutableMap<String, JsonObject> = Collections.synchronizedMap(object : LinkedHashMap<String, JsonObject>(256, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, JsonObject>?) = size > MAX_PROGRAMS
    })

    @Volatile
    private var loggedGate = ""

    // Without Plex Pass PMS refuses the DVR list (401/403): no DVR then, so no Live TV.
    private suspend fun dvrs(): List<LiveDvr> {
        dvrList?.takeIf { clock() - it.first < TTL_MS }?.let { return it.second }
        val list = try {
            PlexLiveMap.liveDvrs(send(PmsReq("GET", "/livetv/dvrs")))
        } catch (e: ApiException) {
            if (e.status == 401 || e.status == 403 || e.status == 404) emptyList() else throw e
        }
        dvrList = clock() to list
        return list
    }

    // The capability: Plex Pass on the owner and a tuner (plex-spec §7). The reason is logged once when it changes.
    suspend fun info(): JsonObject {
        val dvrs = dvrs()
        val pass = plexPass()
        val gate = PlexLiveMap.liveGate(dvrs, pass)
        if (gate != loggedGate) runCatching { Log.i(TAG, if (gate == "ok") "Live TV on (Plex Pass and a tuner)" else if (gate == "noPass") "Live TV off: the server owner has no Plex Pass" else "Live TV off: no DVR tuner on this server") }
        loggedGate = gate
        return PlexLiveMap.toLiveInfo(dvrs, pass)
    }

    suspend fun enabled(): Boolean = runCatching { info()["IsEnabled"].isTrue() }.getOrDefault(false)

    private suspend fun channels(): Channels {
        channelList?.takeIf { clock() - it.first < TTL_MS }?.let { return it.second }
        val dvrs = dvrs()
        val parts = coroutineScope { dvrs.map { d -> async { PlexLiveMap.toChannels(send(PlexLiveMap.channelsRequest(d)), d) } }.awaitAll() }
        val list = ArrayList<JsonObject>()
        val dvrOf = LinkedHashMap<String, LiveDvr>()
        // shortcut: a channel two DVRs share is the first DVR's (one tune target); pick by free tuner if PMS ever says.
        parts.forEachIndexed { i, chs ->
            for (ch in chs) {
                val id = ch["Id"].str()!!
                if (id in dvrOf) continue
                dvrOf[id] = dvrs[i]
                list += ch
            }
        }
        return Channels(list, dvrOf).also { channelList = clock() to it }
    }

    // Every enabled channel's programmes in [from, to], from each DVR's grid (one request per EPG and window, cached).
    private suspend fun guide(from: Long, to: Long): List<JsonObject> {
        val chans = channels()
        val epgs = dvrs().distinctBy { it.epg }
        val now = clock()
        synchronized(grids) { grids.entries.removeAll { now - it.value.first > GRID_TTL_MS } }
        val parts = coroutineScope {
            epgs.map { d ->
                async {
                    val key = "${d.epg}|$from|$to"
                    grids[key]?.second ?: PlexLiveMap.toPrograms(send(PlexLiveMap.gridRequest(d, from, to))).also { grids[key] = now to it }
                }
            }.awaitAll()
        }
        val out = parts.flatten().filter { it["ChannelId"].str() in chans.dvrOf }
        for (p in out) programs[p["Id"].str()!!] = p
        return out
    }

    private fun program(id: String): JsonObject = programs[id] ?: throw ApiException("Programme not in the guide", 404)

    private suspend fun subscriptions() = send(PmsReq("GET", "/media/subscriptions"))

    private suspend fun timers(): List<JsonObject> {
        val (scheduled, subs) = coroutineScope { listOf(async { send(PmsReq("GET", "/media/subscriptions/scheduled")) }, async { subscriptions() }).awaitAll() }
        return PlexLiveMap.toTimers(scheduled, subs)
    }

    private fun list(items: List<JsonElement>) = JsonObject(linkedMapOf("Items" to JsonArray(items), "TotalRecordCount" to JsonPrimitive(items.size), "StartIndex" to JsonPrimitive(0)))

    // ---- The routes (Routes.kt "live*" ops) ----

    suspend fun answer(op: String, params: Map<String, String>, query: Map<String, String>, body: JsonElement?): JsonElement? = when (op) {
        "liveInfo" -> info()
        // The grid's length is not known before it is read: the guide keeps its own default range.
        "liveGuideInfo" -> JsonObject(emptyMap())
        "liveChannels" -> {
            for (k in listOf("IsMovie", "IsSeries", "IsSports", "IsNews", "IsKids", "IsNewOrPremiere")) if (k in query) throw PlexUnmapped("LiveTv/Channels $k")
            val all = channels().list
            val start = query["StartIndex"]?.toIntOrNull() ?: 0
            val limit = query["Limit"]?.toIntOrNull()?.takeIf { it > 0 } ?: all.size
            JsonObject(linkedMapOf("Items" to JsonArray(all.drop(start).take(limit)), "TotalRecordCount" to JsonPrimitive(all.size), "StartIndex" to JsonPrimitive(start)))
        }
        "livePrograms" -> {
            val now = clock()
            val (from, to) = PlexLiveMap.programWindow(query, now)
            list(PlexLiveMap.selectPrograms(guide(from, to), query, now))
        }
        "liveProgram" -> program(params["id"].orEmpty())
        "liveTimerDefaults" -> PlexLiveMap.timerDefaults(program(query["ProgramId"].orEmpty()))
        "liveTimers" -> {
            val timers = timers()
            list(query["SeriesTimerId"]?.let { id -> timers.filter { it["SeriesTimerId"].str() == id } } ?: timers)
        }
        // The record-options sheet reads the timer before editing its padding.
        "liveTimer" -> timers().firstOrNull { it["Id"].str() == params["id"] } ?: throw ApiException("Not found", 404)
        "liveSeriesTimers" -> list(PlexLiveMap.toSeriesTimers(subscriptions()))
        "liveSeriesTimer" -> PlexLiveMap.toSeriesTimer(send(PmsReq("GET", "/media/subscriptions/${params["id"].orEmpty()}"))["MediaSubscription"].list().firstOrNull())
            ?: throw ApiException("Not found", 404)
        "liveCreateTimer", "liveCreateSeriesTimer" -> {
            val guid = program(body["ProgramId"].str().orEmpty())["PlexGuid"].str() ?: throw PlexUnmapped("a programme without a guid cannot be recorded")
            send(PlexLiveMap.createRequest(send(PlexLiveMap.templateRequest(guid)), op == "liveCreateSeriesTimer", body))
            null
        }
        "liveUpdateTimer", "liveCancelTimer" -> {
            val t = PlexLiveMap.parseTimerId(params["id"].orEmpty()) ?: throw PlexUnmapped("timer ${params["id"]}")
            // Plex changes or cancels whole subscriptions: one airing of a series rule stays as the rule says.
            if (t.airing != null) throw PlexUnmapped("one airing of a Plex series rule")
            send(if (op == "liveCancelTimer") PlexLiveMap.deleteRequest(t.sub) else PlexLiveMap.updateRequest(t.sub, body, false))
            null
        }
        "liveUpdateSeriesTimer" -> {
            val id = params["id"].orEmpty()
            if (!SUBSCRIPTION.matches(id)) throw PlexUnmapped("subscription $id")
            send(PlexLiveMap.updateRequest(id, body, true))
            null
        }
        "liveRecordings" -> if ("IsInProgress" in query) list(emptyList()) else {
            val subs = subscriptions()
            val parts = coroutineScope { PlexLiveMap.recordingRequests(subs).map { r -> async { send(r) } }.awaitAll() }
            list(items(parts.flatMap { it["Metadata"].list() }.filter { PlexLiveMap.isRecording(it, subs) }))
        }
        // Only a listed recording, and only its recorded versions (deleteRecordingRequests): never the user's own media.
        "liveDeleteRecording" -> {
            val key = PlexQuery.itemKey(params["id"].orEmpty())
            val (c, subs) = coroutineScope { listOf(async { send(PmsReq("GET", "/library/metadata/$key")) }, async { subscriptions() }).awaitAll() }
            val reqs = PlexLiveMap.deleteRecordingRequests(c["Metadata"].list().firstOrNull(), subs)
            if (reqs.isEmpty()) throw ApiException("Not a recording", 404)
            for (r in reqs) send(r)
            null
        }
        else -> throw PlexUnmapped("Live TV $op")
    }

    // POST /Items/{channel}/PlaybackInfo: tune the channel on its DVR.
    suspend fun tune(channelId: String, query: Map<String, String>, body: JsonElement?): JsonObject {
        val live = PlexLiveMap.parseLiveId(channelId)
        val dvr = channels().dvrOf[channelId]
        if (live == null || live.beginsAt != null || dvr == null) throw ApiException("Not a channel of this server", 404)
        val merged = JsonObject(query.mapValues { JsonPrimitive(it.value) } + ((body as? JsonObject) ?: emptyMap()))
        val session = merged["PlaySessionId"].takeIf { it.isStr() }?.str()?.takeIf { SESSION.matches(it) } ?: UUID.randomUUID().toString()
        return PlexLiveMap.toLivePlayback(send(PlexLiveMap.tuneRequest(dvr, live.ident)), channelId, merged, session, clientId)
    }

    // A live play's reports: nothing to tell PMS while it plays (the HLS fetches keep the transcode alive); Stopped
    // stops the transcode, which frees the tuner.
    suspend fun report(event: String, body: JsonElement?): JsonObject {
        if (event == "Stopped") send(PlexQuery.transcodeRequest("stop", body["PlaySessionId"].str().orEmpty()))
        return JsonObject(emptyMap())
    }

    companion object {
        private const val TAG = "PlexLiveTv"
        private const val TTL_MS = 60_000L
        private const val GRID_TTL_MS = 60_000L
        private const val MAX_PROGRAMS = 5000
        private val SUBSCRIPTION = Regex("^\\d{1,12}$")
        private val SESSION = Regex("^[\\w-]{1,64}$")
    }
}
