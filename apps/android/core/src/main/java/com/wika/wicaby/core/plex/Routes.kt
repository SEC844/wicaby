package com.wika.wicaby.core.plex

import com.wika.wicaby.core.plex.PlexQuery.itemKey
import com.wika.wicaby.core.plex.PlexQuery.itemsUri
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// The Plex route table (plex-spec §3.2 guard 1), the twin of desktop shared/plex/routes.ts: every Emby route the
// apps send to a plex server, with the PMS request it becomes. `build` is the pure translation (PlexQuery); a route
// without one is answered by the adapter from what it holds. Anything else is a 404 "PLEX-UNMAPPED <method> <path>".
object PlexRoutes {
    data class Ctx(val machineId: String = "")

    // null: the request is valid but the adapter answers it itself.
    fun interface Build {
        fun build(p: Map<String, String>, q: Map<String, String>, body: JsonElement?, ctx: Ctx): PmsReq?
    }

    class Route(val method: String, val path: String, val op: String, val media: Boolean = false, val build: Build? = null)

    private fun get(path: String, query: Map<String, String> = emptyMap()) = PmsReq("GET", path, query)

    private fun ids(q: Map<String, String>, key: String = "Ids"): List<String> = (q[key] ?: "").split(',').filter { it.isNotEmpty() }

    private fun route(method: String, path: String, op: String) = Route(method, path, op)

    private fun route(method: String, path: String, op: String, build: Build) = Route(method, path, op, false, build)

    private fun media(path: String, op: String) = Route("GET", path, op, true)

    // A live channel's report (LiveTvMap ids), which no library timeline carries.
    private fun liveItem(b: JsonElement?) = PlexLiveMap.parseLiveId(b["ItemId"].str() ?: "") != null

    // A series rule's id is its subscription key (LiveTvMap.kt).
    private val SUBSCRIPTION = Regex("^\\d{1,12}$")

    private fun subscriptionKey(id: String): String = if (SUBSCRIPTION.matches(id)) id else throw PlexUnmapped("subscription $id")

    // A music section's directory (/Artists?ParentId=section-3): Plex lists by section.
    private val SECTION = Regex("^section-(\\d+)$")

    private fun sectionDirectory(q: Map<String, String>, what: String, extra: Map<String, String> = emptyMap()): PmsReq {
        val parent = q["ParentId"] ?: q["parentId"] ?: ""
        val m = SECTION.find(parent) ?: throw PlexUnmapped("$what without a section ParentId")
        return get("/library/sections/${m.groupValues[1]}/$what", extra)
    }

