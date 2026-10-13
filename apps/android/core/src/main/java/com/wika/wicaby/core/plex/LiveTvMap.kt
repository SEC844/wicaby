package com.wika.wicaby.core.plex

import com.wika.wicaby.core.livetv.encodeUriComponent
import com.wika.wicaby.core.livetv.parseServerDate
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.floor

// Plex Live TV and DVR (plex-spec §7, PX-11), the twin of desktop shared/plex/livetv-map.ts: the pure half of the
// adapter that answers the Emby-shaped Live TV calls (livetv/Dialect.kt) from a PMS (vectors:
// tools/checks/fixtures/plex/livetv.json, replayed by PlexVectorsTest). PlexLiveTv sends these requests.
//
// PLEX-LIVETV-UNVERIFIED: every PMS path, query and field carrying this tag comes from the public developer.plex.tv
// documentation and was never checked against a real PMS with a tuner (the PX-11 capture gate is still open). The mock
// (tools/mock-server/mock-plex.mjs, MOCK_PLEX_LIVETV=1) answers the same guesses. Grep the tag before trusting one.
//
// Live TV is on for a plex server only when the owner has Plex Pass (the PMS root's myPlexSubscription) and a DVR
// lists at least one tuner; otherwise /LiveTv/Info says IsEnabled false and the section stays hidden.
object PlexLiveMap {
    // ---- JavaScript semantics the TypeScript twin relies on ----

    private fun s(e: JsonElement?): String? = when {
        e is JsonPrimitive && e.isString -> e.content.ifEmpty { null }
        e.isNum() -> e.str()
        else -> null
    }

    private val NUM_TEXT = Regex("^-?\\d+(\\.\\d+)?$")

    private fun n(e: JsonElement?): Double? = when {
        e.isNum() -> e.num()
        e is JsonPrimitive && e.isString && NUM_TEXT.matches(e.content.trim()) -> e.content.trim().toDouble()
        else -> null
    }

    private fun on(e: JsonElement?): Boolean = e.isTrue() || (e.isNum() && e.num() == 1.0) || (e is JsonPrimitive && e.isString && (e.content == "1" || e.content == "true"))

    private fun on(v: String?): Boolean = v == "1" || v == "true"

    private fun isInt(d: Double) = d == floor(d) && !d.isInfinite()

    // ---- Ids ----

    private val IDENT = Regex("^[!-~]{1,20}$")
    private val LIVE_ID = Regex("^livetv-((?:[0-9a-f]{2}){1,20})(?:-(\\d{1,12}))?$")
    private val PRINTABLE = Regex("^[!-~]+$")

    // Every id passes validId ([A-Za-z0-9-]{1,64}): a channel identifier ("5.1") rides hex-encoded.
    fun liveChannelId(ident: String): String? =
        if (!IDENT.matches(ident)) null else "livetv-" + ident.map { it.code.toString(16).padStart(2, '0') }.joinToString("")

    class LiveId(val ident: String, val beginsAt: Long?) {
        fun toJson(): JsonObject = JsonObject(listOfNotNull("ident" to js(ident), beginsAt?.let { "beginsAt" to jn(it) }).toMap())
    }

    // A channel id, or a programme id (its channel and start, epoch seconds). Null for anything else.
    fun parseLiveId(id: String): LiveId? {
        val m = LIVE_ID.find(id) ?: return null
        val hex = m.groupValues[1]
        val ident = (hex.indices step 2).map { hex.substring(it, it + 2).toInt(16).toChar() }.joinToString("")
        if (!PRINTABLE.matches(ident)) return null
        return LiveId(ident, m.groupValues[2].takeIf { it.isNotEmpty() }?.toLong())
    }

    // ---- DVRs and the capability ----

    // enabled: the enabled channel identifiers (ChannelMapping, #489); null when the DVR sends no mapping.
    data class LiveDvr(val key: String, val lineup: String, val epg: String, val tuners: Double, val enabled: List<String>?) {
        fun toJson(): JsonObject = JsonObject(mapOf("key" to js(key), "lineup" to js(lineup), "epg" to js(epg), "tuners" to jn(tuners), "enabled" to (enabled?.let(::jstrs) ?: JsonNull)))

