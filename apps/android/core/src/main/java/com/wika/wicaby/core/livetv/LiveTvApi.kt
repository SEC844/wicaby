// The one opt-in for decodeFromStream (spec §21.9); the allocation test in DialectHttpTest pins it.
@file:OptIn(ExperimentalSerializationApi::class)

package com.wika.wicaby.core.livetv

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.json as embyJson
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromStream
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException

// Live TV dialect executor (spec §4.1, §5, §21.2 F9, §21.4): runs the pure Dialect requests on the
// core Emby client, classifies failures for the retry rule and tracks the server clock from the Date
// header. Guide answers are decoded straight from the byte stream into lean DTOs (§2.2, §21.9).

const val DEADLINE_TILE_MS = 15_000L
const val DEADLINE_CHANNELS_MS = 20_000L
const val DEADLINE_DEFAULT_MS = 20_000L

class LiveApiException(val fail: Fail, val status: Int, message: String, cause: Throwable? = null) : IOException(message, cause) {
    enum class Fail { TIMEOUT, NETWORK, HTTP, BAD_DATA }

    /** F9: one retry on connection errors and 5xx only; a timeout is never retried. */
    val retryable: Boolean get() = fail == Fail.NETWORK || (fail == Fail.HTTP && status >= 500)
}

/** The Live TV dialect of a server: Plex answers the non-Emby forms through its adapter. */
val Api.liveKind: ServerKind get() = when (server.kind) {
    // IPTV (core/iptv/IptvApi.kt) answers the Emby forms: channel tags carry the playlist groups.
    "emby", "iptv" -> ServerKind.EMBY
    "plex" -> ServerKind.PLEX
    else -> ServerKind.JELLYFIN
}

/** One tile answer: the programmes, and whether any raw programme carried an IsHD key (V16 probe). */
class TileAnswer(val programs: List<ProgramLite>, val sawHdKey: Boolean)

@Serializable
internal class ItemsDto<T>(val items: List<T> = emptyList(), val totalRecordCount: Int? = null)

// The fields normalizeProgram reads, nothing else (Emby.kt's json maps camelCase to PascalCase).
@Serializable
internal class ProgramDto(
    val id: String? = null,
    val channelId: String? = null,
    val startDate: String? = null,
    val endDate: String? = null,
    val name: String? = null,
    val episodeTitle: String? = null,
    val parentIndexNumber: Int? = null,
    val indexNumber: Int? = null,
    val isLive: Boolean = false,
    val isNew: Boolean = false,
    val isPremiere: Boolean = false,
    val isRepeat: Boolean = false,
    val isHD: Boolean? = null,
    val isMovie: Boolean = false,
    val isSports: Boolean = false,
    val isNews: Boolean = false,
    val isKids: Boolean = false,
    val isSeries: Boolean = false,
    val officialRating: String? = null,
    val seriesId: String? = null,
    val timerId: String? = null,
    val seriesTimerId: String? = null,
    val imageTags: Map<String, String?>? = null,
    val genres: List<String>? = null,
)

private fun String?.nonEmpty(): String? = this?.takeIf { it.isNotEmpty() }

/** normalizeProgram on the lean DTO; [canon] swaps the channel id for the ChannelRow's own instance. */
internal fun ProgramDto.toLite(kind: ServerKind, genresOn: Boolean, canon: (String) -> String): ProgramLite? {
    val id = id.nonEmpty() ?: return null
    val ch = channelId.nonEmpty() ?: return null
    val start = parseServerDate(startDate) ?: return null
    val end = parseServerDate(endDate) ?: return null
    var f = 0
    if (isLive) f = f or PF.LIVE
    if (isNew && kind != ServerKind.JELLYFIN) f = f or PF.NEW
    if (isPremiere) f = f or PF.PREMIERE
    if (isRepeat) f = f or PF.REPEAT
    if (isHD == true) f = f or PF.HD
    if (isMovie) f = f or PF.MOVIE
    if (isSports) f = f or PF.SPORTS
    if (isNews) f = f or PF.NEWS
    if (isKids) f = f or PF.KIDS
    if (isSeries) f = f or PF.SERIES
    if (genresOn && genres != null) f = f or genreFlags(genres)
    return ProgramLite(
        id = id, channelId = canon(ch), start = start, end = end, title = name ?: "",
        episodeTitle = episodeTitle.nonEmpty(), season = parentIndexNumber, episode = indexNumber, flags = f,
        rating = officialRating.nonEmpty(), seriesId = seriesId.nonEmpty(), timerId = timerId.nonEmpty(),
        seriesTimerId = seriesTimerId.nonEmpty(), imageTag = imageTags?.get("Primary").nonEmpty(),
    )
}

