package com.wika.wicaby.core.livetv

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Live TV request builders per server (spec §5): one pure function per operation returns the method,
// path, query and body; the platform HTTP layer (LiveTvApi.kt, C-3) only executes it. An operation a
// server does not have returns null. Mirrors D/shared/livetv/dialect.ts (golden vectors: dialect.json).

@Serializable
data class Req(
    /** GET, POST or DELETE. */
    val method: String,
    val path: String,
    /** Insertion order is the URL order. */
    val query: Map<String, String>,
    val body: JsonElement? = null,
) {
    /** path + query as a URL tail (keys in insertion order, values encoded). */
    fun toUrl(): String {
        if (query.isEmpty()) return path
        return path + "?" + query.entries.joinToString("&") { (k, v) -> encodeUriComponent(k) + "=" + encodeUriComponent(v) }
    }
}

/** encodeURIComponent: UTF-8, everything but A–Z a–z 0–9 - _ . ! ~ * ' ( ) percent-encoded. */
fun encodeUriComponent(s: String): String {
    val sb = StringBuilder(s.length)
    for (b in s.toByteArray(Charsets.UTF_8)) {
        val c = b.toInt() and 0xFF
        val ch = c.toChar()
        if (ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch in "-_.!~*'()") {
            sb.append(ch)
        } else {
            sb.append('%').append("0123456789ABCDEF"[c shr 4]).append("0123456789ABCDEF"[c and 0xF])
        }
    }
    return sb.toString()
}

/** Date.prototype.toISOString of epoch ms (the query dates). */
fun isoUtc(t: Long): String = Civil.isoUtc(t)

private val ENC = ::encodeUriComponent

object Dialect {
    private const val HOUR = 3_600_000L

    private fun req(method: String, path: String, vararg query: Pair<String, Any?>, body: JsonElement? = null): Req {
        val q = LinkedHashMap<String, String>()
        for ((k, v) in query) {
            when (v) {
                null -> {}
                is Map<*, *> -> v.forEach { (kk, vv) -> if (vv != null) q[kk.toString()] = vv.toString() }
                is Double -> q[k] = jsNumberString(v)
                else -> q[k] = v.toString()
            }
        }
        return Req(method, path, q, body)
    }

    private val CATEGORY_PARAM = mapOf(
        Category.MOVIES to "IsMovie", Category.SPORTS to "IsSports", Category.NEWS to "IsNews",
        Category.KIDS to "IsKids", Category.SERIES to "IsSeries",
    )

    /** The query flag for a category ({} for none), or null ("Inédits" is Emby-only: IsNewOrPremiere). */
    private fun categoryFlag(kind: ServerKind, cat: Category?): Map<String, String>? {
        if (cat == null) return emptyMap()
        if (cat == Category.NEW) return if (kind == ServerKind.EMBY) mapOf("IsNewOrPremiere" to "true") else null
        return mapOf(CATEGORY_PARAM.getValue(cat) to "true")
    }

    // A spread of a flag map inside a query (its own keys, in order).
    private fun spread(m: Map<String, String>): Pair<String, Any?> = "" to m

    private fun userKeys(kind: ServerKind) = if (kind == ServerKind.EMBY) "UserId" to "Client" else "userId" to "client"

    // ---- Reads (§5.1) ----

    fun info(@Suppress("UNUSED_PARAMETER") kind: ServerKind): Req = req("GET", "/LiveTv/Info")
    fun guideInfo(@Suppress("UNUSED_PARAMETER") kind: ServerKind): Req = req("GET", "/LiveTv/GuideInfo")

    fun channelsPage(kind: ServerKind, userId: String, startIndex: Int, limit: Int): Req = req(
        "GET", "/LiveTv/Channels",
        "UserId" to userId,
        "StartIndex" to startIndex,
        "Limit" to limit,
        "EnableTotalRecordCount" to (startIndex == 0),
        "EnableImageTypes" to "Primary",
        "ImageTypeLimit" to 1,
        "EnableUserData" to true,
        "AddCurrentProgram" to false,
        "Fields" to (if (kind == ServerKind.EMBY) "Tags" else null),
    )