    val ROUTES: List<Route> = listOf(
        // Browse.
        route("GET", "/Users/{user}/Views", "views") { _, _, _, _ -> get("/library/sections") },
        route("GET", "/Users/{user}/Items", "items") { _, q, _, _ -> PlexQuery.itemsRequest(q) },
        route("GET", "/Users/{user}/Items/Resume", "resume") { _, q, _, _ -> PlexQuery.resumeRequest(q) },
        route("GET", "/Users/{user}/Items/Latest", "latest") { _, q, _, _ -> PlexQuery.latestRequest(q) },
        // An id may be a section ("section-1": its view) or a person ("person-7": their page); the adapter answers those.
        route("GET", "/Users/{user}/Items/{id}", "item") { p, _, _, _ -> if (PlexMap.parseId(p["id"]!!)?.kind == "item") PlexQuery.metadataRequest(p["id"]!!) else null },
        route("GET", "/Users/{user}/Items/{id}/LocalTrailers", "trailers") { p, _, _, _ -> PlexQuery.metadataRequest(p["id"]!!) },
        route("GET", "/Users/{user}/Items/{id}/SpecialFeatures", "extras") { p, _, _, _ -> PlexQuery.metadataRequest(p["id"]!!) },
        route("GET", "/Items/{id}/Ancestors", "ancestors") { p, _, _, _ -> PlexQuery.metadataRequest(p["id"]!!) },
        route("GET", "/Items/{id}/Similar", "similar") { p, _, _, _ -> get("/library/metadata/${itemKey(p["id"]!!)}/similar") },
        route("GET", "/Shows/NextUp", "nextUp") { _, q, _, _ -> PlexQuery.nextUpRequest(q) },
        // Plex has no "upcoming episodes": the row is empty, so it is hidden (plex-spec §8).
        route("GET", "/Shows/Upcoming", "empty"),
        route("GET", "/Shows/{id}/Seasons", "seasons") { p, _, _, _ -> get("/library/metadata/${itemKey(p["id"]!!)}/children", mapOf("excludeAllLeaves" to "1")) },
        route("GET", "/Shows/{id}/Episodes", "episodes") { p, q, _, _ ->
            val season = q["SeasonId"]
            if (!season.isNullOrEmpty()) get("/library/metadata/${itemKey(season)}/children") else get("/library/metadata/${itemKey(p["id"]!!)}/allLeaves")
        },
        // Server-defined Home rows (caps.serverHubs): not an Emby route; PlexApi.hubs() sends it. ParentId = a section.
        route("GET", "/Hubs", "hubs") { _, q, _, _ ->
            val parent = q["ParentId"] ?: ""
            if (parent.isEmpty()) get("/hubs/promoted")
            else get("/hubs/sections/${PlexMap.parseId(parent)?.takeIf { it.kind == "section" }?.key ?: throw PlexUnmapped("Hubs ParentId=$parent")}")
        },
        route("GET", "/Users/{user}", "me"),
        route("GET", "/System/Info/Public", "identity") { _, _, _, _ -> get("/identity") },
        // Music: a music section's artists, genres and years.
        route("GET", "/Artists", "artists") { _, q, _, _ -> sectionDirectory(q, "all", mapOf("type" to "8")) },
        route("GET", "/Artists/AlbumArtists", "artists") { _, q, _, _ -> sectionDirectory(q, "all", mapOf("type" to "8")) },
        route("GET", "/Genres", "genres") { _, q, _, _ -> sectionDirectory(q, "genre") },
        route("GET", "/MusicGenres", "genres") { _, q, _, _ -> sectionDirectory(q, "genre") },
        route("GET", "/Years", "years") { _, q, _, _ -> sectionDirectory(q, "year") },

        // User data writes. Favorites are the plex.tv watchlist (D-6): the adapter needs the item's plex:// guid.
        route("POST", "/Users/{user}/FavoriteItems/{id}", "favorite"),
        route("DELETE", "/Users/{user}/FavoriteItems/{id}", "unfavorite"),
        route("POST", "/Users/{user}/PlayedItems/{id}", "played") { p, _, _, _ -> PlexQuery.playedRequest(p["id"]!!, true) },
        route("DELETE", "/Users/{user}/PlayedItems/{id}", "unplayed") { p, _, _, _ -> PlexQuery.playedRequest(p["id"]!!, false) },
        route("POST", "/Users/{user}/Items/{id}/UserData", "userData") { p, _, b, _ -> PlexQuery.userDataRequest(p["id"]!!, b) },
        route("POST", "/Users/{user}/Items/{id}/HideFromResume", "hideFromResume") { p, q, _, _ ->
            // Plex can hide, not unhide.
            if (q["Hide"] == "false") throw PlexUnmapped("HideFromResume Hide=false")
            PmsReq("PUT", "/actions/removeFromContinueWatching", mapOf("ratingKey" to itemKey(p["id"]!!)))
        },
        // D-2: the one admin action, "Refresh metadata", for the server owner. A section id refreshes that section.
        route("POST", "/Items/{id}/Refresh", "refreshItem") { p, _, _, _ ->
            val id = PlexMap.parseId(p["id"]!!)
            if (id?.kind == "section") get("/library/sections/${id.key}/refresh") else PmsReq("PUT", "/library/metadata/${itemKey(p["id"]!!)}/refresh")
        },
        route("POST", "/Library/Refresh", "refreshLibrary") { _, _, _, _ -> get("/library/sections/all/refresh") },

        // Playlists and collections.
        route("GET", "/Playlists/{id}/Items", "playlistItems") { p, _, _, _ -> get("/playlists/${itemKey(p["id"]!!)}/items") },
        route("POST", "/Playlists", "createPlaylist") { _, q, b, ctx ->
            val name = q["Name"] ?: b["Name"].str() ?: ""
            val list = ids(q).ifEmpty { b["Ids"].list().mapNotNull { it.str() } }
            val type = if ((q["MediaType"] ?: b["MediaType"].str() ?: "Video") == "Audio") "audio" else "video"
            if (name.isEmpty() || list.isEmpty()) throw PlexUnmapped("POST /Playlists without Name or Ids")
            PmsReq("POST", "/playlists", linkedMapOf("type" to type, "title" to name, "smart" to "0", "uri" to itemsUri(ctx.machineId, list)))
        },
        route("POST", "/Playlists/{id}/Items", "playlistAdd") { p, q, _, ctx -> PmsReq("PUT", "/playlists/${itemKey(p["id"]!!)}/items", mapOf("uri" to itemsUri(ctx.machineId, ids(q)))) },
        route("DELETE", "/Playlists/{id}/Items", "playlistRemove") { p, q, _, _ ->
            val entries = ids(q, "EntryIds")
            if (entries.size != 1) throw PlexUnmapped("DELETE /Playlists/{id}/Items with ${entries.size} entries")
            PmsReq("DELETE", "/playlists/${itemKey(p["id"]!!)}/items/${itemKey(entries[0])}")
        },
        // Plex moves "after an entry": the adapter reads the list to find which one.
        route("POST", "/Playlists/{id}/Items/{entry}/Move/{index}", "playlistMove"),
        // A collection needs its section and type: the adapter reads the first item.
        route("POST", "/Collections", "createCollection"),
        route("POST", "/Collections/{id}/Items", "collectionAdd") { p, q, _, ctx -> PmsReq("PUT", "/library/collections/${itemKey(p["id"]!!)}/items", mapOf("uri" to itemsUri(ctx.machineId, ids(q)))) },
        route("DELETE", "/Collections/{id}/Items", "collectionRemove") { p, q, _, _ ->
            val list = ids(q)
            if (list.size != 1) throw PlexUnmapped("DELETE /Collections/{id}/Items with ${list.size} items")
            PmsReq("DELETE", "/library/collections/${itemKey(p["id"]!!)}/items/${itemKey(list[0])}")
        },

        // Playback: the decision, markers and reports.
        route("POST", "/Items/{id}/PlaybackInfo", "playbackInfo"),
        route("GET", "/MediaSegments/{id}", "segments") { p, _, _, _ -> PlexQuery.metadataRequest(p["id"]!!) },
        // A live channel's reports: the adapter answers them (PlexLiveTv.report), no library timeline.
        route("POST", "/Sessions/Playing", "timeline") { _, _, b, _ -> if (liveItem(b)) null else PlexQuery.timelineRequest("", b) },
        route("POST", "/Sessions/Playing/Progress", "timeline") { _, _, b, _ -> if (liveItem(b)) null else PlexQuery.timelineRequest("Progress", b) },
        route("POST", "/Sessions/Playing/Stopped", "timeline") { _, _, b, _ -> if (liveItem(b)) null else PlexQuery.timelineRequest("Stopped", b) },
        route("POST", "/Sessions/Playing/Ping", "ping") { _, q, _, _ -> PlexQuery.transcodeRequest("ping", q["PlaySessionId"] ?: "") },
        route("DELETE", "/Videos/ActiveEncodings", "stopTranscode") { _, q, _, _ -> PlexQuery.transcodeRequest("stop", q["PlaySessionId"] ?: "") },
        // Wicaby is not a controllable Plex player (caps.castReceiver false): nothing to register.
        route("POST", "/Sessions/Capabilities/Full", "noop"),

        // Live TV and DVR (PX-11, LiveTvMap.kt; PlexLiveTv answers the "live*" ops). Channels, programmes, timers and rules
        // come from the DVR, its EPG grid and the subscriptions; a channel's PlaybackInfo above tunes it.
        route("GET", "/LiveTv/Info", "liveInfo"),
        route("GET", "/LiveTv/GuideInfo", "liveGuideInfo"),
        route("GET", "/LiveTv/Channels", "liveChannels"),
        route("GET", "/LiveTv/Programs", "livePrograms"),
        route("GET", "/LiveTv/Programs/Recommended", "livePrograms"),
        route("GET", "/LiveTv/Programs/{id}", "liveProgram"),
        route("GET", "/LiveTv/Timers", "liveTimers"),
        route("GET", "/LiveTv/Timers/Defaults", "liveTimerDefaults"),
        route("GET", "/LiveTv/Timers/{id}", "liveTimer"),
        route("POST", "/LiveTv/Timers", "liveCreateTimer"),
        route("POST", "/LiveTv/Timers/{id}", "liveUpdateTimer"),
        route("DELETE", "/LiveTv/Timers/{id}", "liveCancelTimer"),
        route("GET", "/LiveTv/SeriesTimers", "liveSeriesTimers"),
        route("GET", "/LiveTv/SeriesTimers/{id}", "liveSeriesTimer"),
        route("POST", "/LiveTv/SeriesTimers", "liveCreateSeriesTimer"),
        route("POST", "/LiveTv/SeriesTimers/{id}", "liveUpdateSeriesTimer"),
        route("DELETE", "/LiveTv/SeriesTimers/{id}", "liveDeleteSeriesTimer") { p, _, _, _ -> PlexLiveMap.deleteRequest(subscriptionKey(p["id"]!!)) },
        route("GET", "/LiveTv/Recordings", "liveRecordings"),
        // Plex picks the recording folder itself: no folders to offer.
        route("GET", "/LiveTv/Recordings/Folders", "empty"),
        // Only the item's recorded versions, never the item (LiveTvMap.kt deleteRecordingRequests).
        route("DELETE", "/LiveTv/Recordings/{id}", "liveDeleteRecording"),
        // A tune's stream is a transcode session: closing it stops the transcode, which frees the tuner.
        route("POST", "/LiveStreams/Close", "liveClose") { _, q, _, _ -> PlexQuery.transcodeRequest("stop", q["PlaySessionId"] ?: "") },

        // Media (PlexApi.url): paths resolved from the item the adapter has seen.
        media("/Items/{id}/Images/{type}", "image"),
        media("/Items/{id}/Images/{type}/{index}", "image"),
        media("/Videos/{id}/stream", "stream"),
        media("/Videos/{id}/stream.{ext}", "stream"),
        media("/Audio/{id}/stream", "stream"),
        media("/Videos/{id}/index.bif", "bif"),
        media("/Videos/{id}/{source}/Subtitles/{index}/Stream", "subtitle"),
        media("/Videos/{id}/{source}/Subtitles/{index}/Stream.{ext}", "subtitle"),
        // Downloads take the original part, only where the server allows it (allowSync, plex-spec §1.3).
        media("/Items/{id}/Download", "download"),
    )

