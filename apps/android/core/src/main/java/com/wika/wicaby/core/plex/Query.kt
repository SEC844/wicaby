package com.wika.wicaby.core.plex

import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.livetv.encodeUriComponent
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlin.math.floor

// The request the adapter sends to a PMS (the twin of desktop shared/plex/query.ts PmsReq).
data class PmsReq(
    val method: String,
    val path: String,
    val query: Map<String, String> = emptyMap(),
    val headers: Map<String, String>? = null,
    // "sections": run once per library section (path has "{section}") and merge (Recursive with no ParentId).
    val fanOut: String? = null,
    // The answer is /hubs/search's Hub[]: flatten its Metadata.
    val hubs: Boolean = false,
    // Genre names to turn into PMS genre ids before sending (withGenreIds).
    val genres: List<String>? = null,
    // The answer is Metadata[0].OnDeck.Metadata (a show's next episode).
    val onDeck: Boolean = false,
    // Favorites (D-6): only the items on the user's plex.tv watchlist.
    val watchlist: Boolean = false,
    // Keep only the items of these Emby types (the PMS endpoint cannot filter by type).
    val keep: List<String>? = null,
) {
    fun toJson(): JsonObject {
        val out = obj()
        out["method"] = js(method)
        out["path"] = js(path)
        out["query"] = query.toJson()
        headers?.let { out["headers"] = it.toJson() }
        fanOut?.let { out["fanOut"] = js(it) }
        if (hubs) out["hubs"] = jb(true)
        genres?.let { out["genres"] = jstrs(it) }
        if (onDeck) out["onDeck"] = jb(true)
        if (watchlist) out["watchlist"] = jb(true)
        keep?.let { out["keep"] = jstrs(it) }
        return out.json()
    }

    companion object {
        fun fromJson(e: JsonElement?): PmsReq = PmsReq(
            e["method"].str() ?: "GET", e["path"].str() ?: "", (e["query"] as? JsonObject).toQuery(),
            (e["headers"] as? JsonObject)?.toQuery(), e["fanOut"].str(), e["hubs"].truthy(),
            e["genres"]?.list()?.mapNotNull { it.str() }, e["onDeck"].truthy(), e["watchlist"].truthy(), e["keep"]?.list()?.mapNotNull { it.str() },
        )
    }
}

// A route or query the dialect does not translate: 404 "PLEX-UNMAPPED …", which the UI already reads as "not
// supported here" (an ApiException, so every existing 404 fallback applies).
class PlexUnmapped(what: String) : ApiException("PLEX-UNMAPPED $what", 404)

// Emby query → PMS request (plex-spec §4 "Query mapping", §6.5, §6.6). A query key the dialect does not know throws
// PlexUnmapped instead of being dropped: an ignored filter would be a wrong answer. Pure.
object PlexQuery {
    const val LIBRARY_ID = "com.plexapp.plugins.library"

    // Emby item type → PMS numeric type (declaration order is the "keep" order).
    val PLEX_TYPE: Map<String, Int> = linkedMapOf(
        "Movie" to 1, "Series" to 2, "Season" to 3, "Episode" to 4, "MusicArtist" to 8, "MusicAlbum" to 9, "Audio" to 10,
        "Photo" to 13, "PhotoAlbum" to 14, "BoxSet" to 18,
    )

    private val SORT = mapOf(
        "SortName" to "titleSort", "Name" to "title", "DateCreated" to "addedAt", "DateLastContentAdded" to "addedAt",
        "PremiereDate" to "originallyAvailableAt", "ProductionYear" to "year", "CommunityRating" to "audienceRating",
        "CriticRating" to "rating", "OfficialRating" to "contentRating", "DatePlayed" to "lastViewedAt", "Random" to "random",
        "Runtime" to "duration", "PlayCount" to "viewCount", "IndexNumber" to "index", "ParentIndexNumber" to "parentIndex",
        "Album" to "album.titleSort", "AlbumArtist" to "artist.titleSort",
    )