        companion object {
            fun fromJson(e: JsonElement?) = LiveDvr(e["key"].str()!!, e["lineup"].str()!!, e["epg"].str()!!, e["tuners"].num() ?: 0.0, e["enabled"]?.list()?.mapNotNull { it.str() })
        }
    }

    // PLEX-LIVETV-UNVERIFIED: GET /livetv/dvrs → Dvr[] {key, lineup, epgIdentifier, Device[] {tuners, ChannelMapping[]
    // {lineupIdentifier, enabled}}}.
    fun liveDvrs(c: JsonElement?): List<LiveDvr> = c["Dvr"].objs().mapNotNull { d ->
        val key = s(d["key"]) ?: return@mapNotNull null
        val lineup = s(d["lineup"]) ?: return@mapNotNull null
        val epg = s(d["epgIdentifier"]) ?: return@mapNotNull null
        val devices = d["Device"].objs()
        val maps = devices.flatMap { it["ChannelMapping"].objs() }
        val tuners = devices.sumOf { n(it["tuners"]) ?: 1.0 }
        LiveDvr(key, lineup, epg, tuners, if (maps.isEmpty()) null else maps.filter { on(it["enabled"]) }.mapNotNull { s(it["lineupIdentifier"]) })
    }

    // /LiveTv/Info. Without Plex Pass PMS may also refuse /livetv/dvrs (403): the adapter passes an empty list then.
    fun toLiveInfo(dvrs: List<LiveDvr>, pass: Boolean?): JsonObject {
        val tuners = ArrayList<String>()
        for (d in dvrs) {
            var i = 0
            while (i < d.tuners) tuners += "${d.key}-${i++}"
        }
        val enabled = pass == true && tuners.isNotEmpty()
        val out = obj()
        out["IsEnabled"] = jb(enabled)
        out["EnabledUsers"] = JsonArray(emptyList())
        out["Services"] = JsonArray(if (enabled) listOf(JsonObject(mapOf("Name" to js("Plex DVR"), "Status" to js("Ok"), "Tuners" to jstrs(tuners)))) else emptyList())
        if (pass != null) out["PlexPass"] = jb(pass)
        return out.json()
    }

    // Why Live TV is off, for the log ("ok" when it is on).
    fun liveGate(dvrs: List<LiveDvr>, pass: Boolean?): String = when {
        pass != true -> "noPass"
        dvrs.any { it.tuners > 0 } -> "ok"
        else -> "noTuner"
    }

    // ---- Channels ----

    // PLEX-LIVETV-UNVERIFIED: GET /livetv/epg/channels?lineup= → Channel[] {identifier, title, callSign, channelVcn}.
    fun channelsRequest(d: LiveDvr) = PmsReq("GET", "/livetv/epg/channels", mapOf("lineup" to d.lineup))

    // The DVR's enabled lineup channels as Emby channels. shortcut: no logos (lineup thumbs point at the EPG provider,
    // not the PMS); add them through /photo/:/transcode once a real capture shows the field.
    fun toChannels(c: JsonElement?, d: LiveDvr): List<JsonObject> = c["Channel"].objs().mapNotNull { ch ->
        val ident = s(ch["identifier"]) ?: return@mapNotNull null
        val id = liveChannelId(ident) ?: return@mapNotNull null
        if (d.enabled != null && ident !in d.enabled) return@mapNotNull null
        JsonObject(linkedMapOf("Id" to js(id), "Name" to js(s(ch["title"]) ?: s(ch["callSign"]) ?: ident), "ChannelNumber" to js(s(ch["channelVcn"]) ?: ident), "Type" to js("TvChannel"), "ChannelType" to js("TV")))
    }

    // ---- Guide ----

    private val EPG = Regex("^[\\w.:-]{1,128}$")

