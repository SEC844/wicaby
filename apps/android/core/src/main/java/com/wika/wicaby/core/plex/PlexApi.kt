package com.wika.wicaby.core.plex

import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.SocketMessage
import com.wika.wicaby.core.net.cappedString
import com.wika.wicaby.core.net.executeUse
import com.wika.wicaby.core.net.head
import com.wika.wicaby.core.player.Quality
import com.wika.wicaby.core.player.RemoteControl
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.util.Collections
import java.util.UUID
import java.util.concurrent.TimeUnit

// The signed-in Home user's plex.tv watchlist (D-6: the Favorites of a plex server); the user token stays with it.
interface PlexWatchlist {
    suspend fun guids(): List<String>
    suspend fun set(guid: String, on: Boolean)
}

// A Plex Media Server seen as a server (plex-spec §3.3), the twin of desktop main/connection/plex-client.ts and
// plex-playback.ts: the Emby-shaped calls the apps already make (Api's typed methods, Playback, SessionReporter) are
// translated through the route table (PlexRoutes), sent to the PMS and mapped back (PlexMap). A route the table does
// not know answers 404 "PLEX-UNMAPPED …", never a wrong answer. The server token goes only as the X-Plex-Token
// header, to this server's address (Core.http's ServerAuthInterceptor adds it to the player's and images' requests,
// and only there).
class PlexApi(
    server: Server,
    deviceId: String,
    token: String?,
    userId: String?,
    val options: Options = Options(),
    private val http: OkHttpClient = Core.http,
    private val client: PlexClient = PlexClient(deviceId, Core.deviceName, Core.version),
) : Api(server, deviceId, token, userId) {
    class Options(
        val userName: String = "",
        // The server owner's own account (D-2: "Refresh metadata" is theirs).
        val owner: Boolean = false,
        // Reached through a remote or relay address (§6.2: remote sessions start at the server's remote cap).
        val remote: Boolean = false,
        val watchlist: PlexWatchlist? = null,
        // The address is not one the token is bound to (PlexAccounts.tokenAllowed, D-3): nothing carries the token.
        val unbound: Boolean = false,
    )

    private val machineId get() = server.id

    // The server ended a play (terminationText, §6.5): the player stops and shows why. Tests replace it.
    @Volatile
    var onTerminated: (String) -> Unit = { text ->
        RemoteControl.handle(SocketMessage("Playstate", buildJsonObject { put("Command", "Stop") }), enabled = true)
        RemoteControl.handle(SocketMessage("GeneralCommand", buildJsonObject { put("Name", "DisplayMessage"); putJsonObject("Arguments") { put("Header", "Plex"); put("Text", text) } }), enabled = true)
    }

    // ---- Auth and URLs ----

    // What the player, images and downloads carry (no Accept: they are not JSON calls).
    override fun authHeaders(): Map<String, String> = client.headers(token.takeUnless { options.unbound }) - "Accept"

    // A media route (direct play, BIF, sidecar subtitle, download) → its PMS URL, from the item the play read first.
    // Never with the token: a caller's api_key/ApiKey (or any value equal to it) is dropped, the header carries it.
    override fun url(path: String, vararg query: Pair<String, Any?>): String {
        val q = query.filterNot { (k, v) -> k.equals("api_key", true) || k.equals("ApiKey", true) || (token != null && v == token) }.toTypedArray()
        val hit = PlexRoutes.matchRoute("GET", path)
        if (hit != null && hit.route.media && hit.route.op != "image") {
            mediaPath(hit.route.op, hit.params, q.toQuery())?.let { return pmsUrl(it) }
        }
        return super.url(path, *q)
    }

    // Images through the PMS photo transcoder. An item seen in a list knows its paths; one only known by its id and
    // tag (a card restored from a cache) uses the PMS path pattern the tag comes from.
    override fun image(id: String, type: String, tag: String?, maxWidth: Int?, maxHeight: Int?): String {
        val path = images["$id/$type"] ?: (if (type == "Thumb") images["$id/Backdrop"] else null)
            ?: tag?.takeIf { PlexMap.parseId(id)?.kind == "item" && TAG.matches(it) }?.let { t ->
                when (type) {
                    "Primary" -> "/library/metadata/$id/thumb/$t"
                    "Backdrop", "Thumb" -> "/library/metadata/$id/art/$t"
                    else -> null
                }
            }
            ?: return ""
        val q = LinkedHashMap<String, String>()
        maxWidth?.let { q["maxWidth"] = "$it" }
        maxHeight?.let { q["maxHeight"] = "$it" }
        q["quality"] = "90"
        return pmsUrl(PlexImages.transcodePath(path, type, q))
    }

    private fun pmsUrl(pathAndQuery: String) = server.address.trimEnd('/') + pathAndQuery

    // ---- Requests ----

    override suspend fun raw(method: String, path: String, body: String?, vararg query: Pair<String, Any?>): String =
        answer(method.uppercase(), path, query.toQuery(), body?.takeIf { it.isNotBlank() }?.let { runCatching { plexJson.parseToJsonElement(it) }.getOrNull() })

    override suspend fun <T> stream(method: String, path: String, body: String?, query: List<Pair<String, Any?>>, timeoutMs: Long, read: (Response) -> T): T {
        val text = raw(method, path, body, *query.toTypedArray())
        return Response.Builder().request(Request.Builder().url("http://127.0.0.1/").build()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
            .body(text.toResponseBody(JSON)).build().use(read)
    }

    // Server hubs for Home (caps.serverHubs, plex-spec §8): [{Name, Key, Items}]; [parentId] a section: its hubs.
    suspend fun hubs(parentId: String? = null): List<JsonObject> =
        plexJson.parseToJsonElement(raw("GET", "/Hubs", null, "ParentId" to parentId)).list().filterIsInstance<JsonObject>()

    // One PMS call: the answer's MediaContainer (or the bare JSON), null for an empty or non-JSON answer.
    internal suspend fun pms(r: PmsReq, timeoutMs: Long = 20_000): JsonElement? = withContext(Dispatchers.IO) {
        if (options.unbound) throw ApiException(text(R.string.plex_error_confirm_http, "confirm this unencrypted address first"), 403)
        val b = pmsUrl(r.path).toHttpUrl().newBuilder()
        for ((k, v) in r.query) b.addQueryParameter(k, v)
        val req = Request.Builder().url(b.build())
        client.headers(token).forEach { (k, v) -> req.header(k, v) }
        r.headers?.forEach { (k, v) -> req.header(k, v) }
        req.method(r.method, if (r.method == "GET" || r.method == "DELETE") null else ByteArray(0).toRequestBody())
        val call = http.newCall(req.build())
        call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
        call.executeUse { res ->
            if (!res.isSuccessful) throw ApiException(res.body.head(300).ifBlank { "HTTP ${res.code}" }, res.code)
            val text = res.body.cappedString()
            if (text.isBlank() || res.header("Content-Type")?.contains("json") != true) return@executeUse null
            val e = runCatching { plexJson.parseToJsonElement(text) }.getOrNull()
            e["MediaContainer"] ?: e
        }
    }

    // ---- What the adapter remembers of each item ----

    private class Seen(val type: String?, val title: String?, val guid: String?)

    // '{id}/{ImageType}' → PMS image path, from every item mapped; ratingKey → what the adapter needs of it later.
    private val images: MutableMap<String, String> = Collections.synchronizedMap(lru(MAX_CACHE))
    private val seen: MutableMap<String, Seen> = Collections.synchronizedMap(lru(MAX_CACHE))

    @Volatile
    private var sectionList: Pair<Long, List<JsonElement>>? = null

    @Volatile
    private var watched: Pair<Long, Set<String>>? = null

    private fun note(meta: JsonElement) {
        images.putAll(PlexImages.imagePaths(meta))
        meta["ratingKey"].str()?.let { seen[it] = Seen(meta["type"].str(), meta["title"].str(), meta["guid"].str()) }
        for (p in meta["Role"].list() + meta["Director"].list() + meta["Writer"].list()) {
            val id = p["id"].str() ?: continue
            p["tag"].str()?.let { seen[PlexMap.personId(id)] = Seen("person", it, null) }
        }
    }

    private suspend fun sections(): List<JsonElement> {
        sectionList?.takeIf { System.currentTimeMillis() - it.first < SECTIONS_TTL_MS }?.let { return it.second }
        val list = pms(pmsGet("/library/sections"))["Directory"].list().filter { !it["hidden"].truthy() }
        sectionList = System.currentTimeMillis() to list
        return list
    }

    private suspend fun watchGuids(): Set<String> {
        val wl = options.watchlist ?: return emptySet()
        watched?.takeIf { System.currentTimeMillis() - it.first < WATCHLIST_TTL_MS }?.let { return it.second }
        val guids = runCatching { wl.guids().toSet() }.getOrElse { emptySet() }
        watched = System.currentTimeMillis() to guids
        return guids
    }

    private suspend fun items(metas: List<JsonElement>): List<JsonObject> {
        val favs = watchGuids()
        return metas.mapNotNull { m ->
            note(m)
            val it = PlexMap.toItem(m) ?: return@mapNotNull null
            val guid = m["guid"].str()
            if (guid != null && guid in favs && it["UserData"] is JsonObject) JsonObject(it + ("UserData" to JsonObject(it["UserData"] as JsonObject + ("IsFavorite" to JsonPrimitive(true))))) else it
        }
    }

    private suspend fun metaOf(id: String): JsonElement {
        val meta = pms(PlexQuery.metadataRequest(id))["Metadata"].list().firstOrNull() ?: throw ApiException("Not found", 404)
        note(meta)
        return meta
    }

    // A request that may need a section fan-out, genre ids, the playlist path or the watchlist.
    private suspend fun exec(r: PmsReq): JsonElement? {
        if (r.watchlist) return watchlisted(r)
        if (r.fanOut != "sections") return one(r)
        val type = r.query["type"]?.toIntOrNull() ?: 0
        val secs = sections().filter { s -> if (type != 0) SECTION_TYPES[s["type"].str()]?.contains(type) == true else s["type"].str() != "photo" }
        val parts = coroutineScope {
            secs.map { s ->
                async {
                    try {
                        one(r.copy(fanOut = null, path = r.path.replace("{section}", s["key"].str().orEmpty())))
                    } catch (_: PlexUnmapped) {
                        // A genre this section does not have: nothing from it.
                        null
                    }
                }
            }.awaitAll()
        }
        val metas = sortMerged(parts.flatMap { it["Metadata"].list() }, r.query["sort"])
        val size = r.headers?.get("X-Plex-Container-Size")?.toIntOrNull()?.takeIf { it > 0 } ?: metas.size
        val total = parts.sumOf { p -> p["totalSize"].num()?.toInt() ?: p["Metadata"].list().size }
        return JsonObject(mapOf("Metadata" to JsonArray(metas.take(size)), "totalSize" to JsonPrimitive(total)))
    }

    private suspend fun one(r: PmsReq): JsonElement? {
        var q = r
        if (!q.genres.isNullOrEmpty()) {
            val sec = SECTION_PATH.find(q.path)?.groupValues?.get(1) ?: throw PlexUnmapped("Genres outside a section")
            q = PlexQuery.withGenreIds(q, pms(pmsGet("/library/sections/$sec/genre"))["Directory"].list())
        }
        // A playlist's entries live under /playlists, not /library/metadata.
        CHILDREN.find(q.path)?.let { m -> if (seen[m.groupValues[1]]?.type == "playlist") q = q.copy(path = "/playlists/${m.groupValues[1]}/items", query = emptyMap()) }
        return pms(q)
    }

    // Favorites (D-6): the watchlisted titles this server holds, found by guid in each section.
    private suspend fun watchlisted(r: PmsReq): JsonElement {
        val guids = watchGuids().take(MAX_WATCHLIST)
        val base = r.copy(watchlist = false, headers = null)
        val parts = coroutineScope { guids.map { g -> async { runCatching { exec(base.copy(query = r.query + ("guid" to g))) }.getOrNull() } }.awaitAll() }
        val keys = HashSet<String>()
        val metas = parts.flatMap { it["Metadata"].list() }.filter { keys.add(it["ratingKey"].str().orEmpty()) }
        val start = r.headers?.get("X-Plex-Container-Start")?.toIntOrNull() ?: 0
        val size = r.headers?.get("X-Plex-Container-Size")?.toIntOrNull()?.takeIf { it > 0 } ?: metas.size
        return JsonObject(mapOf("Metadata" to JsonArray(metas.drop(start).take(size)), "totalSize" to JsonPrimitive(metas.size), "offset" to JsonPrimitive(start)))
    }

    private suspend fun list(r: PmsReq, query: Map<String, String>): JsonObject {
        val c = exec(r)
        val items = items(PlexQuery.answerMeta(r, c))
        val start = orZero(jsNumber(query["StartIndex"])).toInt()
        val total = c["totalSize"]?.takeIf { r.keep == null && it.isNum() }?.num()?.toInt() ?: (start + items.size)
        return result(items, total, start)
    }

    // ---- Answers ----

    private suspend fun answer(method: String, rawPath: String, query: Map<String, String>, body: JsonElement?): String = withContext(Dispatchers.IO) {
        val path = normalise(method, rawPath.substringBefore('?'))
        val t = PlexRoutes.translate(method, path, query, body, PlexRoutes.Ctx(machineId))
        val req = t.req
        val p = t.params
        fun out(e: JsonElement?) = e?.toString() ?: ""
        when (t.op) {
            "me" -> {
                // A call that needs the token: a 401 here tells the session it is gone (a PIN changed, a share revoked).
                pms(pmsGet("/"))
                out(buildJsonObject {
                    put("Id", userId.orEmpty())
                    put("Name", options.userName)
                    put("HasPassword", false)
                    putJsonObject("Policy") { put("IsAdministrator", options.owner) }
                })
            }
            "identity" -> {
                val c = pms(req!!)
                out(buildJsonObject {
                    put("Id", c["machineIdentifier"].str() ?: machineId)
                    put("ServerName", server.name)
                    put("Version", c["version"].str().orEmpty())
                    put("ProductName", "Plex Media Server")
                })
            }
            "views" -> {
                val secs = sections()
                for (s in secs) s["thumb"].str()?.let { images["section-${s["key"].str()}/Primary"] = it }
                // The Live TV view the apps open Live TV from, only with Plex Pass and a tuner (PX-11).
                val views = secs.map(PlexMap::toView) + listOfNotNull(
                    buildJsonObject { put("Id", "livetv"); put("Name", text(R.string.plex_livetv_view, "Live TV")); put("Type", "CollectionFolder"); put("CollectionType", "livetv") }.takeIf { live.enabled() },
                )
                out(result(views, views.size, 0))
            }
            "hubs" -> {
                val c = pms(req!!)
                for (h in c["Hub"].list()) for (m in h["Metadata"].list()) note(m)
                out(JsonArray(PlexMap.toHubs(c)))
            }
            "item" -> out(if (req != null) items(listOf(metaOf(p["id"]!!))).firstOrNull() ?: throw ApiException("Not found", 404) else pseudoItem(p["id"]!!))
            "trailers", "extras" -> out(JsonArray(PlexMap.toExtras(metaOf(p["id"]!!), t.op == "trailers")))
            "ancestors" -> out(JsonArray(ancestors(metaOf(p["id"]!!))))
            "seasons" -> out(if (PlexMap.seasonsFlattened(metaOf(p["id"]!!))) result(emptyList(), 0, 0) else list(req!!, query))
            "items", "resume", "nextUp", "similar", "episodes", "playlistItems", "artists" -> out(list(req!!, query))
            "latest" -> out(list(req!!, query)["Items"])
            "genres", "years" -> {
                val dir = pms(req!!)["Directory"].list()
                val items = dir.map { d ->
                    if (t.op == "years") JsonObject(linkedMapOf("Id" to js((d["key"] ?: d["title"]).str().orEmpty()), "Name" to js(d["title"].str().orEmpty()), "Type" to js("Year")) + (d["title"].num()?.let { mapOf("ProductionYear" to jn(it)) } ?: emptyMap()))
                    else JsonObject(linkedMapOf("Id" to js("genre-${d["key"].str()}"), "Name" to js(d["title"].str().orEmpty()), "Type" to js("Genre")))
                }
                out(result(items, items.size, 0))
            }
            "segments" -> out(segments(p["id"]!!))
            "playbackInfo" -> out(if (PlexLiveMap.parseLiveId(p["id"]!!) != null) live.tune(p["id"]!!, query, body) else playbackInfo(p["id"]!!, query, body))
            "timeline" -> {
                val event = if (path.endsWith("/Stopped")) "Stopped" else if (path.endsWith("/Progress")) "Progress" else ""
                out(if (PlexLiveMap.parseLiveId(body["ItemId"].str().orEmpty()) != null) live.report(event, body) else timeline(event, body))
            }
            "empty" -> out(result(emptyList(), 0, 0))
            "noop" -> ""
            "favorite", "unfavorite" -> out(watchlistSet(p["id"]!!, t.op == "favorite"))
            "createPlaylist" -> out(buildJsonObject { pms(req!!)["Metadata"].list().firstOrNull()?.get("ratingKey").str()?.let { put("Id", it) } })
            "createCollection" -> out(createCollection(query))
            "playlistMove" -> {
                movePlaylistEntry(p["id"]!!, p["entry"]!!, p["index"]?.toIntOrNull() ?: 0)
                ""
            }
            else -> {
                // Writes the table translated (played, refresh, playlist and collection edits, transcode stop): done.
                if (req == null && t.op.startsWith("live")) {
                    out(live.answer(t.op, p, query, body))
                } else if (req != null && method != "GET") {
                    pms(req)
                    ""
                } else {
                    throw PlexUnmapped("$method $path")
                }
            }
        }
    }

    // Api speaks the Jellyfin forms to any non-Emby server (/UserViews, /Items?userId=…): the table has the Emby ones.
    private fun normalise(method: String, path: String): String {
        val u = "/Users/${userId ?: "me"}"
        JELLYFIN_USER.find(path)?.let { m -> return "$u/${m.groupValues[1]}Items/${m.groupValues[2]}" }
        return when {
            path == "/UserViews" -> "$u/Views"
            path == "/UserItems/Resume" -> "$u/Items/Resume"
            path.startsWith("/UserItems/") && path.endsWith("/UserData") -> "$u/Items/" + path.removePrefix("/UserItems/")
            method == "GET" && JELLYFIN_ITEMS.matches(path) -> "$u$path"
            else -> path
        }
    }

    // A section (its view) or a person (their page), which PMS does not serve as items.
    private suspend fun pseudoItem(id: String): JsonObject {
        val p = PlexMap.parseId(id)
        if (p?.kind == "section") return PlexMap.toView(sections().firstOrNull { it["key"].str() == p.key } ?: throw ApiException("Not found", 404))
        if (p?.kind == "person") return buildJsonObject {
            put("Id", id)
            put("Name", seen[id]?.title.orEmpty())
            put("Type", "Person")
            images["$id/Primary"]?.let { PlexImages.imageTag(it) }?.let { putJsonObject("ImageTags") { put("Primary", it) } }
        }
        throw PlexUnmapped("item $id")
    }

    private suspend fun ancestors(meta: JsonElement): List<JsonObject> {
        val type = meta["type"].str()
        val out = ArrayList<JsonObject>()
        meta["parentRatingKey"].str()?.let {
            out += JsonObject(linkedMapOf("Id" to js(it), "Name" to js(meta["parentTitle"].str().orEmpty()), "Type" to js(if (type == "episode") "Season" else if (type == "track") "MusicAlbum" else "Series")))
        }
        meta["grandparentRatingKey"].str()?.let {
            out += JsonObject(linkedMapOf("Id" to js(it), "Name" to js(meta["grandparentTitle"].str().orEmpty()), "Type" to js(if (type == "track") "MusicArtist" else "Series")))
        }
        sections().firstOrNull { it["key"].str() == meta["librarySectionID"].str() }?.let { out += PlexMap.toView(it) }
        return out
    }

    private suspend fun watchlistSet(id: String, on: Boolean): JsonObject {
        val wl = options.watchlist ?: throw PlexUnmapped("FavoriteItems without a plex.tv account")
        val guid = seen[PlexQuery.itemKey(id)]?.guid ?: metaOf(id)["guid"].str()
        if (guid == null || !guid.startsWith("plex://")) throw PlexUnmapped("FavoriteItems $id: no plex:// guid (legacy agent)")
        wl.set(guid, on)
        watched = null
        return buildJsonObject { put("IsFavorite", on) }
    }

    // Emby creates a collection from items; PMS needs the section and the item type, read from the first one.
    private suspend fun createCollection(query: Map<String, String>): JsonObject {
        val name = query["Name"].orEmpty()
        val ids = query["Ids"].orEmpty().split(',').filter { it.isNotEmpty() }
        if (name.isEmpty() || ids.isEmpty()) throw PlexUnmapped("POST /Collections without Name or Ids")
        val first = metaOf(ids[0])
        val type = PlexQuery.PLEX_TYPE[PlexMap.toItem(first)?.get("Type").str()]
        val section = first["librarySectionID"].str()
        if (type == null || section == null) throw PlexUnmapped("POST /Collections of a ${first["type"].str()}")
        val c = pms(PmsReq("POST", "/library/collections", linkedMapOf("type" to "$type", "title" to name, "smart" to "0", "sectionId" to section, "uri" to PlexQuery.itemsUri(machineId, ids))))
        return buildJsonObject { c["Metadata"].list().firstOrNull()?.get("ratingKey").str()?.let { put("Id", it) } }
    }

    // Emby moves an entry to an index; PMS moves it after another entry.
    private suspend fun movePlaylistEntry(playlistId: String, entry: String, index: Int) {
        val key = PlexQuery.itemKey(playlistId)
        val others = pms(pmsGet("/playlists/$key/items"))["Metadata"].list().mapNotNull { it["playlistItemID"].str() }.filter { it != entry }
        val after = if (index > 0) others.getOrNull(minOf(index, others.size) - 1) else null
        pms(PmsReq("PUT", "/playlists/$key/items/${PlexQuery.itemKey(entry)}/move", if (after != null) mapOf("after" to after) else emptyMap()))
    }

    // Live TV and DVR (PX-11): the /LiveTv routes, a channel's tune and its reports (PlexLiveTv.kt).
    private val live by lazy { PlexLiveTv({ pms(it) }, client.deviceId, { plexPass() }, { items(it) }) }

    // ---- Playback (plex-spec §6; desktop plex-playback.ts) ----

    // ratingKey → full metadata of the items being played (parts and selected streams for the media paths and PUTs).
    private val metas: MutableMap<String, JsonElement> = Collections.synchronizedMap(lru(KEEP))
    private val stopped: MutableSet<String> = Collections.synchronizedSet(HashSet())
    private val terminated: MutableSet<String> = Collections.synchronizedSet(HashSet())

    // The remote cap a refusal taught (kbps): a shared user cannot read the owner's prefs.
    @Volatile
    private var learnedCap = 0

    @Volatile
    private var prefsCap: Int? = null

    @Volatile
    private var pass: Boolean? = null

    @Volatile
    private var passRead = false

    private suspend fun playMeta(id: String): JsonElement {
        val c = pms(PlexQuery.metadataRequest(id))
        var meta = c["Metadata"].list().firstOrNull() ?: throw ApiException(text(R.string.plex_error_file_unavailable, "file unavailable"), 404)
        // allowSync on the item or on its container (plex spec §1.3, triage §4.6): a PMS often sets only the container's.
        if (meta is JsonObject && meta["allowSync"] == null && c["allowSync"].truthy()) meta = JsonObject(meta + ("allowSync" to JsonPrimitive(true)))
        note(meta)
        meta["ratingKey"].str()?.let { metas.remove(it); metas[it] = meta }
        return meta
    }

    private suspend fun decide(r: PlexDecision.Request): JsonElement? =
        pms(PmsReq("GET", "/video/:/transcode/universal/decision", r.query, mapOf("X-Plex-Client-Profile-Extra" to r.profile)))

    // The owner's remote cap (/:/prefs WanPerStreamMaxUploadRate, kbps), read once; 0 for a shared user (403) or none.
    private suspend fun ownerCap(): Int = prefsCap ?: runCatching { PlexDecision.remoteCapKbps(pms(pmsGet("/:/prefs"))) }.getOrDefault(0).also { prefsCap = it }

    // POST /Items/{id}/PlaybackInfo: one decision for every quality (Original included). A remote session starts at the
    // server's remote cap; a refusal anyway ("Cannot make a decision") retries at the owner's cap, else down the
    // quality presets, and the one that plays is kept. The remote-pass gate is explained, never worked around.
    private suspend fun playbackInfo(id: String, query: Map<String, String>, body: JsonElement?): JsonObject {
        val merged = JsonObject(query.mapValues { JsonPrimitive(it.value) } + ((body as? JsonObject) ?: emptyMap()))
        val meta = playMeta(id)
        // The next part of a multi-part film keeps the session of the part before (D-4: one viewing, one session).
        val session = merged["PlaySessionId"]?.takeIf { it.isStr() }?.str()?.takeIf { SESSION.matches(it) } ?: UUID.randomUUID().toString()
        val want = (orZero(merged["MaxStreamingBitrate"].jsNumber()) / 1000).toInt()
        val cap = if (options.remote) learnedCap.takeIf { it > 0 } ?: ownerCap() else 0
        val first = if (cap > 0 && (want == 0 || want > cap)) cap else null
        var req = PlexDecision.decisionRequest(id, meta, merged, session, client.deviceId, first)
        var answer: JsonElement? = null
        try {
            answer = decide(req)
        } catch (e: ApiException) {
            val why = PlexDecision.decisionFailure(e.status, e.message.orEmpty())
            if (why == "remoteNeedsPass") throw ApiException(text(R.string.plex_error_remote_needs_pass, "remote playback needs a Plex Pass"), 403)
            if (why != "lowerQuality") throw e
            val tried = first ?: want
            val ladder = (listOf(ownerCap()) + Quality.PRESETS.map { it.bitrate / 1000 }).distinct().filter { it > 0 && (tried == 0 || it < tried) }.sortedDescending()
            for (kbps in ladder) {
                req = PlexDecision.decisionRequest(id, meta, merged, session, client.deviceId, kbps)
                try {
                    answer = decide(req)
                    learnedCap = kbps
                    break
                } catch (again: ApiException) {
                    when (PlexDecision.decisionFailure(again.status, again.message.orEmpty())) {
                        "lowerQuality" -> continue
                        "remoteNeedsPass" -> throw ApiException(text(R.string.plex_error_remote_needs_pass, "remote playback needs a Plex Pass"), 403)
                        else -> throw again
                    }
                }
            }
            if (answer == null) throw ApiException(text(R.string.plex_error_lower_quality, "lower the quality"), 500)
        }
        val info = PlexDecision.toPlaybackInfo(answer, meta, req)
        val transcoding = info["MediaSources"].list().firstOrNull()["TranscodingUrl"] != null
        return if (transcoding) plexPass()?.let { JsonObject(info + ("PlexPass" to JsonPrimitive(it))) } ?: info else info
    }

    // The server owner's Plex Pass (the PMS root's myPlexSubscription): markers and hardware transcoding need it, so
    // the UI can say why they are missing.
    suspend fun plexPass(): Boolean? {
        if (passRead) return pass
        pass = runCatching { pms(pmsGet("/"))["myPlexSubscription"]?.let { it.isTrue() || it.str() == "1" || it.str() == "true" } }.getOrNull()
        passRead = true
        return pass
    }

    // /Sessions/Playing[/Progress|/Stopped] → /:/timeline. Exactly one stopped per session and nothing after it or
    // after the server ended it (PMS marks watched on its own threshold: no scrobble here, #1740). A manual track
    // change is also stored on the part (#1326). A termination stops the player with its text (#1362).
    private suspend fun timeline(event: String, body: JsonElement?): JsonObject {
        val session = body["PlaySessionId"].str().orEmpty()
        synchronized(stopped) {
            if (session.isNotEmpty() && (session in terminated || session in stopped)) return JsonObject(emptyMap())
            if (event == "Stopped" && session.isNotEmpty()) stopped += session
        }
        val answer = pms(PlexQuery.timelineRequest(event, body))
        val change = body["EventName"].str()
        if (event == "Progress" && (change == "AudioTrackChange" || change == "SubtitleTrackChange")) runCatching { storeTracks(body) }
        if (answer["terminationCode"] != null || answer["terminationText"].truthy()) {
            if (session.isNotEmpty()) terminated += session
            val why = answer["terminationText"].takeIf { it.truthy() }?.str() ?: text(R.string.plex_error_terminated, "The server stopped playback.")
            runCatching { onTerminated(why) }
            return buildJsonObject { put("TerminationText", why) }
        }
        return JsonObject(emptyMap())
    }

    private suspend fun storeTracks(body: JsonElement?) {
        val meta = metas[body["ItemId"].str()] ?: return
        val put = PlexDecision.trackPut(meta, body["MediaSourceId"].str(), body["AudioStreamIndex"].num()?.toInt(), body["SubtitleStreamIndex"].num()?.toInt()) ?: return
        pms(PmsReq("PUT", put.first, put.second))
        // What PMS now has selected, so the same pick is not sent again.
        val key = meta["ratingKey"].str() ?: return
        metas[key] = select(meta, put.first, put.second)
    }

    private fun select(meta: JsonElement, partPath: String, q: Map<String, String>): JsonElement {
        fun stream(s: JsonElement): JsonElement {
            val type = s["streamType"].num()
            val id = s["id"].str()
            val pick = when {
                type == 2.0 && q["audioStreamID"] != null -> id == q["audioStreamID"]
                type == 3.0 && q["subtitleStreamID"] != null -> id == q["subtitleStreamID"]
                else -> return s
            }
            return JsonObject((s as JsonObject) + ("selected" to JsonPrimitive(pick)))
        }
        fun part(pt: JsonElement) = if ("/library/parts/${pt["id"].str()}" == partPath) JsonObject((pt as JsonObject) + ("Stream" to JsonArray(pt["Stream"].list().map(::stream)))) else pt
        fun media(m: JsonElement) = JsonObject((m as JsonObject) + ("Part" to JsonArray(m["Part"].list().map(::part))))
        return JsonObject((meta as JsonObject) + ("Media" to JsonArray(meta["Media"].list().map(::media))))
    }

    // /MediaSegments/{id}: intro and credits markers (a Plex Pass analysis on the server; none without it, D-5: no
    // client-side detection). With none, PlexPass says whether that is why.
    private suspend fun segments(id: String): JsonObject {
        val out = PlexMap.toSegments(playMeta(id))
        if (out["Items"].list().isNotEmpty()) return out
        return plexPass()?.let { JsonObject(out + ("PlexPass" to JsonPrimitive(it))) } ?: out
    }

    // A media route of a play → its PMS path: the part (direct play, download), its BIF, a sidecar subtitle. Null when
    // the item was not read yet (PlaybackInfo reads it first) or has no such file.
    private fun mediaPath(op: String, params: Map<String, String>, query: Map<String, String>): String? {
        val meta = metas[params["id"]] ?: return null
        val part = PlexMap.playablePart(meta, query["MediaSourceId"] ?: query["mediaSourceId"])
        return when (op) {
            "stream" -> part["key"].str()
            // Only where the server allows it (allowSync, plex-spec §1.3).
            "download" -> part["key"].str()?.takeIf { meta["allowSync"].truthy() }?.let { "$it?download=1" }
            "bif" -> part?.takeIf { it["indexes"].str() == "sd" }?.let { "/library/parts/${it["id"].str()}/indexes/sd" }
            // shortcut: sidecar subtitles only; an embedded one would need PMS's subtitle transcoder.
            "subtitle" -> meta["Media"].list().flatMap { it["Part"].list() }.flatMap { it["Stream"].list() }
                .firstOrNull { it["id"].str() == params["index"] && it["streamType"].num() == 3.0 }?.get("key").str()
            else -> null
        }
    }

    // A part of a multi-part film (D-4) as a URL, for a player that plays the parts as one queue.
    fun partUrl(path: String): String = pmsUrl(path)

    // The original file for a download (allowSync only), reading the item first when needed.
    suspend fun downloadPath(id: String, mediaSourceId: String? = null): String? {
        if (metas[id] == null) runCatching { playMeta(id) }
        return mediaPath("download", mapOf("id" to id), mapOfNotNull("MediaSourceId" to mediaSourceId))?.let(::pmsUrl)
    }

    private fun text(id: Int, fallback: String) = runCatching { Core.str(id) }.getOrDefault(fallback)

    companion object {
        private val JSON = "application/json".toMediaType()
        private const val MAX_CACHE = 5000
        private const val KEEP = 32
        private const val SECTIONS_TTL_MS = 60_000L
        private const val WATCHLIST_TTL_MS = 60_000L
        // shortcut: one PMS request per watchlisted title and section, capped; use a bulk guid filter if PMS documents one.
        private const val MAX_WATCHLIST = 50
        private val TAG = Regex("^\\d{1,20}$")
        private val SESSION = Regex("^[\\w-]{1,64}$")
        private val SECTION_PATH = Regex("^/library/sections/(\\d+)/")
        private val CHILDREN = Regex("^/library/metadata/(\\d+)/(?:children|allLeaves)$")
        private val JELLYFIN_USER = Regex("^/User(Played|Favorite)Items/([^/]+)$")
        private val JELLYFIN_ITEMS = Regex("^/Items(/Latest|/Resume|/[^/]+(?:/LocalTrailers|/SpecialFeatures|/Intros)?)?$")
        // PMS item types a section of each type holds (a fan-out with type= skips the others).
        private val SECTION_TYPES = mapOf("movie" to listOf(1, 18), "show" to listOf(2, 3, 4, 18), "artist" to listOf(8, 9, 10, 18), "photo" to listOf(13, 14))

        private fun pmsGet(path: String) = PmsReq("GET", path)

        private fun <K, V> lru(max: Int): MutableMap<K, V> = object : LinkedHashMap<K, V>(64, 0.75f, false) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<K, V>?) = size > max
        }

        private fun result(items: List<JsonElement>, total: Int, start: Int) =
            JsonObject(linkedMapOf("Items" to JsonArray(items), "TotalRecordCount" to JsonPrimitive(total), "StartIndex" to JsonPrimitive(start)))

        private fun <K, V> mapOfNotNull(vararg pairs: Pair<K, V?>): Map<K, V> = pairs.mapNotNull { (k, v) -> v?.let { k to it } }.toMap()

        // Sections answered apart: merged in the order PMS used inside each one (the first sort key).
        private fun sortMerged(metas: List<JsonElement>, sort: String?): List<JsonElement> {
            val (key, dir) = (sort ?: "").split(',')[0].split(':').let { it[0] to it.getOrNull(1) }
            if (key.isEmpty() || key == "random") return metas
            val cmp = Comparator<JsonElement> { a, b ->
                val va = a[key] ?: if (key == "titleSort") a["title"] else null
                val vb = b[key] ?: if (key == "titleSort") b["title"] else null
                val na = va.num()
                val nb = vb.num()
                if (na != null && nb != null) na.compareTo(nb) else (va.str() ?: "").lowercase().compareTo((vb.str() ?: "").lowercase())
            }
            // minSdk 23: List.reversed (stdlib), not Comparator.reversed (API 24).
            return metas.sortedWith(cmp).let { if (dir == "desc") it.reversed() else it }
        }

        private fun Array<out Pair<String, Any?>>.toQuery(): Map<String, String> {
            val out = LinkedHashMap<String, String>()
            for ((k, v) in this) if (v != null && v != "" && v !is JsonNull) out[k] = v.toString()
            return out
        }
    }
}
