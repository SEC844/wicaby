package com.wika.wicaby.core.plex

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlin.math.floor

// The Plex playback decision (plex-spec §6.1 to §6.4), the twin of desktop shared/plex/decision.ts: PlaybackInfo's
// body → the client profile header and the /video/:/transcode/universal/decision query; the answer → one Emby
// MediaSource (direct play through the part, else an HLS start.m3u8 that starts at the offset). Pure; the vectors
// are tools/checks/fixtures/plex/decision.json.
object PlexDecision {
    // A profile that names no codec (FFmpeg decodes them all): Plex wants them listed.
    private const val ANY_CONTAINER = "mkv,mp4,m4v,mov,avi,webm,mpegts,ts,m2ts,wmv,asf,flv,ogg,3gp"
    private const val ANY_VIDEO = "h264,hevc,av1,vp9,vp8,mpeg2video,mpeg4,msmpeg4v3,vc1,wmv3,mpeg1video,h263"
    private const val ANY_AUDIO = "aac,ac3,eac3,dca,dts,truehd,flac,mp3,mp2,opus,vorbis,pcm,alac,wmav2"
    private val IMAGE_SUBS = setOf("pgs", "pgssub", "hdmv_pgs_subtitle", "dvdsub", "dvd_subtitle", "vobsub", "dvbsub", "dvb_subtitle")

    // Above this a cap means "Original": no maxVideoBitrate.
    private const val ORIGINAL_BPS = 100_000_000.0

    private fun plexContainer(c: String?) = if (c == "ts") "mpegts" else c ?: "mpegts"

    // X-Plex-Client-Profile-Extra: what this player plays as is, and what a transcode should produce (video only).
    fun profileExtra(p: JsonElement?): String {
        val out = ArrayList<String>()
        for (d in p["DirectPlayProfiles"].list()) {
            if (d["Type"].str() != "Video") continue
            out += "add-direct-play-profile(type=videoProfile&container=${d["Container"].str() ?: ANY_CONTAINER}&videoCodec=${d["VideoCodec"].str() ?: ANY_VIDEO}&audioCodec=${d["AudioCodec"].str() ?: ANY_AUDIO})"
        }
        for (t in p["TranscodingProfiles"].list()) {
            if (t["Type"].str() != "Video" || (t["Protocol"].str() ?: "").lowercase() != "hls") continue
            out += "add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=${plexContainer(t["Container"].str())}&videoCodec=${t["VideoCodec"].str() ?: "h264"}&audioCodec=${t["AudioCodec"].str() ?: "aac"})"
        }
        return out.joinToString("+")
    }

    // The height cap a profile carries, 0 for none.
    private fun maxHeightOf(p: JsonElement?): Double {
        for (c in p["CodecProfiles"].list()) for (k in c["Conditions"].list()) {
            if (k["Property"].str() == "Height" && k["Condition"].str() == "LessThanEqual") return orZero(k["Value"].jsNumber())
        }
        return 0.0
    }

    // An image subtitle the player cannot draw, or one in a stream the server must transcode, is burned in (#1398).
    private fun burnIn(codec: String?, p: JsonElement?, directStream: Boolean): Boolean {
        val c = (codec ?: "").lowercase()
        if (c !in IMAGE_SUBS) return false
        if (!directStream) return true
        return p["SubtitleProfiles"].list().none { s -> (s["Format"].str() ?: "").lowercase() == c && (s["Method"].str() == "Embed" || s["Method"].str() == "External") }
    }

    data class Request(val query: Map<String, String>, val profile: String, val mediaIndex: Int, val partStartMs: Long? = null) {
        fun toJson(): JsonObject {
            val out = obj()
            out["query"] = query.toJson()
            out["profile"] = js(profile)
            out["mediaIndex"] = jn(mediaIndex.toLong())
            partStartMs?.let { out["partStartMs"] = jn(it) }
            return out.json()
        }

        companion object {
            fun fromJson(e: JsonElement?) = Request(
                (e["query"] as? JsonObject).toQuery(), e["profile"].str() ?: "", e["mediaIndex"].jsNumber().let { if (it.isNaN()) 0 else it.toInt() },
                e["partStartMs"].num()?.toLong(),
            )
        }
    }