/** Decodes a /LiveTv/Programs answer from a stream (the 32-bit TV never holds the JSON text). */
internal fun decodePrograms(input: InputStream, kind: ServerKind, genresOn: Boolean, canon: (String) -> String): TileAnswer {
    val dto = embyJson.decodeFromStream(ItemsDto.serializer(ProgramDto.serializer()), input)
    val out = ArrayList<ProgramLite>(dto.items.size)
    var hd = false
    for (p in dto.items) {
        if (p.isHD != null) hd = true
        p.toLite(kind, genresOn, canon)?.let(out::add)
    }
    return TileAnswer(out, hd)
}

class LiveTvApi(val api: Api, private val clock: () -> Long = System::currentTimeMillis) {
    val kind: ServerKind = api.liveKind
    val userId: String = api.userId.orEmpty()
    val serverId: String = api.server.id

    /** F9 deadlines: tile 15 s, channels page 20 s (variables for the tests). */
    var tileDeadlineMs = DEADLINE_TILE_MS
    var channelsDeadlineMs = DEADLINE_CHANNELS_MS

    private var skew = SkewState()
    private val _clockSkewMs = MutableStateFlow(0L)

    /** caps.clockSkewMs (§21.4): 0 unless the server clock is off by more than 2 min on 3 answers in a row. */
    val clockSkewMs: StateFlow<Long> = _clockSkewMs.asStateFlow()

    /** Live TV time: the client clock corrected by the skew. */
    fun now(): Long = clock() + _clockSkewMs.value

    private fun noteDate(serverMs: Long?) {
        synchronized(this) {
            skew = nextSkew(skew, serverMs, clock())
            _clockSkewMs.value = skew.skewMs
        }
    }

    /** Runs [req] and hands the body stream to [read]. Failures are LiveApiException. */
    suspend fun <T> run(req: Req, deadlineMs: Long = DEADLINE_DEFAULT_MS, read: (InputStream) -> T): T {
        try {
            return api.stream(req.method, req.path, req.body?.toString(), req.query.toList(), deadlineMs) { res ->
                noteDate(res.headers.getDate("Date")?.time)
                read(res.body.byteStream())
            }
        } catch (e: ApiException) {
            throw LiveApiException(LiveApiException.Fail.HTTP, e.status, e.message ?: "HTTP ${e.status}", e)
        } catch (e: InterruptedIOException) {
            throw LiveApiException(LiveApiException.Fail.TIMEOUT, 0, "timeout", e)
        } catch (e: SerializationException) {
            throw LiveApiException(LiveApiException.Fail.BAD_DATA, 0, e.message ?: "bad data", e)
        } catch (e: IOException) {
            throw LiveApiException(LiveApiException.Fail.NETWORK, 0, e.message ?: "network", e)
        }
    }

    /** The answer as JSON (null for an empty body: 204, or a write that returns nothing). */
    suspend fun json(req: Req, deadlineMs: Long = DEADLINE_DEFAULT_MS): JsonElement? = run(req, deadlineMs) { s ->
        s.bufferedReader().readText().takeIf { it.isNotBlank() }?.let(embyJson::parseToJsonElement)
    }

    private suspend fun items(req: Req, deadlineMs: Long = DEADLINE_DEFAULT_MS): ItemsDto<JsonObject> =
        run(req, deadlineMs) { embyJson.decodeFromStream(ItemsDto.serializer(JsonObject.serializer()), it) }

    suspend fun info(): JsonObject? = json(Dialect.info(kind)) as? JsonObject

    /** Services[].Tuners.length summed (§4.3 tunerCount; null when the server lists none). */
    fun tunerCount(info: JsonObject?): Int? =
        (info?.get("Services") as? JsonArray)?.sumOf { ((it as? JsonObject)?.get("Tuners") as? JsonArray)?.size ?: 0 }?.takeIf { it > 0 }

    /** One channels page and, on the first page, the total. */
    suspend fun channelsPage(startIndex: Int, limit: Int): Pair<List<ChannelRow>, Int?> {
        val page = items(Dialect.channelsPage(kind, userId, startIndex, limit), channelsDeadlineMs)
        return page.items.mapIndexedNotNull { i, o -> normalizeChannel(o, serverId, startIndex + i) } to page.totalRecordCount
    }

    suspend fun programsTile(channelIds: List<String>, from: Long, to: Long, genres: Boolean, canon: (String) -> String = { it }): TileAnswer =
        run(Dialect.programsTile(kind, userId, channelIds, from, to, genres), tileDeadlineMs) { decodePrograms(it, kind, genres, canon) }

    suspend fun timers(): List<TimerLite> = normalizeTimers(items(Dialect.timers(kind)).items)

    suspend fun displayPrefs(): JsonObject = json(Dialect.displayPrefs(kind, userId)) as? JsonObject ?: JsonObject(emptyMap())

    suspend fun saveDisplayPrefs(body: JsonObject) {
        json(Dialect.saveDisplayPrefs(kind, userId, body))
    }

    suspend fun setFavorite(id: String, favorite: Boolean) {
        json(Dialect.setFavorite(kind, userId, id, favorite))
    }
}