    // PLEX-LIVETV-UNVERIFIED: GET /{epgIdentifier}/grid?type=1,4 with the PMS filter operators endsAt>> and beginsAt<<
    // (epoch seconds). One request covers every channel of the lineup; selectPrograms() trims it to the Emby query.
    fun gridRequest(d: LiveDvr, from: Long, to: Long): PmsReq {
        if (!EPG.matches(d.epg)) throw PlexUnmapped("EPG provider ${d.epg}")
        return PmsReq("GET", "/${d.epg}/grid", linkedMapOf("type" to "1,4", "sort" to "beginsAt", "endsAt>>" to "${Math.floorDiv(from, 1000L)}", "beginsAt<<" to "${Math.floorDiv(to, 1000L) + 1}"))
    }

    // PLEX-LIVETV-UNVERIFIED: grid Metadata[] {type (movie | episode), title, grandparentTitle, parentIndex, index,
    // summary, year, guid, Genre[], Media[] {channelIdentifier, beginsAt, endsAt, premiere}}: one Emby programme per
    // airing (Media). PlexGuid is not Emby's: the adapter needs it to record the programme.
    fun toPrograms(c: JsonElement?): List<JsonObject> {
        val out = ArrayList<JsonObject>()
        for (m in c["Metadata"].objs()) {
            val episode = m["type"].isStr() && m["type"].str() == "episode"
            val movie = m["type"].isStr() && m["type"].str() == "movie"
            val title = s(m["title"])
            val genres = m["Genre"].objs().mapNotNull { s(it["tag"]) }
            for (md in m["Media"].objs()) {
                val ident = s(md["channelIdentifier"])
                val ch = ident?.let(::liveChannelId)
                val b = n(md["beginsAt"])
                val e = n(md["endsAt"])
                if (ch == null || b == null || e == null || !isInt(b) || b <= 0 || e <= b) continue
                val p = obj()
                p["Id"] = js("$ch-${b.toLong()}")
                p["ChannelId"] = js(ch)
                p["StartDate"] = js(PlexMap.epochToIso(jn(b))!!)
                p["EndDate"] = js(PlexMap.epochToIso(jn(e))!!)
                p["Name"] = js((if (episode) s(m["grandparentTitle"]) else null) ?: title ?: "")
                p["Type"] = js("Program")
                if (episode && title != null) p["EpisodeTitle"] = js(title)
                n(m["parentIndex"])?.takeIf { episode && isInt(it) }?.let { p["ParentIndexNumber"] = jn(it) }
                n(m["index"])?.takeIf { episode && isInt(it) }?.let { p["IndexNumber"] = jn(it) }
                s(m["summary"])?.let { p["Overview"] = js(it) }
                n(m["year"])?.takeIf(::isInt)?.let { p["ProductionYear"] = jn(it) }
                if (genres.isNotEmpty()) p["Genres"] = jstrs(genres)
                p["IsMovie"] = jb(movie)
                p["IsSeries"] = jb(episode)
                if (on(md["premiere"])) p["IsPremiere"] = jb(true)
                s(m["guid"])?.let { p["PlexGuid"] = js(it) }
                out += p.json()
            }
        }
        return out.sortedWith(compareBy<JsonObject>({ it["StartDate"].str().orEmpty() }, { it["Id"].str().orEmpty() }))
    }

    // The Emby /LiveTv/Programs query keys the adapter honours; any other one (IsSports, LibrarySeriesId…) is unmapped
    // rather than ignored. Categories: films and series only (the grid's type), the rest stays hidden.
    private val PROGRAM_KEYS = setOf("UserId", "userId", "ChannelIds", "MinEndDate", "MaxStartDate", "MinStartDate", "SortBy", "Limit", "EnableImages", "EnableImageTypes", "ImageTypeLimit", "EnableUserData", "EnableTotalRecordCount", "Fields", "SearchTerm", "IsAiring", "IsMovie", "IsSeries")

    // The guide window an Emby programme query covers (ms): IsAiring is now; else MinEndDate (or MinStartDate) to MaxStartDate.
    fun programWindow(q: Map<String, String>, now: Long): Pair<Long, Long> {
        if (on(q["IsAiring"])) return now to now
        val to = parseServerDate(q["MaxStartDate"]) ?: throw PlexUnmapped("LiveTv/Programs without MaxStartDate")
        return (parseServerDate(q["MinEndDate"]) ?: parseServerDate(q["MinStartDate"]) ?: now) to to
    }