    // The decision for item [id] (its full metadata [meta]), session [session], client [clientId] (rides in the
    // query: the player fetches start.m3u8 with the token header only). [capKbps] overrides the bitrate (the remote
    // cap retry). [body]: PlaybackInfo's query and body, merged.
    fun decisionRequest(id: String, meta: JsonElement?, body: JsonElement?, session: String, clientId: String, capKbps: Int? = null): Request {
        val profile = body["DeviceProfile"] ?: JsonObject(emptyMap())
        val sources = PlexMap.toMediaSources(meta)
        val wanted = body["MediaSourceId"]?.takeIf { it.isStr() }?.str()
        val index = maxOf(0, sources.indexOfFirst { it["Id"].str() == wanted && wanted != null })
        val source = sources.getOrNull(index)
        val directPlay = !body["EnableDirectPlay"].isFalse()
        val directStream = !body["EnableDirectStream"].isFalse() && !body["AllowVideoStreamCopy"].isFalse()
        val startMs = PlexMap.ticksToMs(body["StartTimeTicks"])
        val part = partAt(meta, source["Id"].str(), startMs)
        val q = linkedMapOf(
            "path" to "/library/metadata/${PlexQuery.itemKey(id)}",
            "mediaIndex" to "$index",
            "partIndex" to "${part.first}",
            "protocol" to "hls",
            "directPlay" to if (directPlay) "1" else "0",
            "directStream" to if (directStream) "1" else "0",
            "directStreamAudio" to "1",
            "session" to session,
            "offset" to jsNumberText(floor((startMs - part.second) / 1000.0)),
            "hasMDE" to "1",
            "fastSeek" to "1",
            "X-Plex-Client-Identifier" to clientId,
        )
        val audio = body["AudioStreamIndex"]?.num()
        if (audio != null && audio >= 0) q["audioStreamID"] = jsNumberText(audio)
        val sub = body["SubtitleStreamIndex"]?.num()
        if (sub != null) q["subtitleStreamID"] = if (sub >= 0) jsNumberText(sub) else "0"
        val subCodec = if (sub != null && sub >= 0) source["MediaStreams"].list().firstOrNull { it["Type"].str() == "Subtitle" && it["Index"].num() == sub }?.get("Codec").str() else null
        q["subtitles"] = if (burnIn(subCodec, profile, directPlay && directStream)) "burn" else "auto"
        val bps = if (capKbps != null && capKbps != 0) capKbps * 1000.0 else orZero(body["MaxStreamingBitrate"].jsNumber())
        if (bps > 0 && bps < ORIGINAL_BPS) q["maxVideoBitrate"] = jsNumberText(floor(bps / 1000))
        val height = maxHeightOf(profile)
        if (height != 0.0 && !height.isNaN()) q["videoResolution"] = "${jsNumberText(jsRound(height * 16 / 9))}x${jsNumberText(height)}"
        return Request(q, profileExtra(profile), index, part.second.takeIf { it != 0L })
    }

    private fun mediaOf(meta: JsonElement?, mediaSourceId: String?): JsonElement? =
        meta["Media"].list().firstOrNull { mediaSourceId != null && it["id"].str() == mediaSourceId }
            ?: meta["Media"].list().firstOrNull { m -> m["Part"].list().any { !it["exists"].isFalse() } }

    private fun playableParts(media: JsonElement?) = media["Part"].list().filter { it["key"].truthy() && !it["exists"].isFalse() && !it["accessible"].isFalse() }

    // D-4: the part of a multi-part Media that [ms] falls in (its index in Media.Part, as PMS counts) and where it
    // starts. Part 0 at 0 for a single part, or when a duration is missing.
    fun partAt(meta: JsonElement?, mediaSourceId: String?, ms: Long): Pair<Int, Long> {
        val media = mediaOf(meta, mediaSourceId)
        val all = media["Part"].list()
        val playable = playableParts(media)
        val w = if (playable.size > 1) partWindow(playable.map { it["duration"].num()?.toLong() }, ms) else null
        return if (w != null) all.indexOf(playable[w.index]) to w.startMs else maxOf(0, playable.firstOrNull()?.let { all.indexOf(it) } ?: -1) to 0L
    }

    data class Window(val index: Int, val startMs: Long, val endMs: Long? = null)

    // The part of a multi-part film that [ms] falls in: its index, start and end in the film (no end for the last
    // part). Null when a part has no duration: nothing to place it with.
    fun partWindow(durations: List<Long?>, ms: Long): Window? {
        if (durations.isEmpty() || durations.any { it == null || it == 0L }) return null
        var start = 0L
        for (i in 0 until durations.size - 1) {
            val end = start + durations[i]!!
            if (ms < end) return Window(i, start, end)
            start = end
        }
        return Window(durations.size - 1, start)
    }