    // Keys that change nothing PMS needs to know: fields, image hints, user ids, Emby-only switches.
    private val IGNORED = listOf(
        "Fields", "EnableImageTypes", "ImageTypeLimit", "EnableImages", "EnableUserData", "EnableTotalRecordCount", "UserId",
        "CollapseBoxSetItems", "GroupItemsIntoCollections", "IsFolder", "GroupItems", "ExcludeLocationTypes", "IsMissing",
        "IsVirtualUnaired", "HasQueryLimit", "EnableResumable", "EnableRewatching", "DisableFirstEpisode", "api_key",
    ).map { it.lowercase() }.toSet()

    // Query keys are case-insensitive on Emby: read them that way.
    private class Reader(query: Map<String, String>) {
        private val lower = LinkedHashMap<String, String>().also { m -> for ((k, v) in query) if (v.isNotEmpty()) m[k.lowercase()] = v }
        fun get(k: String): String = lower[k.lowercase()] ?: ""
        fun rest(used: List<String>): List<String> = lower.keys.filter { k -> k !in IGNORED && used.none { it.lowercase() == k } }
    }

    private val SEP = Regex("[,|]")

    private fun list(v: String): List<String> = v.split(SEP).map { it.trim() }.filter { it.isNotEmpty() }

    // The ratingKey (or person id) behind an Emby-side id; anything else is unmapped, never guessed.
    private fun keyOf(id: String, what: String, kind: String = "item"): String {
        val p = PlexMap.parseId(id)
        if (p == null || p.kind != kind) throw PlexUnmapped("$what=$id")
        return p.key
    }

    fun itemKey(id: String): String = keyOf(id, "Id")

    private fun intText(d: Double) = jsNumberText(d)

    private fun paging(r: Reader): Map<String, String>? {
        val start = maxOf(0.0, floor(orZero(jsNumber(r.get("StartIndex")))))
        val limit = floor(orZero(jsNumber(r.get("Limit"))))
        if (start == 0.0 && limit == 0.0) return null
        val h = linkedMapOf("X-Plex-Container-Start" to intText(start))
        if (limit > 0) h["X-Plex-Container-Size"] = intText(limit)
        return h
    }

    private val DESC = Regex("^desc", RegexOption.IGNORE_CASE)

    private fun sortOf(sortBy: String, order: String): String? {
        val desc = DESC.containsMatchIn(list(order).firstOrNull() ?: "")
        val keys = list(sortBy).mapNotNull { SORT[it] }
        if (keys.isEmpty()) return null
        return keys.joinToString(",") { if (it == "random") it else "$it:${if (desc) "desc" else "asc"}" }
    }

    // Emby types no PMS library lists: asking for them alongside others changes no answer.
    private val NONE_ON_PLEX = setOf("Book", "Video")

    private fun typesOf(v: String): List<Int> {
        val asked = list(v).filter { it !in NONE_ON_PLEX }
        if (asked.isEmpty()) throw PlexUnmapped("IncludeItemTypes=$v")
        val out = ArrayList<Int>()
        for (t in asked) {
            val n = PLEX_TYPE[t] ?: throw PlexUnmapped("IncludeItemTypes=$t")
            if (n !in out) out += n
        }
        return out
    }

    private fun keepOf(types: List<Int>): List<String> = PLEX_TYPE.filter { it.value in types }.keys.toList()

    // GET /Users/{u}/Items (and Jellyfin's /Items): the library browser, search, a person's films, a collection.
    fun itemsRequest(query: Map<String, String>): PmsReq {
        val r = Reader(query)
        val used = listOf(
            "ParentId", "IncludeItemTypes", "SortBy", "SortOrder", "Filters", "Genres", "PersonIds", "Ids", "StartIndex", "Limit",
            "NameStartsWith", "Recursive", "SearchTerm", "Years", "ArtistIds", "AlbumArtistIds", "IsPlayed", "IsFavorite",
        )
        val unknown = r.rest(used)
        if (unknown.isNotEmpty()) throw PlexUnmapped("/Items ${unknown.joinToString(",")}")
        if (r.get("SearchTerm").isNotEmpty()) return searchRequest(r)
        // The playlists row and picker: PMS keeps playlists outside the sections.
        if (r.get("IncludeItemTypes") == "Playlist" && r.get("ParentId").isEmpty() && r.get("Ids").isEmpty()) return PmsReq("GET", "/playlists", headers = paging(r))
        val favorites = "IsFavorite" in list(r.get("Filters")) || r.get("IsFavorite") == "true"
        val out = itemsBrowse(r)
        return if (favorites) out.copy(watchlist = true) else out
    }