    // The programmes of [all] (toPrograms output) an Emby /LiveTv/Programs query asks for, in start order.
    fun selectPrograms(all: List<JsonObject>, q: Map<String, String>, now: Long): List<JsonObject> {
        for (k in q.keys) if (k !in PROGRAM_KEYS) throw PlexUnmapped("LiveTv/Programs $k")
        val (from, to) = programWindow(q, now)
        val minStart = parseServerDate(q["MinStartDate"])
        val channels = q["ChannelIds"]?.takeIf { it.isNotEmpty() }?.split(',')?.toSet()
        val term = (q["SearchTerm"] ?: "").trim().lowercase()
        val out = all.filter { p ->
            val st = parseServerDate(p["StartDate"].str())
            val en = parseServerDate(p["EndDate"].str())
            when {
                st == null || en == null || !(en > from && st <= to) || (minStart != null && st < minStart) -> false
                channels != null && p["ChannelId"].str() !in channels -> false
                on(q["IsMovie"]) && !p["IsMovie"].isTrue() -> false
                on(q["IsSeries"]) && !p["IsSeries"].isTrue() -> false
                else -> term.isEmpty() || (p["Name"].str() ?: "").lowercase().contains(term) || (p["EpisodeTitle"].str() ?: "").lowercase().contains(term)
            }
        }
        val limit = n(q["Limit"]?.let(::JsonPrimitive))
        return if (limit != null && limit > 0) out.take(limit.toInt()) else out
    }

    // GET /LiveTv/Timers/Defaults?ProgramId=: what Emby's defaults carry, from the programme the guide showed.
    fun timerDefaults(p: JsonElement?): JsonObject = JsonObject(
        linkedMapOf(
            "ProgramId" to (p["Id"] ?: JsonNull), "ChannelId" to (p["ChannelId"] ?: JsonNull),
            "StartDate" to (p["StartDate"] ?: JsonNull), "EndDate" to (p["EndDate"] ?: JsonNull), "Name" to (p["Name"] ?: JsonNull),
            "PrePaddingSeconds" to jn(0L), "PostPaddingSeconds" to jn(0L), "RecordAnyChannel" to jb(false), "RecordAnyTime" to jb(true), "RecordNewOnly" to jb(false), "KeepUpTo" to jn(0L),
        ),
    )

    // ---- Subscriptions (timers and series rules, #530) ----

    private val SUB_KEY = Regex("^\\d{1,12}$")

    private fun pref(sub: JsonElement?, id: String): JsonElement? = sub["Setting"].objs().firstOrNull { it["id"].isStr() && it["id"].str() == id }?.get("value")

    private fun subKey(sub: JsonElement?): String? = s(sub["key"])?.takeIf { SUB_KEY.matches(it) }

    // A subscription of type 2 (a show) is a series rule; 1 (a film) and 4 (an episode) record one airing.
    private fun isSeries(sub: JsonElement?) = n(sub["type"]) == 2.0

    private fun paddingS(sub: JsonElement?, id: String): Double = (n(pref(sub, id)) ?: 0.0) * 60

    // PLEX-LIVETV-UNVERIFIED: MediaGrabOperation.status values.
    private val TIMER_STATUS = mapOf("scheduled" to "New", "inprogress" to "InProgress", "error" to "Error", "complete" to "Completed", "blocked" to "ConflictedNotOk")

    class TimerId(val sub: String, val airing: String?) {
        fun toJson(): JsonObject = JsonObject(listOfNotNull("sub" to js(sub), airing?.let { "airing" to js(it) }).toMap())
    }

    private val TIMER_ID = Regex("^rec-(\\d{1,12})(?:-(\\d{1,12}))?$")

    // Timer ids: "rec-{subscription}" for a one-airing subscription, "rec-{subscription}-{beginsAt}" for an airing of a
    // series rule (Plex cancels whole subscriptions only).
    fun parseTimerId(id: String): TimerId? = TIMER_ID.find(id)?.let { TimerId(it.groupValues[1], it.groupValues[2].ifEmpty { null }) }