    fun channelCategorySet(kind: ServerKind, userId: String, category: Category): Req? {
        val flag = categoryFlag(kind, category) ?: return null
        return req("GET", "/LiveTv/Channels", "UserId" to userId, spread(flag), "EnableImages" to false, "EnableUserData" to false, "Limit" to 5000)
    }

    fun channelTags(kind: ServerKind, userId: String): Req? =
        if (kind == ServerKind.EMBY) req("GET", "/LiveTv/ChannelTags", "UserId" to userId) else null

    /** Never MinStartDate: it loses the programme airing at the slab start. */
    fun programsTile(@Suppress("UNUSED_PARAMETER") kind: ServerKind, userId: String, channelIds: List<String>, from: Long, to: Long, genres: Boolean = false): Req = req(
        "GET", "/LiveTv/Programs",
        "UserId" to userId,
        "ChannelIds" to channelIds.joinToString(","),
        "MinEndDate" to isoUtc(from),
        "MaxStartDate" to isoUtc(to),
        "SortBy" to "StartDate",
        "EnableImages" to false,
        "EnableUserData" to false,
        "EnableTotalRecordCount" to false,
        "Fields" to (if (genres) "Genres" else null),
    )

    fun programNowNext(@Suppress("UNUSED_PARAMETER") kind: ServerKind, userId: String, channelId: String, now: Long): Req = req(
        "GET", "/LiveTv/Programs",
        "UserId" to userId, "ChannelIds" to channelId, "MinEndDate" to isoUtc(now), "MaxStartDate" to isoUtc(now + 8 * HOUR),
        "SortBy" to "StartDate", "Limit" to 4, "EnableImages" to false,
    )

    fun programDetail(kind: ServerKind, userId: String, id: String): Req =
        req("GET", "/LiveTv/Programs/${ENC(id)}", (if (kind == ServerKind.EMBY) "UserId" else "userId") to userId)

    /** "En ce moment" rails. WINDOW is the V15 fallback when Emby ignores IsAiring. */
    fun onNow(kind: ServerKind, userId: String, now: Long, category: Category? = null, source: OnNowSource? = null): Req? {
        val flag = categoryFlag(kind, category) ?: return null
        val images = arrayOf<Pair<String, Any?>>("EnableImageTypes" to "Primary,Thumb", "ImageTypeLimit" to 1, "Fields" to "Genres")
        if (source == OnNowSource.WINDOW) {
            return req(
                "GET", "/LiveTv/Programs",
                "UserId" to userId, "MinEndDate" to isoUtc(now), "MaxStartDate" to isoUtc(now), "SortBy" to "StartDate", "Limit" to 24,
                *images, spread(flag),
            )
        }
        return req("GET", "/LiveTv/Programs/Recommended", "UserId" to userId, "IsAiring" to true, "Limit" to 24, *images, spread(flag))
    }

    fun onLater(kind: ServerKind, userId: String, now: Long, category: Category): Req? {
        val flag = categoryFlag(kind, category) ?: return null
        return req(
            "GET", "/LiveTv/Programs",
            "UserId" to userId, spread(flag), "MinStartDate" to isoUtc(now), "MaxStartDate" to isoUtc(now + 48 * HOUR), "SortBy" to "StartDate", "Limit" to 24,
        )
    }

    fun searchPrograms(kind: ServerKind, userId: String, query: String, now: Long, guideEnd: Long): Req {
        if (kind == ServerKind.JELLYFIN) {
            return req("GET", "/Items", "UserId" to userId, "IncludeItemTypes" to "LiveTvProgram", "Recursive" to true, "SearchTerm" to query, "Limit" to 30, "Fields" to "ChannelInfo")
        }
        return req(
            "GET", "/LiveTv/Programs",
            "UserId" to userId, "SearchTerm" to query, "MinEndDate" to isoUtc(now - HOUR), "MaxStartDate" to isoUtc(guideEnd),
            "SortBy" to "StartDate", "Limit" to 30, "EnableImages" to false,
        )
    }