    private fun itemsBrowse(r: Reader): PmsReq {
        val headers = paging(r)
        val types = if (r.get("IncludeItemTypes").isNotEmpty()) typesOf(r.get("IncludeItemTypes")) else emptyList()
        // Several types, or a path that ignores `type` (children, Ids): PMS cannot filter, the adapter does.
        val keep = if (types.isNotEmpty()) keepOf(types) else null
        val ids = r.get("Ids")
        if (ids.isNotEmpty()) return PmsReq("GET", "/library/metadata/${list(ids).joinToString(",") { keyOf(it, "Ids") }}", headers = headers, keep = keep)
        val q = LinkedHashMap<String, String>()
        if (types.size == 1) q["type"] = "${types[0]}"
        sortOf(r.get("SortBy"), r.get("SortOrder"))?.let { q["sort"] = it }
        for (f in list(r.get("Filters"))) when (f) {
            "IsUnplayed" -> q["unwatched"] = "1"
            "IsPlayed" -> q["viewCount>>"] = "0"
            "IsResumable" -> q["inProgress"] = "1"
            "IsFolder", "IsNotFolder", "IsFavorite" -> Unit
            else -> throw PlexUnmapped("Filters=$f")
        }
        if (r.get("IsPlayed") == "true") q["viewCount>>"] = "0"
        if (r.get("IsPlayed") == "false") q["unwatched"] = "1"
        val people = list(r.get("PersonIds")).map { keyOf(it, "PersonIds", "person") }
        if (people.isNotEmpty()) q["actor"] = people.joinToString(",")
        val years = list(r.get("Years"))
        if (years.isNotEmpty()) q["year"] = years.joinToString(",")
        val genres = list(r.get("Genres")).ifEmpty { null }
        val parent = r.get("ParentId")
        val artist = r.get("ArtistIds").ifEmpty { r.get("AlbumArtistIds") }
        if (artist.isNotEmpty()) {
            // An artist's albums are its children, its tracks its leaves.
            val key = keyOf(list(artist).first(), "ArtistIds")
            return PmsReq("GET", "/library/metadata/$key/${if (10 in types) "allLeaves" else "children"}", sortOnly(q), headers, genres = genres, keep = keep)
        }
        if (parent.isEmpty()) {
            if (r.get("Recursive") != "true") throw PlexUnmapped("/Items without ParentId")
            return PmsReq("GET", "/library/sections/{section}/all", q, headers, fanOut = "sections", genres = genres, keep = keep)
        }
        val p = PlexMap.parseId(parent)
        if (p == null || p.kind == "person") throw PlexUnmapped("ParentId=$parent")
        if (p.kind == "section") {
            val first = r.get("NameStartsWith")
            if (first.isNotEmpty()) return PmsReq("GET", "/library/sections/${p.key}/firstCharacter/${encodeUriComponent(first.substring(0, 1).uppercase())}", q, headers, genres = genres, keep = keep)
            return PmsReq("GET", "/library/sections/${p.key}/all", q, headers, genres = genres, keep = keep)
        }
        // A show, season, album or collection: its children (Recursive: its leaves, e.g. every episode of a show).
        val leaves = r.get("Recursive") == "true" && types.any { it == 4 || it == 10 }
        return PmsReq("GET", "/library/metadata/${p.key}/${if (leaves) "allLeaves" else "children"}", sortOnly(q), headers, genres = genres, keep = keep)
    }

    // SearchTerm → /hubs/search, which takes a term, a section and a per-hub limit, nothing else.
    private fun searchRequest(r: Reader): PmsReq {
        val other = r.rest(listOf("SearchTerm", "IncludeItemTypes", "Limit", "Recursive", "ParentId", "StartIndex"))
        if (other.isNotEmpty()) throw PlexUnmapped("/Items SearchTerm with ${other.joinToString(",")}")
        if (jsNumber(r.get("StartIndex")) > 0) throw PlexUnmapped("/Items SearchTerm with StartIndex")
        val limit = orZero(jsNumber(r.get("Limit"))).let { if (it == 0.0) 20.0 else floor(it) }
        val q = linkedMapOf("query" to r.get("SearchTerm"), "limit" to intText(limit))
        val parent = r.get("ParentId")
        if (parent.isNotEmpty()) {
            val p = PlexMap.parseId(parent)
            if (p?.kind != "section") throw PlexUnmapped("SearchTerm ParentId=$parent")
            q["sectionId"] = p.key
        }
        val types = if (r.get("IncludeItemTypes").isNotEmpty()) typesOf(r.get("IncludeItemTypes")) else emptyList()
        return PmsReq("GET", "/hubs/search", q, hubs = true, keep = if (types.isNotEmpty()) keepOf(types) else null)
    }