    // PLEX-LIVETV-UNVERIFIED: GET /media/subscriptions → MediaSubscription[] {key, type, title, Setting[] {id, value},
    // Directory | Video {guid, title}}; GET /media/subscriptions/scheduled → MediaGrabOperation[] {mediaSubscriptionID,
    // status, Metadata {…grid metadata, Media[0] the airing}}.
    fun toTimers(scheduled: JsonElement?, subs: JsonElement?): List<JsonObject> {
        val byKey = LinkedHashMap<String, JsonObject>()
        for (sub in subs["MediaSubscription"].objs()) subKey(sub)?.let { byKey[it] = sub }
        val out = ArrayList<JsonObject>()
        for (op in scheduled["MediaGrabOperation"].objs()) {
            val k = s(op["mediaSubscriptionID"])
            val sub = k?.let { byKey[it] }
            val meta = op["Metadata"] as? JsonObject
            val p = meta?.let { toPrograms(JsonObject(mapOf("Metadata" to JsonArray(listOf(JsonObject(it + ("Media" to JsonArray(it["Media"].objs().take(1))))))))).firstOrNull() }
            if (k == null || sub == null || p == null) continue
            val series = isSeries(sub)
            val beginsAt = p["Id"].str()!!.substringAfterLast('-')
            val t = obj()
            t["Id"] = js(if (series) "rec-$k-$beginsAt" else "rec-$k")
            t["ProgramId"] = p["Id"]!!
            t["ChannelId"] = p["ChannelId"]!!
            t["StartDate"] = p["StartDate"]!!
            t["EndDate"] = p["EndDate"]!!
            t["Name"] = p["Name"]!!
            t["Status"] = js(TIMER_STATUS[op["status"].str()] ?: "New")
            t["PrePaddingSeconds"] = jn(paddingS(sub, "startOffsetMinutes"))
            t["PostPaddingSeconds"] = jn(paddingS(sub, "endOffsetMinutes"))
            if (series) t["SeriesTimerId"] = js(k)
            out += t.json()
        }
        return out
    }

    // One series rule as Emby's SeriesTimerInfo, or null for a one-airing subscription.
    fun toSeriesTimer(sub: JsonElement?): JsonObject? {
        val k = subKey(sub) ?: return null
        if (!isSeries(sub)) return null
        val hint = (sub["Directory"] as? JsonObject) ?: (sub["Video"] as? JsonObject)
        val channel = s(pref(sub, "lineupChannel"))?.let(::liveChannelId)
        val rule = obj()
        rule["Id"] = js(k)
        rule["Type"] = js("SeriesTimer")
        rule["Name"] = js(s(sub["title"]) ?: s(hint["title"]) ?: "")
        rule["RecordAnyChannel"] = jb(channel == null)
        rule["RecordAnyTime"] = jb(true)
        rule["RecordNewOnly"] = jb(on(pref(sub, "onlyNewAirings")))
        rule["PrePaddingSeconds"] = jn(paddingS(sub, "startOffsetMinutes"))
        rule["PostPaddingSeconds"] = jn(paddingS(sub, "endOffsetMinutes"))
        rule["KeepUpTo"] = jn(0L)
        rule["Priority"] = jn(0L)
        if (channel != null) rule["ChannelId"] = js(channel)
        return rule.json()
    }

    fun toSeriesTimers(subs: JsonElement?): List<JsonObject> = subs["MediaSubscription"].objs().mapNotNull(::toSeriesTimer)

    // PLEX-LIVETV-UNVERIFIED: GET /media/subscriptions/template?guid= → SubscriptionTemplate[0].MediaSubscription[]
    // {type, targetLibrarySectionID, targetSectionLocationID, parameters}: one entry per way to record the programme.
    fun templateRequest(guid: String) = PmsReq("GET", "/media/subscriptions/template", mapOf("guid" to guid))