    /**
     * Other airings of a programme, now − 1 h to now + 48 h. Emby: SearchTerm (the caller keeps exact
     * folded name matches). Jellyfin: by series ids, else null (memory search).
     */
    fun otherAirings(kind: ServerKind, userId: String, name: String, now: Long, seriesTimerId: String? = null, librarySeriesId: String? = null): Req? {
        val win = arrayOf<Pair<String, Any?>>(
            "MinEndDate" to isoUtc(now - HOUR), "MaxStartDate" to isoUtc(now + 48 * HOUR), "SortBy" to "StartDate", "Limit" to 50, "EnableImages" to false,
        )
        return when {
            kind == ServerKind.EMBY -> req("GET", "/LiveTv/Programs", "UserId" to userId, "SearchTerm" to name, *win)
            !librarySeriesId.isNullOrEmpty() -> req("GET", "/LiveTv/Programs", "UserId" to userId, "LibrarySeriesId" to librarySeriesId, *win)
            !seriesTimerId.isNullOrEmpty() -> req("GET", "/LiveTv/Programs", "UserId" to userId, "SeriesTimerId" to seriesTimerId, *win)
            else -> null
        }
    }

    fun timers(@Suppress("UNUSED_PARAMETER") kind: ServerKind): Req = req("GET", "/LiveTv/Timers")
    fun timersOfRule(@Suppress("UNUSED_PARAMETER") kind: ServerKind, id: String): Req = req("GET", "/LiveTv/Timers", "SeriesTimerId" to id)
    fun seriesTimers(@Suppress("UNUSED_PARAMETER") kind: ServerKind): Req = req("GET", "/LiveTv/SeriesTimers")
    fun seriesTimer(@Suppress("UNUSED_PARAMETER") kind: ServerKind, id: String): Req = req("GET", "/LiveTv/SeriesTimers/${ENC(id)}")
    fun timerDefaults(@Suppress("UNUSED_PARAMETER") kind: ServerKind, programId: String): Req = req("GET", "/LiveTv/Timers/Defaults", "ProgramId" to programId)

    fun recordingOptions(kind: ServerKind, userId: String): Req =
        if (kind == ServerKind.EMBY) req("GET", "/LiveTv/AvailableRecordingOptions") else req("GET", "/LiveTv/Recordings/Folders", "userId" to userId)

    fun recordings(@Suppress("UNUSED_PARAMETER") kind: ServerKind, userId: String, startIndex: Int = 0, limit: Int = 500, inProgress: Boolean = false): Req = req(
        "GET", "/LiveTv/Recordings",
        "UserId" to userId,
        "Fields" to "Overview,PrimaryImageAspectRatio,DateCreated",
        "EnableImageTypes" to "Primary,Thumb",
        "ImageTypeLimit" to 1,
        "StartIndex" to startIndex,
        "Limit" to limit,
        "IsInProgress" to (if (inProgress) true else null),
    )

    /** Never client=emby. */
    fun displayPrefs(kind: ServerKind, userId: String): Req {
        val (u, c) = userKeys(kind)
        return req("GET", "/DisplayPreferences/$PREFS_ID", u to userId, c to PREFS_CLIENT)
    }

    // ---- Writes (§5.2) ----

    fun setFavorite(kind: ServerKind, userId: String, id: String, favorite: Boolean): Req {
        val method = if (favorite) "POST" else "DELETE"
        return if (kind == ServerKind.EMBY) {
            req(method, "/Users/${ENC(userId)}/FavoriteItems/${ENC(id)}")
        } else {
            req(method, "/UserFavoriteItems/${ENC(id)}", "userId" to userId)
        }
    }

