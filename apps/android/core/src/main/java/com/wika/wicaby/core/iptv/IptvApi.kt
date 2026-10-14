package com.wika.wicaby.core.iptv

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.livetv.PF
import com.wika.wicaby.core.livetv.genreFlags
import com.wika.wicaby.core.livetv.isoUtc
import com.wika.wicaby.core.livetv.parseServerDate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.util.UUID

// The IPTV sources seen as a Live TV server (like FilesApi for file sources): the Emby-dialect /LiveTv calls of the
// Live TV screens, the channel's PlaybackInfo (a direct play of the playlist's stream URL) and the session reports are
// answered from Iptv's lineup and guide, so the guide grid, the channel list, the lenses (group-title is a channel tag),
// favourites, Récentes and the live player work unchanged. No recording, no catch-up: the DVR routes answer empty.
// An unknown route answers 404 IPTV-UNMAPPED.
class IptvApi : Api(Server(Iptv.SERVER_ID, "IPTV", "iptv:local", Iptv.KIND), "wicaby-iptv", null, USER) {
    override fun authHeaders(): Map<String, String> = emptyMap()

    // The static stream of a channel (pickPlay's /Videos/{id}/stream.ts) is the playlist's URL itself.
    override fun url(path: String, vararg query: Pair<String, Any?>): String =
        STREAM.find(path)?.let { Iptv.lineup().byId[it.groupValues[1]]?.channel?.url }.orEmpty()

    override fun resolve(u: String): String = u

    // Logos: the playlist's tvg-logo (http(s) or a data: image), whatever the tag.
    override fun image(id: String, type: String, tag: String?, maxWidth: Int?, maxHeight: Int?): String =
        Iptv.lineup().byId[id]?.channel?.logo.orEmpty()

    override suspend fun raw(method: String, path: String, body: String?, vararg query: Pair<String, Any?>): String =
        route(method, path, body, query.asList())