    // Emby routes a plex server does not answer (each with its UI fallback in desktop routes.ts PLEX_UNSUPPORTED).
    val PLEX_UNSUPPORTED: List<String> = listOf(
        "/Users/{user}/Items/{id}/Intros", "/Items/{id}/InstantMix", "/Items/{id}/RemoteSearch/Subtitles/{lang}", "/Items/{id}/File",
        "/Videos/{id}/Trickplay/{width}/tiles.m3u8", "/Videos/{id}/Trickplay/{width}/{n}.jpg", "/LiveTv/*", "/LiveStreams/Open", "/DisplayPreferences/*", "/UserFavoriteItems/{id}",
        "/Sessions", "/Sessions/{id}/*", "/Sessions/Logout", "/QuickConnect/*", "/Users/AuthenticateWithQuickConnect", "/Users/Public",
        "/Users/AuthenticateByName", "/Users/{user}/Images/Primary", "/System/WakeOnLanInfo", "/System/Info", "/ScheduledTasks", "/Plugins",
    )

    private class Compiled(val re: Regex, val names: List<String>, val holes: Int)

    private val TOKEN = Regex("\\{\\w+\\}|\\*")
    private const val SPECIAL = ".+?^$()|[]\\"

    // "{name}" matches one segment, "*" anything (Android before API 26 has no named groups: names kept aside).
    private fun compile(pattern: String): Compiled {
        val names = ArrayList<String>()
        val sb = StringBuilder("^")
        var last = 0
        fun literal(s: String) = s.forEach { c -> if (c in SPECIAL) sb.append('\\'); sb.append(c) }
        for (m in TOKEN.findAll(pattern)) {
            literal(pattern.substring(last, m.range.first))
            if (m.value == "*") sb.append(".+") else {
                names += m.value.substring(1, m.value.length - 1)
                sb.append("([^/]+?)")
            }
            last = m.range.last + 1
        }
        literal(pattern.substring(last))
        sb.append('$')
        return Compiled(Regex(sb.toString()), names, pattern.count { it == '{' || it == '*' })
    }

