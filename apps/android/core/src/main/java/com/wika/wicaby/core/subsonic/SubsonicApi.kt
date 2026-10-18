package com.wika.wicaby.core.subsonic

import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.net.ServerTransport
import com.wika.wicaby.core.plex.get
import com.wika.wicaby.core.plex.num
import com.wika.wicaby.core.plex.str
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

class SubsonicException(val code: Int, message: String) : ApiException(message, STATUS[code] ?: 500) {
    companion object {
        // Subsonic error codes → the HTTP statuses the app already understands.
        private val STATUS = mapOf(10 to 400, 20 to 400, 30 to 400, 40 to 401, 41 to 401, 42 to 401, 43 to 400, 44 to 401, 50 to 403, 60 to 403, 70 to 404)
    }
}

// A Navidrome (OpenSubsonic) server seen as a music server (music-feishin-navidrome spec §4.B), the twin of desktop
// main/connection/subsonic-client.ts: the Emby/Jellyfin-shaped calls the apps already make go through raw(), which
// calls the Subsonic API and maps its records (SubsonicMap). A route it does not know answers 404
// "NAVIDROME-UNMAPPED …". [token]: the user's password (token+salt needs it; sealed by Prefs' Vault), [userId]: the
// user name. Credentials go only in the query of a call to this server: url() and image() return unsigned URLs (Coil
// and Media3 cache keys carry none) and SubsonicInterceptor signs those hops on Core.http.
class SubsonicApi(
    server: Server,
    deviceId: String,
    token: String?,
    userId: String?,
    http: OkHttpClient = Core.http,
) : Api(server, deviceId, token, userId) {
    // A call carries the token in its URL: it never follows a redirect.
    private val http = http.newBuilder().followRedirects(false).followSslRedirects(false).build()
    private val root = server.address.trimEnd('/')

    @Volatile
    private var extensions: Set<String>? = null

    // getArtists by music folder ("" all), for 60 s.
    private val artistsCache = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, List<JsonObject>>>()

    // Plays already counted (submission=true), by PlaySessionId.
    private val counted = java.util.Collections.synchronizedSet(LinkedHashSet<String>())

    override fun authHeaders(): Map<String, String> = emptyMap()

    // Signs a URL to this server (fresh salt). Only the interceptor and call() use it, for this server's own hops.
    fun signed(url: HttpUrl): HttpUrl {
        val user = userId ?: return url
        val pw = token ?: return url
        val salt = salt()
        return url.newBuilder().addQueryParameter("u", user).addQueryParameter("t", SubsonicMap.token(pw, salt)).addQueryParameter("s", salt)
            .addQueryParameter("v", VERSION).addQueryParameter("c", "Wicaby").addQueryParameter("f", "json").build()
    }

    // A media route (direct play, download, cover) → its unsigned Subsonic URL; anything else as the base Api builds it.
    override fun url(path: String, vararg query: Pair<String, Any?>): String =
        mediaPath(path, query.associate { (k, v) -> k.replaceFirstChar(Char::uppercaseChar) to v?.toString().orEmpty() })?.let { "$root$it" } ?: super.url(path, *query)

    // ImageTags.Primary is the coverArt id; without a tag, the item's own id.
    override fun image(id: String, type: String, tag: String?, maxWidth: Int?, maxHeight: Int?): String {
        if (type != "Primary") return ""
        val raw = tag?.takeIf { it.isNotEmpty() } ?: SubsonicMap.decodeId(id)?.raw ?: return ""
        return "$root/rest/getCoverArt?" + query("id" to raw, "size" to (maxOf(maxWidth ?: 0, maxHeight ?: 0).takeIf { it > 0 } ?: 600))
    }

    internal fun mediaPath(path: String, q: Map<String, String>): String? {
        Regex("^/Items/([^/]+)/Images/Primary(?:/\\d+)?$", RegexOption.IGNORE_CASE).matchEntire(path)?.let { m ->
            val size = maxOf(q["MaxWidth"]?.toIntOrNull() ?: 0, q["MaxHeight"]?.toIntOrNull() ?: 0).takeIf { it > 0 } ?: 600
            val id = q["Tag"]?.takeIf { it.isNotEmpty() } ?: SubsonicMap.decodeId(m.groupValues[1])?.raw ?: return null
            return "/rest/getCoverArt?" + query("id" to id, "size" to size)
        }
        val m = Regex("^/(?:Audio|Items)/([^/]+)/(stream(?:\\.\\w+)?|universal|Download)$", RegexOption.IGNORE_CASE).matchEntire(path) ?: return null
        val track = SubsonicMap.decodeId(m.groupValues[1])?.takeIf { it.kind == "tr" } ?: return null
        return if (m.groupValues[2] == "Download") "/rest/download?" + query("id" to track.raw) else "/rest/stream?" + query("id" to track.raw, "format" to "raw")
    }

    override suspend fun raw(method: String, path: String, body: String?, vararg query: Pair<String, Any?>): String =
        guarded(method.uppercase(), path, norm(query.asList(), body))

    override suspend fun <T> stream(method: String, path: String, body: String?, query: List<Pair<String, Any?>>, timeoutMs: Long, read: (Response) -> T): T {
        val text = guarded(method.uppercase(), path, norm(query, body))
        return Response.Builder().request(Request.Builder().url("http://127.0.0.1/").build()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
            .body(text.toResponseBody(JSON)).build().use(read)
    }

    // ---- Subsonic ----

    // One API call: the subsonic-response body, or a SubsonicException. A list value repeats the parameter.
    suspend fun call(name: String, vararg params: Pair<String, Any?>, timeoutMs: Long = 20_000): JsonObject = withContext(Dispatchers.IO) {
        val b = "$root/rest/$name".toHttpUrl().newBuilder()
        for ((k, v) in params) when (v) {
            null -> Unit
            is List<*> -> v.forEach { b.addQueryParameter(k, it.toString()) }
            else -> if (v.toString().isNotEmpty()) b.addQueryParameter(k, v.toString())
        }
        val req = Request.Builder().url(signed(b.build())).header("Accept", "application/json").build()
        val c = http.newCall(req)
        c.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
        c.execute().use { res ->
            if (!res.isSuccessful) throw ApiException("HTTP ${res.code}", res.code)
            val r = runCatching { Json.parseToJsonElement(res.body.string()).jsonObject["subsonic-response"] as? JsonObject }.getOrNull()
                ?: throw ApiException("Not a Subsonic answer", 502)
            if (r["status"].str() != "ok") throw SubsonicException(r["error"]["code"].num()?.toInt() ?: 0, r["error"]["message"].str() ?: "Subsonic error")
            r
        }
    }

    private suspend fun ext(): Set<String> = extensions ?: runCatching { SubsonicMap.arr(call("getOpenSubsonicExtensions")["openSubsonicExtensions"]).mapNotNull { it["name"].str() }.toSet() }
        .getOrElse { emptySet() }.also { extensions = it }

    private suspend fun artists(folder: String = ""): List<JsonObject> {
        artistsCache[folder]?.takeIf { System.currentTimeMillis() - it.first < 60_000 }?.let { return it.second }
        val list = SubsonicMap.arr(call("getArtists", "musicFolderId" to folder.ifEmpty { null })["artists"]["index"]).flatMap { SubsonicMap.arr(it["artist"]) }
        artistsCache[folder] = System.currentTimeMillis() to list
        return list
    }

    private suspend fun album(raw: String): JsonElement = call("getAlbum", "id" to raw)["album"] ?: JsonObject(emptyMap())
    private suspend fun playlist(raw: String): JsonElement = call("getPlaylist", "id" to raw)["playlist"] ?: JsonObject(emptyMap())
    private suspend fun albumList(args: Map<String, String>, folder: String?, size: Int, offset: Int): List<JsonObject> =
        SubsonicMap.arr(call("getAlbumList2", *args.toList().toTypedArray(), "size" to size, "offset" to offset, "musicFolderId" to folder)["albumList2"]["album"])

    // ---- The Emby routes ----

    private fun normalise(path: String) = path.substringBefore('?')
        .replace(Regex("^/Users/[^/]+(?=/(?:Views|Items|FavoriteItems|PlayedItems)(?:/|$))"), "")
        .replace(Regex("^/UserViews$"), "/Views")
        .replace(Regex("^/User(Favorite|Played)Items/"), "/$1Items/")
        .replace(Regex("^/UserItems/Resume$"), "/Items/Resume")

    // Error 50 on a playlist edit: someone else's playlist (only its owner can change it on Navidrome).
    private suspend fun guarded(method: String, rawPath: String, q: Map<String, String>): String = try {
        answer(method, rawPath, q)
    } catch (e: SubsonicException) {
        if (e.code == 50 && "Playlists" in rawPath) throw ApiException(Core.str(com.wika.wicaby.core.R.string.navidrome_not_owner), 403)
        throw e
    }

    private suspend fun answer(method: String, rawPath: String, q: Map<String, String>): String {
        val parts = normalise(rawPath).trim('/').split('/').filter { it.isNotEmpty() }.map { java.net.URLDecoder.decode(it, "UTF-8") }
        val shape = parts.mapIndexed { i, p -> if (i > 0 && parts[i - 1] in ID_BEFORE && p !in setOf("Resume", "Latest")) "{id}" else p }.joinToString("/", "/")
        val id = parts.getOrNull(1).orEmpty()
        val folder = SubsonicMap.decodeId(q["ParentId"])?.takeIf { it.kind == "mf" }?.raw
        // The stored sign-in's check: the password still works.
        if (method == "GET" && parts.size == 2 && parts[0] == "Users" && parts[1] != "Public") {
            call("ping")
            return userJson(userId.orEmpty()).toString()
        }
        return when ("$method $shape") {
            // Subsonic lists no users before sign-in: the name and password form.
            "GET /Users/Public" -> "[]"
            "POST /Users/AuthenticateByName" -> signIn(q["Username"].orEmpty(), q["Pw"].orEmpty())
            "GET /Views" -> result(SubsonicMap.arr(call("getMusicFolders")["musicFolders"]["musicFolder"]).map(SubsonicMap::folder))
            "GET /Items/Resume", "GET /Shows/NextUp", "GET /Shows/Upcoming", "GET /Items/{id}/Similar", "GET /Years" -> result(emptyList())
            "GET /Items/{id}/SpecialFeatures", "GET /Items/{id}/LocalTrailers" -> "[]"
            "GET /Items/Latest" -> JsonArray(albumList(mapOf("type" to "newest"), folder, q["Limit"]?.toIntOrNull() ?: 24, 0).map(::album2)).toString()
            "GET /Items" -> items(q)
            "GET /Items/{id}" -> mapped(id).toString()
            "GET /Items/{id}/InstantMix" -> result(instantMix(id, q["Limit"]?.toIntOrNull() ?: 100))
            "GET /Artists", "GET /Artists/AlbumArtists" -> page(nameFiltered(artists(folder.orEmpty()).map(::artist2), q), q)
            "GET /Genres", "GET /MusicGenres" -> result(SubsonicMap.arr(call("getGenres")["genres"]["genre"]).map(SubsonicMap::genre).sortedBy { it["Name"].str() })
            "GET /Audio/{id}/Lyrics" -> lyrics(id) // the adapter answers it, never isEmby
            "GET /Playlists/{id}/Items" -> entries(id)
            "POST /Playlists" -> createPlaylist(q)
            "POST /Playlists/{id}/Items" -> { addToPlaylist(id, q["Ids"].orEmpty()); "" }
            "DELETE /Playlists/{id}/Items" -> { removeFromPlaylist(id, q["EntryIds"].orEmpty()); "" }
            "POST /Playlists/{id}/Items/{id}/Move/{id}" -> { moveInPlaylist(id, parts[3], parts[5].toIntOrNull() ?: unmapped(method, rawPath)); "" }
            "POST /FavoriteItems/{id}", "DELETE /FavoriteItems/{id}" -> setStar(id, method == "POST")
            "POST /PlayedItems/{id}" -> { scrobble(id, true); buildJsonObject { put("Played", true) }.toString() }
            // Subsonic cannot unplay: the play count stays.
            "DELETE /PlayedItems/{id}" -> buildJsonObject { put("Played", false) }.toString()
            "GET /Items/{id}/PlaybackInfo", "POST /Items/{id}/PlaybackInfo" -> buildJsonObject {
                put("MediaSources", mapped(id)["MediaSources"] ?: JsonArray(emptyList()))
                put("PlaySessionId", salt() + salt())
            }.toString()
            "POST /Sessions/Playing" -> { scrobble(q["ItemId"].orEmpty(), false); "" }
            "POST /Sessions/Playing/Stopped" -> { stopped(q); "" }
            "POST /Sessions/Playing/Progress", "POST /Sessions/Playing/Ping", "POST /Sessions/Capabilities/Full", "POST /Sessions/Capabilities" -> ""
            else -> unmapped(method, rawPath)
        }
    }

    // Sign-in: a ping with token auth. The password is the session's token (t = md5(password + salt) needs it;
    // Prefs seals it with the Vault); it never travels itself. Error 41: LDAP accounts refuse token auth.
    private suspend fun signIn(name: String, pw: String): String {
        try {
            SubsonicApi(server, deviceId, pw, name, http).call("ping")
        } catch (e: SubsonicException) {
            if (e.code == 41) throw ApiException(Core.str(com.wika.wicaby.core.R.string.navidrome_token_unsupported), 400)
            throw e
        }
        return buildJsonObject {
            put("AccessToken", pw)
            put("User", userJson(name))
        }.toString()
    }

    private fun userJson(name: String) = buildJsonObject {
        put("Id", name)
        put("Name", name)
        put("HasPassword", true)
    }

    private fun unmapped(method: String, path: String): Nothing = throw ApiException("NAVIDROME-UNMAPPED $method $path", 404)

    // Every mapped item names this server (as Emby's items do).
    private fun JsonObject.stamped() = JsonObject(this + ("ServerId" to JsonPrimitive(server.id)))
    private fun artist2(r: JsonElement) = SubsonicMap.artist(r).stamped()
    private fun album2(r: JsonElement) = SubsonicMap.album(r).stamped()
    private fun song2(r: JsonElement, entry: Int? = null) = SubsonicMap.song(r, entry).stamped()

    private fun result(items: List<JsonObject>, total: Int = items.size, start: Int = 0) = buildJsonObject {
        put("Items", JsonArray(items.map { if (it["ServerId"] == null) it.stamped() else it }))
        put("TotalRecordCount", total)
        put("StartIndex", start)
    }.toString()

    private fun page(all: List<JsonObject>, q: Map<String, String>): String {
        val start = q["StartIndex"]?.toIntOrNull() ?: 0
        val limit = q["Limit"]?.toIntOrNull() ?: all.size
        return result(all.drop(start).take(limit), all.size, start)
    }

    private fun nameFiltered(items: List<JsonObject>, q: Map<String, String>): List<JsonObject> = items.filter { x ->
        val n = x["Name"].str().orEmpty().lowercase()
        (q["NameStartsWith"]?.let { n.startsWith(it.lowercase()) } ?: true) && (q["NameLessThan"]?.let { n < it.lowercase() } ?: true) &&
            (q["NameStartsWithOrGreater"]?.let { n >= it.lowercase() } ?: true)
    }

    private suspend fun mapped(id: String): JsonObject {
        val d = SubsonicMap.decodeId(id) ?: throw ApiException("Not found", 404)
        return when (d.kind) {
            "tr" -> song2(call("getSong", "id" to d.raw)["song"] ?: JsonObject(emptyMap()))
            "al" -> album2(album(d.raw))
            "ar" -> coroutineScope {
                val info = async { runCatching { call("getArtistInfo2", "id" to d.raw) }.getOrNull() }
                val a = artist2(call("getArtist", "id" to d.raw)["artist"] ?: JsonObject(emptyMap()))
                SubsonicMap.plainText(info.await()?.get("artistInfo2")?.get("biography").str())?.let { JsonObject(a + ("Overview" to JsonPrimitive(it))) } ?: a
            }
            "pl" -> SubsonicMap.playlist(playlist(d.raw)).stamped()
            "mf" -> SubsonicMap.arr(call("getMusicFolders")["musicFolders"]["musicFolder"]).firstOrNull { it["id"].str() == d.raw }?.let { SubsonicMap.folder(it).stamped() }
                ?: throw ApiException("Not found", 404)
            "ge" -> SubsonicMap.genre(buildJsonObject { put("value", d.raw) }).stamped()
            else -> throw ApiException("Not found", 404)
        }
    }

    private suspend fun items(q: Map<String, String>): String {
        val types = q["IncludeItemTypes"].orEmpty().split(',').filter { it.isNotEmpty() }
        fun wants(t: String) = types.isEmpty() || t in types
        val parent = SubsonicMap.decodeId(q["ParentId"])
        val folder = parent?.takeIf { it.kind == "mf" }?.raw
        val limit = q["Limit"]?.toIntOrNull() ?: 100
        val start = q["StartIndex"]?.toIntOrNull() ?: 0

        q["Ids"]?.let { ids ->
            val got = coroutineScope { ids.split(',').filter { it.isNotEmpty() }.map { x -> async { runCatching { mapped(x) }.getOrNull() } }.awaitAll() }
            return result(got.filterNotNull())
        }
        q["SearchTerm"]?.let { term ->
            val r = call("search3", "query" to term, "artistCount" to if (wants("MusicArtist")) limit else 0, "albumCount" to if (wants("MusicAlbum")) limit else 0,
                "songCount" to if (wants("Audio")) limit else 0, "musicFolderId" to folder)["searchResult3"]
            return result((SubsonicMap.arr(r["artist"]).map(::artist2) + SubsonicMap.arr(r["album"]).map(::album2) + SubsonicMap.arr(r["song"]).map { song2(it) }).take(limit))
        }
        if (parent?.kind == "pl") return entries(q["ParentId"]!!)
        if (types == listOf("Playlist")) return page(SubsonicMap.arr(call("getPlaylists")["playlists"]["playlist"]).map { SubsonicMap.playlist(it).stamped() }, q)
        if (types.isNotEmpty() && types.none { it in setOf("MusicAlbum", "Audio", "MusicArtist") }) return result(emptyList())

        val albumIds = if (parent?.kind == "al") listOf(parent.raw) else q["AlbumIds"]?.split(',')?.mapNotNull { SubsonicMap.decodeId(it)?.raw }.orEmpty()
        if (albumIds.isNotEmpty()) return page(albumIds.flatMap { SubsonicMap.arr(album(it)["song"]).map { s -> song2(s) } }, q)
        val artistRef = if (parent?.kind == "ar") parent.raw else SubsonicMap.decodeId((q["AlbumArtistIds"] ?: q["ArtistIds"])?.substringBefore(','))?.raw
        if (artistRef != null || q["ContributingArtistIds"] != null) {
            // shortcut: Subsonic lists an artist's own albums only; "appears on" (ContributingArtistIds) answers none.
            if (artistRef == null) return result(emptyList())
            val albums = SubsonicMap.arr(call("getArtist", "id" to artistRef)["artist"]["album"])
            if (wants("MusicAlbum") && "Audio" !in types) return page(albums.map(::album2), q)
            return page(albums.flatMap { a -> SubsonicMap.arr(album(a["id"].str().orEmpty())["song"]).map { song2(it) } }, q)
        }
        if (q["Filters"]?.contains("IsFavorite") == true || q["IsFavorite"] == "true") {
            val r = call("getStarred2", "musicFolderId" to folder)["starred2"]
            val out = when {
                "Audio" in types -> SubsonicMap.arr(r["song"]).map { song2(it) }
                "MusicArtist" in types -> SubsonicMap.arr(r["artist"]).map(::artist2)
                "MusicAlbum" in types -> SubsonicMap.arr(r["album"]).map(::album2)
                else -> SubsonicMap.arr(r["artist"]).map(::artist2) + SubsonicMap.arr(r["album"]).map(::album2) + SubsonicMap.arr(r["song"]).map { song2(it) }
            }
            return page(out, q)
        }
        if (types.firstOrNull() == "MusicArtist") return page(artists(folder.orEmpty()).map(::artist2), q)
        if ("Audio" in types) {
            val genre = q["Genres"]?.substringBefore('|') ?: parent?.takeIf { it.kind == "ge" }?.raw ?: SubsonicMap.decodeId(q["GenreIds"]?.substringBefore(','))?.raw
            val songs = if (genre != null) SubsonicMap.arr(call("getSongsByGenre", "genre" to genre, "count" to limit, "offset" to start, "musicFolderId" to folder)["songsByGenre"]["song"])
            else SubsonicMap.arr(call("search3", "query" to "", "artistCount" to 0, "albumCount" to 0, "songCount" to limit, "songOffset" to start, "musicFolderId" to folder)["searchResult3"]["song"])
            // shortcut: Subsonic gives no song total; one more page is promised while pages come back full.
            return result(songs.map { song2(it) }, start + songs.size + if (songs.size == limit) limit else 0, start)
        }
        val args = SubsonicMap.albumListArgs(if (parent?.kind == "ge") q + ("Genres" to parent.raw) else q)
        if (args["type"] in setOf("alphabeticalByName", "alphabeticalByArtist", "newest", "random")) {
            val albums = albumList(args, folder, limit, start)
            // The total: every album artist's album count (Navidrome's getArtists lists album artists).
            val total = artists(folder.orEmpty()).sumOf { it["albumCount"].num()?.toInt() ?: 0 }
            return result(albums.map(::album2), maxOf(total, start + albums.size), start)
        }
        // Filtered or by play counts: the whole list (500 a page, at most 5,000), paged here.
        val all = mutableListOf<JsonObject>()
        var offset = 0
        while (offset < 5000) {
            val got = albumList(args, folder, 500, offset)
            all += got
            if (got.size < 500) break
            offset += 500
        }
        return page(all.map(::album2), q)
    }

    private suspend fun entries(playlistId: String): String {
        val d = SubsonicMap.decodeId(playlistId)?.takeIf { it.kind == "pl" } ?: throw ApiException("Not found", 404)
        return result(SubsonicMap.arr(playlist(d.raw)["entry"]).mapIndexed { i, s -> song2(s, i) })
    }

    // Album, artist and playlist ids stand for their tracks (Emby takes them in a playlist add).
    private suspend fun songIds(ids: String): List<String> = ids.split(',').filter { it.isNotEmpty() }.flatMap { x ->
        val d = SubsonicMap.decodeId(x)
        when (d?.kind) {
            "tr" -> listOf(d.raw)
            "al" -> SubsonicMap.arr(album(d.raw)["song"]).mapNotNull { it["id"].str() }
            "pl" -> SubsonicMap.arr(playlist(d.raw)["entry"]).mapNotNull { it["id"].str() }
            "ar" -> SubsonicMap.arr(call("getArtist", "id" to d.raw)["artist"]["album"]).flatMap { a -> SubsonicMap.arr(album(a["id"].str().orEmpty())["song"]).mapNotNull { it["id"].str() } }
            else -> throw ApiException("Not a track: $x", 400)
        }
    }

    private suspend fun createPlaylist(q: Map<String, String>): String {
        val r = call("createPlaylist", "name" to q["Name"].orEmpty(), "songId" to songIds(q["Ids"].orEmpty()))
        return buildJsonObject { r["playlist"]["id"].str()?.let { put("Id", SubsonicMap.encodeId("pl", it)) } }.toString()
    }

    private suspend fun addToPlaylist(playlistId: String, ids: String) {
        val d = SubsonicMap.decodeId(playlistId)?.takeIf { it.kind == "pl" } ?: throw ApiException("Not found", 404)
        call("updatePlaylist", "playlistId" to d.raw, "songIdToAdd" to songIds(ids))
    }

    // Entry ids are pe_<index>; removed from the end first so the indexes stay valid whatever the server does.
    private suspend fun removeFromPlaylist(playlistId: String, entryIds: String) {
        val d = SubsonicMap.decodeId(playlistId)?.takeIf { it.kind == "pl" } ?: throw ApiException("Not found", 404)
        val idx = entryIds.split(',').mapNotNull { SubsonicMap.decodeId(it)?.takeIf { e -> e.kind == "pe" }?.raw?.toIntOrNull() }.sortedDescending()
        if (idx.isNotEmpty()) call("updatePlaylist", "playlistId" to d.raw, "songIndexToRemove" to idx)
    }

    // Subsonic has no move: the playlist is rewritten in the new order (createPlaylist with playlistId).
    private suspend fun moveInPlaylist(playlistId: String, entryId: String, newIndex: Int) {
        val d = SubsonicMap.decodeId(playlistId)?.takeIf { it.kind == "pl" } ?: throw ApiException("Not found", 404)
        val from = SubsonicMap.decodeId(entryId)?.raw?.toIntOrNull() ?: throw ApiException("Not found", 404)
        val songs = SubsonicMap.arr(playlist(d.raw)["entry"]).mapNotNull { it["id"].str() }.toMutableList()
        if (from !in songs.indices) throw ApiException("Not found", 404)
        val moved = songs.removeAt(from)
        songs.add(newIndex.coerceIn(0, songs.size), moved)
        call("createPlaylist", "playlistId" to d.raw, "songId" to songs)
    }

    private suspend fun setStar(id: String, on: Boolean): String {
        val d = SubsonicMap.decodeId(id)
        val param = when (d?.kind) { "tr" -> "id"; "al" -> "albumId"; "ar" -> "artistId"; else -> throw ApiException("Not found", 404) }
        call(if (on) "star" else "unstar", param to d.raw)
        return buildJsonObject { put("IsFavorite", on) }.toString()
    }

    private suspend fun scrobble(itemId: String, submission: Boolean) {
        val d = SubsonicMap.decodeId(itemId)?.takeIf { it.kind == "tr" } ?: return
        call("scrobble", "id" to d.raw, "submission" to submission, "time" to if (submission) System.currentTimeMillis() else null)
    }

    // A play ended: it counts once it reached half the track or 4 minutes, once per PlaySessionId.
    private suspend fun stopped(q: Map<String, String>) {
        val itemId = q["ItemId"] ?: return
        if (SubsonicMap.decodeId(itemId)?.kind != "tr") return
        val play = q["PlaySessionId"]?.takeIf { it.isNotEmpty() } ?: "$itemId:${System.currentTimeMillis()}"
        if (play in counted) return
        val runTime = q["RunTimeTicks"]?.toLongOrNull() ?: runCatching { mapped(itemId)["RunTimeTicks"].num()?.toLong() }.getOrNull()
        if (!SubsonicMap.scrobbleDue(q["PositionTicks"]?.toLongOrNull(), runTime)) return
        counted += play
        synchronized(counted) { if (counted.size > 500) counted.remove(counted.first()) }
        scrobble(itemId, true)
    }

    private suspend fun instantMix(id: String, limit: Int): List<JsonObject> {
        val d = SubsonicMap.decodeId(id)
        fun songs(r: JsonObject?, key: String) = SubsonicMap.arr(r?.get(key)?.get("song"))
        var out: List<JsonObject> = when (d?.kind) {
            "tr", "al" -> songs(runCatching { call("getSimilarSongs", "id" to d.raw, "count" to limit) }.getOrNull(), "similarSongs")
            "ar" -> songs(runCatching { call("getSimilarSongs2", "id" to d.raw, "count" to limit) }.getOrNull(), "similarSongs2").ifEmpty {
                songs(call("getTopSongs", "artist" to call("getArtist", "id" to d.raw)["artist"]["name"].str().orEmpty(), "count" to limit), "topSongs")
            }
            "pl" -> SubsonicMap.arr(playlist(d.raw)["entry"])
            else -> emptyList()
        }
        // No similar songs (no Last.fm agent on the server): random songs of the seed's genre, its own tracks first.
        if (out.isEmpty()) {
            val genre = if (d?.kind == "ge") d.raw else runCatching { mapped(id)["Genres"].let { (it as? JsonArray)?.firstOrNull().str() } }.getOrNull()
            val own = when (d?.kind) {
                "al" -> SubsonicMap.arr(album(d.raw)["song"])
                "tr" -> SubsonicMap.arr(call("getSong", "id" to d.raw)["song"])
                else -> emptyList()
            }
            val random = songs(call("getRandomSongs", "size" to limit, "genre" to genre), "randomSongs")
            out = own + random.filter { r -> own.none { it["id"].str() == r["id"].str() } }
        }
        return out.take(limit).map { song2(it) }
    }

    private suspend fun lyrics(id: String): String {
        val d = SubsonicMap.decodeId(id)?.takeIf { it.kind == "tr" } ?: throw ApiException("Not found", 404)
        val mapped = if ("songLyrics" in ext()) SubsonicMap.lyricsToJellyfin(SubsonicMap.arr(call("getLyricsBySongId", "id" to d.raw)["lyricsList"]["structuredLyrics"]))
        else {
            val song = call("getSong", "id" to d.raw)["song"]
            SubsonicMap.lyricsToJellyfin(null, call("getLyrics", "artist" to song["artist"].str().orEmpty(), "title" to song["title"].str().orEmpty())["lyrics"]["value"].str())
        }
        return mapped?.toString() ?: throw ApiException("Not found", 404)
    }

    companion object {
        const val VERSION = "1.16.1"
        private val JSON = "application/json".toMediaType()
        private val ID_BEFORE = setOf("Items", "Playlists", "FavoriteItems", "PlayedItems", "Audio", "Move")
        private val random = SecureRandom()

        internal fun salt(): String = ByteArray(8).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }

        private fun query(vararg p: Pair<String, Any>): String =
            p.joinToString("&") { (k, v) -> "$k=" + java.net.URLEncoder.encode(v.toString(), "UTF-8").replace("+", "%20") }

        // Query names in one case (Emby sends ParentId, Jellyfin parentId) plus a JSON body's fields; the query wins.
        internal fun norm(query: List<Pair<String, Any?>>, body: String?): Map<String, String> {
            val out = LinkedHashMap<String, String>()
            fun put(k: String, v: String?) { if (!v.isNullOrEmpty()) out[k.replaceFirstChar(Char::uppercaseChar)] = v }
            body?.takeIf { it.isNotBlank() }?.let { runCatching { Json.parseToJsonElement(it) as? JsonObject }.getOrNull() }?.forEach { (k, v) ->
                put(k, if (v is JsonArray) v.mapNotNull { it.str() }.joinToString(",") else v.str())
            }
            for ((k, v) in query) put(k, v?.toString())
            return out
        }
    }
}

// Signs Subsonic media hops (stream, download, cover art) on Core.http: a hop to a signed-in Navidrome server's own
// origin (or its mesh forwarder) whose path is under /rest/ and carries no token gets u/t/s added, so the URLs Coil and
// Media3 hold carry none. Nothing is added for any other host.
class SubsonicInterceptor(
    private val transport: () -> ServerTransport,
    private val others: () -> List<Api> = { emptyList() },
    private val active: () -> Api?,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        if (!req.url.encodedPath.contains("/rest/") || req.url.queryParameter("t") != null) return chain.proceed(req)
        val t = transport()
        val api = (listOfNotNull(active()) + others()).filterIsInstance<SubsonicApi>()
            .firstOrNull { a -> a.server.origin?.let { com.wika.wicaby.core.data.isServerUrl(req.url, it, t) } == true }
            ?: return chain.proceed(req)
        return chain.proceed(req.newBuilder().url(api.signed(req.url)).build())
    }
}