    fun createTimer(@Suppress("UNUSED_PARAMETER") kind: ServerKind, body: JsonElement): Req = req("POST", "/LiveTv/Timers", body = body)
    fun updateTimer(@Suppress("UNUSED_PARAMETER") kind: ServerKind, id: String, body: JsonElement): Req = req("POST", "/LiveTv/Timers/${ENC(id)}", body = body)
    fun cancelTimer(@Suppress("UNUSED_PARAMETER") kind: ServerKind, id: String): Req = req("DELETE", "/LiveTv/Timers/${ENC(id)}")
    fun createSeriesTimer(@Suppress("UNUSED_PARAMETER") kind: ServerKind, body: JsonElement): Req = req("POST", "/LiveTv/SeriesTimers", body = body)
    fun updateSeriesTimer(@Suppress("UNUSED_PARAMETER") kind: ServerKind, id: String, body: JsonElement): Req = req("POST", "/LiveTv/SeriesTimers/${ENC(id)}", body = body)
    fun deleteSeriesTimer(@Suppress("UNUSED_PARAMETER") kind: ServerKind, id: String): Req = req("DELETE", "/LiveTv/SeriesTimers/${ENC(id)}")
    fun deleteRecording(@Suppress("UNUSED_PARAMETER") kind: ServerKind, id: String): Req = req("DELETE", "/LiveTv/Recordings/${ENC(id)}")

    /** Jellyfin fallback after a 404/405 on deleteRecording. */
    fun deleteItem(@Suppress("UNUSED_PARAMETER") kind: ServerKind, id: String): Req = req("DELETE", "/Items/${ENC(id)}")

    /** The body must carry Id and Client (Emby reads the client from the DTO); see PrefsCodec.prefsBody. */
    fun saveDisplayPrefs(kind: ServerKind, userId: String, body: JsonObject): Req {
        val b = LinkedHashMap<String, JsonElement>(body)
        b["Id"] = JsonPrimitive(PREFS_ID)
        b["Client"] = JsonPrimitive(PREFS_CLIENT)
        val (u, c) = userKeys(kind)
        return req("POST", "/DisplayPreferences/$PREFS_ID", u to userId, c to PREFS_CLIENT, body = JsonObject(b))
    }

    // ---- Streams (§5.3) ----

    /**
     * [maxBitrate] is always sent (a posted profile otherwise caps at 8 Mbps). [rung]: 0 everything,
     * 1 server remux, 2 full transcode. [autoOpen] is false for probes, pre-fetch and the banner.
     */
    fun tune(
        @Suppress("UNUSED_PARAMETER") kind: ServerKind,
        userId: String,
        channelId: String,
        maxBitrate: Long,
        rung: Int,
        deviceProfile: JsonElement? = null,
        autoOpen: Boolean = true,
    ): Req {
        val body = linkedMapOf<String, JsonElement>(
            "DeviceProfile" to (deviceProfile ?: JsonObject(emptyMap())),
            "EnableDirectPlay" to JsonPrimitive(rung == 0),
            "EnableDirectStream" to JsonPrimitive(true),
            "EnableTranscoding" to JsonPrimitive(true),
        )
        if (rung == 2) {
            body["AllowVideoStreamCopy"] = JsonPrimitive(false)
            body["AllowAudioStreamCopy"] = JsonPrimitive(false)
        }
        return req(
            "POST", "/Items/${ENC(channelId)}/PlaybackInfo",
            "UserId" to userId, "IsPlayback" to true, "AutoOpenLiveStream" to autoOpen, "MaxStreamingBitrate" to maxBitrate, "StartTimeTicks" to 0,
            body = JsonObject(body),
        )
    }