    // Children endpoints take only a sort (and the user filters): drop the type the path already implies.
    private fun sortOnly(q: Map<String, String>): Map<String, String> = q - "type"

    // Genre names → PMS ids, once the adapter has read the section's genre directory.
    fun withGenreIds(r: PmsReq, directory: List<JsonElement>): PmsReq {
        val genres = r.genres?.takeIf { it.isNotEmpty() } ?: return r
        val ids = genres.map { name ->
            val hit = directory.firstOrNull { (it["title"].str() ?: "").lowercase() == name.lowercase() } ?: throw PlexUnmapped("Genres=$name")
            (hit["id"] ?: hit["key"]).str().toString()
        }
        return r.copy(genres = null, query = r.query + ("genre" to ids.joinToString(",")))
    }

    // GET /Users/{u}/Items/Latest: per section when ParentId is one.
    fun latestRequest(query: Map<String, String>): PmsReq {
        val r = Reader(query)
        val unknown = r.rest(listOf("ParentId", "IncludeItemTypes", "Limit"))
        if (unknown.isNotEmpty()) throw PlexUnmapped("/Items/Latest ${unknown.joinToString(",")}")
        val parent = r.get("ParentId").ifEmpty { null }?.let { PlexMap.parseId(it) }
        if (r.get("ParentId").isNotEmpty() && parent?.kind != "section") throw PlexUnmapped("Latest ParentId=${r.get("ParentId")}")
        val q = LinkedHashMap<String, String>()
        val types = if (r.get("IncludeItemTypes").isNotEmpty()) typesOf(r.get("IncludeItemTypes")) else emptyList()
        if (types.size == 1) q["type"] = "${types[0]}"
        val limit = orZero(jsNumber(r.get("Limit"))).let { if (it == 0.0) 16.0 else floor(it) }
        return PmsReq(
            "GET", if (parent != null) "/library/sections/${parent.key}/recentlyAdded" else "/library/recentlyAdded", q,
            linkedMapOf("X-Plex-Container-Start" to "0", "X-Plex-Container-Size" to intText(limit)), keep = if (types.size > 1) keepOf(types) else null,
        )
    }

    // Emby MediaTypes → the Emby item types that carry it.
    private val MEDIA_TYPES = mapOf("Video" to listOf("Movie", "Episode", "Video", "Trailer"), "Audio" to listOf("Audio"), "Photo" to listOf("Photo"))

    // GET /Users/{u}/Items/Resume: Continue Watching for the whole server (PMS has no per-section form).
    fun resumeRequest(query: Map<String, String>): PmsReq {
        val r = Reader(query)
        val unknown = r.rest(listOf("Limit", "StartIndex", "MediaTypes", "IncludeItemTypes"))
        if (unknown.isNotEmpty()) throw PlexUnmapped("/Items/Resume ${unknown.joinToString(",")}")
        val media = list(r.get("MediaTypes"))
        // shortcut: kept after PMS paged, so a page can come back short; page by type in PMS if a row looks thin.
        var keep: List<String>? = if (media.isNotEmpty()) media.flatMap { MEDIA_TYPES[it] ?: throw PlexUnmapped("MediaTypes=$it") } else null
        // Both given: Emby keeps the items that match both.
        if (r.get("IncludeItemTypes").isNotEmpty()) {
            val types = keepOf(typesOf(r.get("IncludeItemTypes")))
            keep = keep?.let { k -> types.filter { it in k } } ?: types
        }
        return PmsReq("GET", "/hubs/continueWatching/items", headers = paging(r), keep = keep)
    }