    // The decision answer → PlaybackInfo: the chosen source, direct play through the part, else start.m3u8 (with
    // StartTimeTicks: the stream starts at the offset, so the player must not seek there). An answer that plays
    // nothing → ErrorCode (its text, from PMS).
    fun toPlaybackInfo(answer: JsonElement?, meta: JsonElement?, req: Request): JsonObject {
        val session = req.query["session"]
        val code = orZero(answer["generalDecisionCode"]?.jsNumber() ?: 0.0)
        val part = answer["Metadata"].list().firstOrNull()["Media"].list().firstOrNull()["Part"].list().firstOrNull()
        val source = PlexMap.toMediaSources(meta).getOrNull(req.mediaIndex)
        if (source == null || code >= 2000 || !part["decision"].truthy()) {
            val text = answer["generalDecisionText"].takeIf { it.truthy() }?.str() ?: answer["transcodeDecisionText"].takeIf { it.truthy() }?.str()
                ?: "Plex decision ${if (code != 0.0) jsNumberText(code) else "empty"}"
            val out = obj()
            out["MediaSources"] = jarr(emptyList())
            session?.let { out["PlaySessionId"] = js(it) }
            out["ErrorCode"] = js(text)
            return out.json()
        }
        val direct = part["decision"].str() == "directplay"
        val out = LinkedHashMap<String, JsonElement>(source)
        out["SupportsDirectPlay"] = jb(direct)
        out["SupportsDirectStream"] = jb(direct)
        out["SupportsTranscoding"] = jb(true)
        // A multi-part film (D-4): every part, for a player that plays them one after the other.
        val parts = partPaths(meta, source["Id"].str())
        if (parts.size > 1) out["PartPaths"] = jarr(parts)
        // shortcut: the BIF of a single-part file only (each part has its own); a multi-part film shows no previews.
        else if (PlexMap.playablePart(meta, source["Id"].str())["indexes"].str() == "sd") out["Bif"] = jb(true)
        if (!direct) {
            val client = req.query["X-Plex-Client-Identifier"]
            val qs = LinkedHashMap(req.query - "X-Plex-Client-Identifier")
            qs["X-Plex-Client-Identifier"] = client ?: "undefined"
            qs["X-Plex-Client-Profile-Extra"] = req.profile
            out["TranscodingUrl"] = js("/video/:/transcode/universal/start.m3u8?${formEncode(qs)}")
            out["TranscodingSubProtocol"] = js("hls")
            val offset = (req.partStartMs ?: 0) + jsNumber(req.query["offset"]) * 1000
            if (offset > 0) out["StartTimeTicks"] = jn(jsRound(offset * PlexMap.TICKS_PER_MS))
            // A burned subtitle is part of the picture (playback keeps it selected).
            if (req.query["subtitles"] == "burn") out["MediaStreams"] = jarr(out["MediaStreams"].list().map { s ->
                if (s["Type"].str() == "Subtitle" && s["Index"].str() == req.query["subtitleStreamID"]) JsonObject((s as JsonObject) + ("DeliveryMethod" to js("Encode"))) else s
            })
        }
        val result = obj()
        result["MediaSources"] = jarr(listOf(JsonObject(out)))
        session?.let { result["PlaySessionId"] = js(it) }
        return result.json()
    }

    // Why a decision failed, for the message (§9): remote playback needs a pass (403), or the server's remote cap is
    // below the request (500 "Cannot make a decision": retry at the cap, then lowerQuality).
    private val CANNOT = Regex("cannot make a decision", RegexOption.IGNORE_CASE)

    fun decisionFailure(status: Int, text: String): String? = when {
        status == 403 -> "remoteNeedsPass"
        status == 500 && CANNOT.containsMatchIn(text) -> "lowerQuality"
        else -> null
    }

    // The owner's remote cap (/:/prefs WanPerStreamMaxUploadRate, kbps; 0 = none).
    fun remoteCapKbps(prefs: JsonElement?): Int {
        val v = prefs["Setting"].list().firstOrNull { it["id"].str() == "WanPerStreamMaxUploadRate" }?.get("value").jsNumber()
        return if (v.isFinite() && v > 0) floor(v).toInt() else 0
    }

    // The tracks picked on a manual change, when they differ from what the part has selected: PUT
    // /library/parts/{id}?audioStreamID=&subtitleStreamID=&allParts=1, so PMS remembers them per show (#1326).
    fun trackPut(meta: JsonElement?, mediaSourceId: String?, audio: Int?, subtitle: Int?): Pair<String, Map<String, String>>? {
        val media = meta["Media"].list().firstOrNull { mediaSourceId != null && it["id"].str() == mediaSourceId } ?: meta["Media"].list().firstOrNull()
        val part = media["Part"].list().firstOrNull { !it["exists"].isFalse() && !it["accessible"].isFalse() } ?: return null
        val streams = part["Stream"].list()
        fun selected(type: Int) = streams.firstOrNull { it["streamType"].num() == type.toDouble() && it["selected"].truthy() }?.get("id").num()
        fun has(id: Int, type: Int) = streams.any { it["id"].num() == id.toDouble() && it["streamType"].num() == type.toDouble() }
        val q = LinkedHashMap<String, String>()
        if (audio != null && audio >= 0 && audio.toDouble() != selected(2) && has(audio, 2)) q["audioStreamID"] = "$audio"
        if (subtitle != null) {
            val want = if (subtitle >= 0) subtitle else 0
            if (want.toDouble() != (selected(3) ?: 0.0) && (want == 0 || has(want, 3))) q["subtitleStreamID"] = "$want"
        }
        if (q.isEmpty()) return null
        q["allParts"] = "1"
        return "/library/parts/${part["id"].str()}" to q
    }

    // The parts of a multi-part Media, in order, for one queue under one ratingKey (D-4).
    fun partPaths(meta: JsonElement?, mediaSourceId: String?): List<JsonObject> = playableParts(mediaOf(meta, mediaSourceId)).map { p ->
        val out = obj()
        out["path"] = p["key"]!!
        p["duration"]?.let { out["durationMs"] = it }
        out.json()
    }
}