    // The prefs[…] an Emby timer or rule body sets. PLEX-LIVETV-UNVERIFIED: the pref ids.
    private fun prefsOf(body: JsonElement?, series: Boolean): Map<String, String> {
        val q = LinkedHashMap<String, String>()
        n(body["PrePaddingSeconds"])?.let { q["prefs[startOffsetMinutes]"] = jsNumberText(jsRound(it / 60)) }
        n(body["PostPaddingSeconds"])?.let { q["prefs[endOffsetMinutes]"] = jsNumberText(jsRound(it / 60)) }
        if (series) {
            q["prefs[onlyNewAirings]"] = if (on(body["RecordNewOnly"])) "1" else "0"
            val ch = if (on(body["RecordAnyChannel"])) null else parseLiveId(s(body["ChannelId"]) ?: "")
            q["prefs[lineupChannel]"] = ch?.ident ?: ""
        } else {
            q["prefs[oneShot]"] = "true"
        }
        return q
    }

    // PLEX-LIVETV-UNVERIFIED: POST /media/subscriptions with the template entry's parameters, its type and target
    // library, and the prefs. series: the show entry (type 2); else the one-airing entry.
    fun createRequest(template: JsonElement?, series: Boolean, body: JsonElement?): PmsReq {
        val entries = template["SubscriptionTemplate"].objs().firstOrNull()["MediaSubscription"].objs()
        val e = entries.firstOrNull { isSeries(it) == series }
            ?: throw PlexUnmapped(if (series) "no series subscription for this programme" else "no one-airing subscription for this programme")
        val q = LinkedHashMap<String, String>()
        for (pair in (s(e["parameters"]) ?: "").split('&')) {
            if (pair.isEmpty()) continue
            val k = pair.substringBefore('=')
            val v = if ('=' in pair) pair.substringAfter('=') else ""
            q[formDecode(k)] = formDecode(v)
        }
        q["type"] = n(e["type"])?.let(::jsNumberText) ?: ""
        s(e["targetLibrarySectionID"])?.let { q["targetLibrarySectionID"] = it }
        s(e["targetSectionLocationID"])?.let { q["targetSectionLocationID"] = it }
        return PmsReq("POST", "/media/subscriptions", q + prefsOf(body, series))
    }

    // URLSearchParams parsing: '+' is a space, then percent-decoding.
    private fun formDecode(s: String) = pctDecode(s.replace('+', ' '))

    // PLEX-LIVETV-UNVERIFIED: PUT /media/subscriptions/{id}?prefs[…] (padding, new only, channel).
    fun updateRequest(sub: String, body: JsonElement?, series: Boolean) = PmsReq("PUT", "/media/subscriptions/${encodeUriComponent(sub)}", prefsOf(body, series))

    // PLEX-LIVETV-UNVERIFIED: DELETE /media/subscriptions/{id}.
    fun deleteRequest(sub: String) = PmsReq("DELETE", "/media/subscriptions/${encodeUriComponent(sub)}")

    // ---- Recordings ----

    // PMS files a recording in its subscription's target library as an ordinary item; no recordings list is documented
    // (PLEX-LIVETV-UNVERIFIED). Wicaby lists, in those libraries, the items that match a subscription (a film by its guid,
    // an episode by its show's guid) AND carry a recorded version: matching a subscription alone would list, and offer to
    // delete, the user's own copies of every show they subscribe to.
    fun recordingRequests(subs: JsonElement?): List<PmsReq> {
        val seen = HashSet<String>()
        val out = ArrayList<PmsReq>()
        for (sub in subs["MediaSubscription"].objs()) {
            val section = s(sub["targetLibrarySectionID"])?.takeIf { SUB_KEY.matches(it) } ?: continue
            val type = if (n(sub["type"]) == 1.0) "1" else "4"
            if (!seen.add("$section/$type")) continue
            out += PmsReq("GET", "/library/sections/$section/all", linkedMapOf("type" to type, "sort" to "addedAt:desc"))
        }
        return out
    }