    /** Only when RequiresOpening && !LiveStreamId. Ids go in the query and in the body on both servers. */
    fun open(
        @Suppress("UNUSED_PARAMETER") kind: ServerKind,
        userId: String,
        itemId: String,
        playSessionId: String,
        maxBitrate: Long,
        openToken: String,
        deviceProfile: JsonElement? = null,
    ): Req = req(
        "POST", "/LiveStreams/Open",
        "UserId" to userId, "ItemId" to itemId, "PlaySessionId" to playSessionId, "MaxStreamingBitrate" to maxBitrate, "OpenToken" to openToken,
        body = JsonObject(
            linkedMapOf(
                "OpenToken" to JsonPrimitive(openToken),
                "DeviceProfile" to (deviceProfile ?: JsonObject(emptyMap())),
                "UserId" to JsonPrimitive(userId),
                "ItemId" to JsonPrimitive(itemId),
                "PlaySessionId" to JsonPrimitive(playSessionId),
                "MaxStreamingBitrate" to JsonPrimitive(maxBitrate),
            ),
        ),
    )

    /** Query string only (a body gives 400). */
    fun close(@Suppress("UNUSED_PARAMETER") kind: ServerKind, liveStreamId: String, playSessionId: String): Req =
        req("POST", "/LiveStreams/Close", "LiveStreamId" to liveStreamId, "PlaySessionId" to playSessionId)

    fun killEncodes(@Suppress("UNUSED_PARAMETER") kind: ServerKind, deviceId: String, playSessionId: String): Req =
        req("DELETE", "/Videos/ActiveEncodings", "DeviceId" to deviceId, "PlaySessionId" to playSessionId)

    fun staticStream(
        @Suppress("UNUSED_PARAMETER") kind: ServerKind,
        itemId: String,
        container: String,
        mediaSourceId: String,
        liveStreamId: String?,
        deviceId: String,
        playSessionId: String,
    ): Req = req(
        "GET", "/Videos/${ENC(itemId)}/stream.$container",
        "Static" to true, "MediaSourceId" to mediaSourceId, "LiveStreamId" to liveStreamId, "DeviceId" to deviceId, "PlaySessionId" to playSessionId,
    )

    enum class PlayMethod { DirectPlay, DirectStream, Transcode }

    private fun report(path: String, itemId: String, mediaSourceId: String, playSessionId: String, liveStreamId: String?, playMethod: PlayMethod, isPaused: Boolean): Req {
        val body = linkedMapOf<String, JsonElement>(
            "ItemId" to JsonPrimitive(itemId),
            "MediaSourceId" to JsonPrimitive(mediaSourceId),
            "PlaySessionId" to JsonPrimitive(playSessionId),
            "PlayMethod" to JsonPrimitive(playMethod.name),
            "IsPaused" to JsonPrimitive(isPaused),
        )
        if (!liveStreamId.isNullOrEmpty()) body["LiveStreamId"] = JsonPrimitive(liveStreamId)
        return req("POST", path, body = JsonObject(body))
    }

    fun reportPlaying(@Suppress("UNUSED_PARAMETER") kind: ServerKind, itemId: String, mediaSourceId: String, playSessionId: String, liveStreamId: String?, playMethod: PlayMethod, isPaused: Boolean = false): Req =
        report("/Sessions/Playing", itemId, mediaSourceId, playSessionId, liveStreamId, playMethod, isPaused)

    fun reportProgress(@Suppress("UNUSED_PARAMETER") kind: ServerKind, itemId: String, mediaSourceId: String, playSessionId: String, liveStreamId: String?, playMethod: PlayMethod, isPaused: Boolean = false): Req =
        report("/Sessions/Playing/Progress", itemId, mediaSourceId, playSessionId, liveStreamId, playMethod, isPaused)

    fun reportStopped(@Suppress("UNUSED_PARAMETER") kind: ServerKind, itemId: String, mediaSourceId: String, playSessionId: String, liveStreamId: String?, playMethod: PlayMethod, isPaused: Boolean = false): Req =
        report("/Sessions/Playing/Stopped", itemId, mediaSourceId, playSessionId, liveStreamId, playMethod, isPaused)
}