    private val COMPILED = ROUTES.map { it to compile(it.path) }
    private val UNSUPPORTED = PLEX_UNSUPPORTED.map(::compile)

    data class Match(val route: Route, val params: Map<String, String>)

    // The route for a request, or null. The most literal pattern wins, unsupported ones included.
    fun matchRoute(method: String, path: String): Match? {
        val clean = path.split('?')[0]
        var best: Triple<Route, Map<String, String>, Int>? = null
        for ((r, c) in COMPILED) {
            if (r.method != method.uppercase()) continue
            val m = c.re.find(clean) ?: continue
            if (best == null || c.holes < best.third) best = Triple(r, c.names.mapIndexed { i, n -> n to m.groupValues[i + 1] }.toMap(LinkedHashMap()), c.holes)
        }
        val b = best ?: return null
        if (UNSUPPORTED.any { it.re.matches(clean) && it.holes < b.third }) return null
        return Match(b.first, b.second)
    }

    data class Translated(val op: String, val params: Map<String, String>, val req: PmsReq?)

    // The translated request (req null: the adapter answers it itself), or a PlexUnmapped throw.
    fun translate(method: String, path: String, query: Map<String, String> = emptyMap(), body: JsonElement? = null, ctx: Ctx = Ctx()): Translated {
        val hit = matchRoute(method, path)
        if (hit == null || hit.route.media) throw PlexUnmapped("${method.uppercase()} ${path.split('?')[0]}")
        return Translated(hit.route.op, hit.params, hit.route.build?.build(hit.params, query, body as? JsonObject, ctx))
    }
}