    // GET /Shows/NextUp: one show's next episode (SeriesId: the show's OnDeck), else the server's On Deck, episodes only.
    fun nextUpRequest(query: Map<String, String>): PmsReq {
        val r = Reader(query)
        val unknown = r.rest(listOf("SeriesId", "Limit", "StartIndex"))
        if (unknown.isNotEmpty()) throw PlexUnmapped("/Shows/NextUp ${unknown.joinToString(",")}")
        val series = r.get("SeriesId")
        if (series.isNotEmpty()) return PmsReq("GET", "/library/metadata/${keyOf(series, "SeriesId")}", mapOf("includeOnDeck" to "1"), onDeck = true, keep = listOf("Episode"))
        // shortcut: movies are dropped after PMS paged, so a page can come back short; fine for a home row.
        return PmsReq("GET", "/library/onDeck", headers = paging(r), keep = listOf("Episode"))
    }

    // The PMS items that answer [r]: a show's OnDeck unwrapped, search hubs flattened, then only the types kept.
    fun answerMeta(r: PmsReq, c: JsonElement?): List<JsonElement> {
        val all = when {
            r.onDeck -> c["Metadata"].list().firstOrNull()["OnDeck"]["Metadata"].list()
            r.hubs -> c["Hub"].list().flatMap { it["Metadata"].list() }
            else -> c["Metadata"].list()
        }
        val keep = r.keep ?: return all
        return all.filter { (PlexMap.itemType(it) ?: "") in keep }
    }

    // The metadata request every item page, PlaybackInfo, MediaSegments and BIF lookup starts from.
    fun metadataRequest(id: String): PmsReq = PmsReq(
        "GET", "/library/metadata/${keyOf(id, "Id")}",
        linkedMapOf("includeMarkers" to "1", "includeChapters" to "1", "includeExtras" to "1", "includeOnDeck" to "1", "checkFiles" to "1"),
    )

    // Watched state: scrobble / unscrobble.
    fun playedRequest(id: String, played: Boolean): PmsReq =
        PmsReq("GET", if (played) "/:/scrobble" else "/:/unscrobble", linkedMapOf("key" to keyOf(id, "Id"), "identifier" to LIBRARY_ID))

    // POST /Users/{u}/Items/{id}/UserData {PlaybackPositionTicks, Played}: offline progress sync (§6.6).
    fun userDataRequest(id: String, body: JsonElement?): PmsReq {
        if (body["Played"].truthy()) return playedRequest(id, true)
        if (body["PlaybackPositionTicks"] == null) throw PlexUnmapped("UserData without a position")
        return PmsReq(
            "GET", "/:/progress",
            linkedMapOf("key" to keyOf(id, "Id"), "identifier" to LIBRARY_ID, "time" to "${PlexMap.ticksToMs(body["PlaybackPositionTicks"])}", "state" to "stopped"),
        )
    }

    // Session reports → /:/timeline (§6.5). The play session id rides in X-Plex-Session-Identifier.
    fun timelineRequest(event: String, body: JsonElement?): PmsReq {
        val key = keyOf(body["ItemId"].str() ?: "", "ItemId")
        val state = if (event == "Stopped") "stopped" else if (body["IsPaused"].isTrue()) "paused" else "playing"
        val q = linkedMapOf("ratingKey" to key, "key" to "/library/metadata/$key", "state" to state, "time" to "${PlexMap.ticksToMs(body["PositionTicks"])}")
        val duration = PlexMap.ticksToMs(body["RunTimeTicks"])
        if (duration != 0L) q["duration"] = "$duration"
        val headers = LinkedHashMap<String, String>()
        if (body["PlaySessionId"].truthy()) headers["X-Plex-Session-Identifier"] = body["PlaySessionId"].str()!!
        return PmsReq("GET", "/:/timeline", q, headers)
    }

    // Keep-alive and stop of a transcode (§6.1.6).
    fun transcodeRequest(what: String, session: String): PmsReq {
        if (session.isEmpty()) throw PlexUnmapped("transcode $what without a session")
        return PmsReq("GET", "/video/:/transcode/universal/$what", mapOf("session" to session))
    }

    // "server://{machine}/com.plexapp.plugins.library/library/metadata/{ids}": how PMS names items to add.
    fun itemsUri(machineId: String, ids: List<String>): String =
        "server://$machineId/$LIBRARY_ID/library/metadata/${ids.joinToString(",") { keyOf(it, "Ids") }}"
}