    // PLEX-LIVETV-UNVERIFIED: the DVR records MPEG-TS, so a recorded airing is a Media of container 'mpegts' (PMS adds it as
    // one more version when the item already exists). The ids of those versions; the user's own files are never among them.
    fun recordedMedia(meta: JsonElement?): List<String> =
        meta["Media"].objs().filter { it["container"].takeIf { c -> c.isStr() }?.str() == "mpegts" }.mapNotNull { s(it["id"])?.takeIf { id -> SUB_KEY.matches(id) } }

    fun isRecording(meta: JsonElement?, subs: JsonElement?): Boolean {
        val guids = subs["MediaSubscription"].objs().mapNotNull { sub -> s(((sub["Directory"] as? JsonObject) ?: (sub["Video"] as? JsonObject))["guid"]) }.toSet()
        val type = meta["type"].takeIf { it.isStr() }?.str()
        val own = s(meta["guid"])
        val show = s(meta["grandparentGuid"])
        val matches = (type == "movie" && own != null && own in guids) || (type == "episode" && show != null && show in guids)
        return matches && recordedMedia(meta).isNotEmpty()
    }

    // DELETE /LiveTv/Recordings/{id}: DELETE /library/metadata/{key}/media/{media} for each recorded version only, so the
    // item and the user's own versions stay. Empty (the adapter answers 404) for an item that is not a recording.
    fun deleteRecordingRequests(meta: JsonElement?, subs: JsonElement?): List<PmsReq> {
        val key = s(meta["ratingKey"])?.takeIf { SUB_KEY.matches(it) } ?: return emptyList()
        if (!isRecording(meta, subs)) return emptyList()
        return recordedMedia(meta).map { PmsReq("DELETE", "/library/metadata/$key/media/$it") }
    }

    // ---- Tune ----

    // PLEX-LIVETV-UNVERIFIED: POST /livetv/dvrs/{dvr}/channels/{channelIdentifier}/tune → Metadata[0] {key: the live
    // session's path}, played through the universal transcoder like any Plex transcode (§6.1).
    fun tuneRequest(d: LiveDvr, ident: String) = PmsReq("POST", "/livetv/dvrs/${encodeUriComponent(d.key)}/channels/${encodeUriComponent(ident)}/tune")

    // Above this a cap means "Original": no maxVideoBitrate (as Decision.kt).
    private const val ORIGINAL_BPS = 100_000_000.0

    // The tune answer → PlaybackInfo for the live ladder (livetv/LiveSession.kt pickPlay): HLS through start.m3u8, never
    // direct play, and LiveStreamId = the play session, which a Stopped report or /LiveStreams/Close stops.
    // [body]: the Emby PlaybackInfo query and body merged (MaxStreamingBitrate, AllowVideoStreamCopy).
    fun toLivePlayback(c: JsonElement?, channelId: String, body: JsonElement?, session: String, clientId: String): JsonObject {
        val key = s(c["Metadata"].objs().firstOrNull()["key"])
            ?: return JsonObject(mapOf("MediaSources" to JsonArray(emptyList()), "PlaySessionId" to js(session)))
        val q = linkedMapOf(
            "path" to key, "protocol" to "hls", "directPlay" to "0", "directStream" to if (body["AllowVideoStreamCopy"].isFalse()) "0" else "1",
            "directStreamAudio" to "1", "session" to session, "X-Plex-Client-Identifier" to clientId,
        )
        val bps = n(body["MaxStreamingBitrate"]) ?: 0.0
        if (bps > 0 && bps < ORIGINAL_BPS) q["maxVideoBitrate"] = jsNumberText(floor(bps / 1000))
        val source = JsonObject(
            linkedMapOf(
                "Id" to js(channelId), "Protocol" to js("Http"), "Container" to js("ts"), "SupportsDirectPlay" to jb(false), "SupportsDirectStream" to jb(false),
                "SupportsTranscoding" to jb(true), "RequiresOpening" to jb(false), "LiveStreamId" to js(session),
                "TranscodingUrl" to js("/video/:/transcode/universal/start.m3u8?" + formEncode(q)), "TranscodingSubProtocol" to js("hls"),
            ),
        )
        return JsonObject(mapOf("MediaSources" to JsonArray(listOf(source)), "PlaySessionId" to js(session)))
    }
}