    override suspend fun <T> stream(method: String, path: String, body: String?, query: List<Pair<String, Any?>>, timeoutMs: Long, read: (Response) -> T): T {
        val text = route(method, path, body, query)
        return Response.Builder().request(Request.Builder().url("http://127.0.0.1/").build()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
            .body(text.toResponseBody(JSON)).build().use(read)
    }

    private fun arg(q: List<Pair<String, Any?>>, name: String): String? =
        q.firstOrNull { it.first.equals(name, ignoreCase = true) }?.second?.toString()?.ifEmpty { null }

    private suspend fun route(method: String, path: String, body: String?, q: List<Pair<String, Any?>>): String = withContext(Dispatchers.IO) {
        val p = path.substringBefore('?').removePrefix("/emby").replace(USERS, "").replace("/UserFavoriteItems/", "/FavoriteItems/").replace("/UserItems/", "/Items/")
        fun unmapped(): Nothing = throw ApiException("IPTV-UNMAPPED $method $p", 404)
        when (method) {
            "GET" -> when {
                p == "/LiveTv/Info" -> """{"IsEnabled":true,"Services":[]}"""
                p == "/LiveTv/Channels" -> {
                    Iptv.ensure()
                    // The category sets (§6.6) need programme flags per channel: none here.
                    if (CATEGORY_KEYS.any { arg(q, it) != null }) return@withContext EMPTY
                    val all = Iptv.lineup().entries
                    val start = (arg(q, "StartIndex")?.toIntOrNull() ?: 0).coerceIn(0, all.size)
                    val end = (start + (arg(q, "Limit")?.toIntOrNull() ?: all.size)).coerceIn(start, all.size)
                    items(all.subList(start, end).map(::channelDto), all.size)
                }
                p == "/LiveTv/ChannelTags" -> {
                    Iptv.ensure()
                    items(Iptv.lineup().entries.mapNotNull { it.channel.group }.distinct().map { buildJsonObject { put("Name", it); put("Id", it) } })
                }
                p == "/LiveTv/Programs/Recommended" -> programs(q, airing = true)
                p == "/LiveTv/Programs" -> programs(q, airing = arg(q, "IsAiring") == "true")
                p.startsWith("/LiveTv/Programs/") -> program(p.removePrefix("/LiveTv/Programs/")) ?: unmapped()
                p == "/LiveTv/GuideInfo" -> buildJsonObject { val now = System.currentTimeMillis(); put("StartDate", isoUtc(now - 6 * HOUR)); put("EndDate", isoUtc(now + 7 * DAY)) }.toString()
                p in EMPTY_LISTS || p.startsWith("/LiveTv/SeriesTimers/") -> EMPTY
                p.startsWith("/DisplayPreferences/") -> (Iptv.current.prefs ?: buildJsonObject { put("Id", p.substringAfterLast('/')); putJsonObject("CustomPrefs") {} }).toString()
                p.startsWith("/Items/") && p.count { it == '/' } == 2 -> {
                    Iptv.ensure()
                    // A channel, or a programme (the player's detail panel asks for its overview this way).
                    val id = p.removePrefix("/Items/")
                    Iptv.lineup().byId[id]?.let(::channelDto)?.toString() ?: program(id) ?: unmapped()
                }
                else -> unmapped()
            }
            "POST" -> when {
                p.startsWith("/Items/") && p.endsWith("/PlaybackInfo") -> playbackInfo(p.removePrefix("/Items/").removeSuffix("/PlaybackInfo"))
                p.startsWith("/FavoriteItems/") -> favorite(p.removePrefix("/FavoriteItems/"), true)
                p.startsWith("/DisplayPreferences/") -> {
                    val doc = body?.let { runCatching { com.wika.wicaby.core.data.json.parseToJsonElement(it).jsonObject }.getOrNull() } ?: throw ApiException("bad body", 400)
                    Iptv.updateState { IptvState(it.favorites, it.played, doc) }
                    ""
                }
                p == "/Sessions/Playing" -> {
                    // Récentes is seeded from LastPlayedDate, as a server would.
                    val id = body?.let { runCatching { com.wika.wicaby.core.data.json.parseToJsonElement(it).jsonObject["ItemId"]?.jsonPrimitive?.content }.getOrNull() }
                    if (id != null && Iptv.lineup().byId.containsKey(id)) Iptv.updateState { IptvState(it.favorites, (it.played + (id to System.currentTimeMillis())).entries.sortedByDescending { e -> e.value }.take(50).associate { e -> e.key to e.value }, it.prefs) }
                    ""
                }
                p.startsWith("/Sessions/Playing") || p == "/LiveStreams/Close" -> ""
                else -> unmapped()
            }
            "DELETE" -> when {
                p.startsWith("/FavoriteItems/") -> favorite(p.removePrefix("/FavoriteItems/"), false)
                p == "/Videos/ActiveEncodings" -> ""
                else -> unmapped()
            }
            else -> unmapped()
        }
    }

    private fun items(list: List<JsonObject>, total: Int = list.size) = buildJsonObject {
        put("Items", JsonArray(list))
        put("TotalRecordCount", total)
    }.toString()

    private fun channelDto(e: IptvEntry): JsonObject {
        val c = e.channel
        val st = Iptv.current
        return buildJsonObject {
            put("Id", e.id)
            put("Name", c.name)
            put("Type", "TvChannel")
            put("ChannelType", if (c.radio == true) "Radio" else "TV")
            put("MediaType", if (c.radio == true) "Audio" else "Video")
            put("ChannelNumber", c.number)
            c.logo?.let { putJsonObject("ImageTags") { put("Primary", stableId(it)) } }
            putJsonArray("Tags") { c.group?.let { add(JsonPrimitive(it)) } }
            putJsonObject("UserData") {
                put("IsFavorite", e.id in st.favorites)
                st.played[e.id]?.let { put("LastPlayedDate", isoUtc(it)) }
            }
        }
    }

    private fun favorite(id: String, on: Boolean): String {
        if (!Iptv.lineup().byId.containsKey(id)) throw ApiException("IPTV-UNKNOWN", 404)
        Iptv.updateState { IptvState(if (on) it.favorites - id + id else it.favorites - id, it.played, it.prefs) }
        return buildJsonObject { put("IsFavorite", on) }.toString()
    }

    private fun programDto(e: IptvEntry, p: GuideProgramme, detail: Boolean): JsonObject = buildJsonObject {
        put("Id", "${e.id}_${p.start}")
        put("ChannelId", e.id)
        put("ChannelName", e.channel.name)
        put("ChannelNumber", e.channel.number)
        put("Type", "Program")
        put("StartDate", isoUtc(p.start))
        put("EndDate", isoUtc(p.stop))
        put("Name", p.title)
        p.subTitle?.let { put("EpisodeTitle", it) }
        if (detail) p.desc?.let { put("Overview", it) }
        p.categories?.let { cs -> putJsonArray("Genres") { cs.forEach { add(JsonPrimitive(it)) } } }
        p.episode?.let { EPISODE.find(it) }?.let { m ->
            put("ParentIndexNumber", m.groupValues[1].toInt())
            put("IndexNumber", m.groupValues[2].toInt())
        }
        val f = p.categories?.let(::genreFlags) ?: 0
        for ((key, bit) in FLAG_KEYS) if (f and bit != 0) put(key, true)
    }

    private fun program(id: String): String? {
        val cut = id.lastIndexOf('_').takeIf { it > 0 } ?: return null
        val start = id.substring(cut + 1).toLongOrNull() ?: return null
        val l = Iptv.lineup()
        val e = l.byId[id.substring(0, cut)] ?: return null
        val p = l.guide[e.id]?.firstOrNull { it.start == start } ?: return null
        return programDto(e, p, detail = true).toString()
    }

    // /LiveTv/Programs (tiles, now/next, search, categories) and /Programs/Recommended (on now), from the guide in memory.
    private suspend fun programs(q: List<Pair<String, Any?>>, airing: Boolean): String {
        Iptv.ensure()
        val l = Iptv.lineup()
        val now = System.currentTimeMillis()
        // "Inédits" has no XMLTV equivalent here (no <new/> kept): empty, like Jellyfin.
        if (arg(q, "IsNewOrPremiere") != null) return EMPTY
        val bit = FLAG_KEYS.firstOrNull { arg(q, it.first) == "true" }?.second ?: 0
        val minEnd = if (airing) now else arg(q, "MinEndDate")?.let(::parseServerDate)
        val maxStart = if (airing) now else arg(q, "MaxStartDate")?.let(::parseServerDate)
        val minStart = arg(q, "MinStartDate")?.let(::parseServerDate)
        val term = arg(q, "SearchTerm")?.let(::fold)
        val limit = arg(q, "Limit")?.toIntOrNull()?.coerceAtLeast(0) ?: Int.MAX_VALUE
        val ids = arg(q, "ChannelIds")?.split(',')
        val out = ArrayList<Pair<IptvEntry, GuideProgramme>>()
        for (e in ids?.mapNotNull { l.byId[it] } ?: l.entries) {
            val list = l.guide[e.id] ?: continue
            var i = if (minEnd == null) 0 else firstEndingAfter(list, minEnd)
            while (i < list.size) {
                val p = list[i++]
                if (maxStart != null && p.start > maxStart) break
                if (airing && p.start > now) break
                if (minStart != null && p.start < minStart) continue
                if (term != null && !fold(p.title).contains(term)) continue
                if (bit != 0 && (p.categories?.let(::genreFlags) ?: 0) and bit == 0) continue
                out += e to p
            }
        }
        out.sortBy { it.second.start }
        return items(out.take(limit).map { (e, p) -> programDto(e, p, detail = false) }, out.size)
    }

    // First programme with stop > t (the list is sorted and has no overlap).
    private fun firstEndingAfter(list: List<GuideProgramme>, t: Long): Int {
        var lo = 0
        var hi = list.size
        while (lo < hi) {
            val mid = (lo + hi) ushr 1
            if (list[mid].stop > t) hi = mid else lo = mid + 1
        }
        return lo
    }

    // A direct play of the playlist's URL (no server between, no transcoding); its EXTVLCOPT headers go with it.
    private suspend fun playbackInfo(id: String): String {
        Iptv.ensure()
        val e = Iptv.lineup().byId[id] ?: throw ApiException("IPTV-UNKNOWN", 404)
        val c = e.channel
        IptvHeaders.use(c.url, c.userAgent, c.referrer)
        return buildJsonObject {
            putJsonArray("MediaSources") {
                add(
                    buildJsonObject {
                        put("Id", e.id)
                        put("Name", c.name)
                        put("Protocol", "Http")
                        put("Container", "ts")
                        put("IsInfiniteStream", true)
                        put("SupportsDirectPlay", true)
                        put("SupportsDirectStream", true)
                        put("SupportsTranscoding", false)
                        putJsonArray("MediaStreams") {
                            if (c.radio != true) add(buildJsonObject { put("Type", "Video"); put("Index", 0) })
                            add(buildJsonObject { put("Type", "Audio"); put("Index", 1) })
                        }
                    },
                )
            }
            put("PlaySessionId", UUID.randomUUID().toString().replace("-", ""))
        }.toString()
    }

    companion object {
        const val USER = "iptv"
        private const val HOUR = 3_600_000L
        private const val DAY = 24 * HOUR
        private val JSON = "application/json".toMediaType()
        private const val EMPTY = """{"Items":[],"TotalRecordCount":0}"""
        private val USERS = Regex("^/Users/[^/]+(?=/)")
        private val STREAM = Regex("^/Videos/([^/]+)/stream")
        private val EPISODE = Regex("^S(\\d{1,4})E(\\d{1,5})$", RegexOption.IGNORE_CASE)
        private val EMPTY_LISTS = setOf("/LiveTv/Timers", "/LiveTv/SeriesTimers", "/LiveTv/Recordings", "/LiveTv/Recordings/Folders", "/Items")
        private val FLAG_KEYS = listOf("IsMovie" to PF.MOVIE, "IsSports" to PF.SPORTS, "IsNews" to PF.NEWS, "IsKids" to PF.KIDS, "IsSeries" to PF.SERIES)
        private val CATEGORY_KEYS = FLAG_KEYS.map { it.first } + "IsNewOrPremiere"
    }
}
