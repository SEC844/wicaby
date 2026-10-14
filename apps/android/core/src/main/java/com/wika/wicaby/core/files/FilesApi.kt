package com.wika.wicaby.core.files

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ItemsResult
import com.wika.wicaby.core.data.MediaSource
import com.wika.wicaby.core.data.MediaStream
import com.wika.wicaby.core.data.PlaybackInfo
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.UserData
import com.wika.wicaby.core.data.isoUtc
import com.wika.wicaby.core.data.json
import com.wika.wicaby.core.files.pure.Ids
import com.wika.wicaby.core.files.pure.NatSort
import com.wika.wicaby.core.files.pure.Names
import com.wika.wicaby.core.files.pure.Nfo
import com.wika.wicaby.core.files.pure.NfoInfo
import com.wika.wicaby.core.files.pure.ProgressRecord
import com.wika.wicaby.core.files.pure.ProgressRules
import com.wika.wicaby.core.files.pure.Shapes
import com.wika.wicaby.core.files.pure.SidecarRules
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.util.concurrent.ConcurrentHashMap

// A file source seen as a server (spec §3.2, D1): the Emby-shaped calls the apps already make (views, items, item,
// resume, played, PlaybackInfo, the /Sessions/Playing reports) are answered from a route table over a backend, and the
// watch state lives in FileProgress (§4.4). An unknown route answers 404 FILES-UNMAPPED, which the UI already reads as
// "not supported here". Ids are reversible paths (Ids): nothing maps ids to files.
class FilesApi(
    val source: FileSource,
    val backend: FileBackend,
    val progress: FileProgress,
    deviceId: String,
    // A photo source (FileSource.photos): its index answers the photo screens' calls (PhotoRoutes.kt).
    val photos: PhotoIndex? = null,
    private val now: () -> Long = System::currentTimeMillis,
) : Api(Server(source.id, source.name, "files:${source.id}", "files"), deviceId, null, USER) {
    private class Listing(val entries: List<FileEntry>, val at: Long, val cut: Boolean)

    private val listings = ConcurrentHashMap<String, Listing>()
    private val seen = ConcurrentHashMap<String, FileEntry>() // rel -> the file as last listed
    private val images = ConcurrentHashMap<String, String>() // "<id>/<type>" -> image URI
    private val durations = ConcurrentHashMap<String, Long>()
    private val titles = ConcurrentHashMap<String, String>()
    private val lastWrite = ConcurrentHashMap<String, Long>()
    private val changedRels: MutableSet<String> = java.util.Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())

    // The last listing had more than CAP entries: only the first are shown, with a note (files_list_truncated).
    @Volatile
    var truncated = false
        private set

    // Pull to refresh, the Refresh entry: the next listing asks the source again.
    fun refresh() = listings.clear()

    // Every entry of [rel] (sidecars included), cached 60 s (§4.1). [shown]: the folder on screen, whose cut sets
    // [truncated] (a peek into a child folder does not).
    suspend fun listing(rel: String, shown: Boolean = true): List<FileEntry> {
        val l = listings[rel]?.takeIf { now() - it.at < CACHE_MS } ?: backend.list(rel).let { all ->
            Listing(all.take(CAP), now(), all.size > CAP).also { listings[rel] = it }
        }
        if (shown) truncated = l.cut
        return l.entries
    }

    // What a folder shows: sub-folders and videos, hidden system folders and dot-files left out.
    suspend fun visible(rel: String): List<FileEntry> = listing(rel).filter { e -> !hidden(e.name) && (e.dir || Names.isVideo(e.name)) }

    override fun authHeaders(): Map<String, String> = emptyMap()

    // /Videos/<id>/stream (Playback's direct play): the file's own address. Nothing else has a URL here.
    override fun url(path: String, vararg query: Pair<String, Any?>): String {
        STREAM.find(path)?.let { m -> Ids.decode(m.groupValues[2])?.let { rel -> return backend.uri(rel, seen[rel]) } }
        return "files://${source.id}$path"
    }

    // Subtitle delivery URLs are the backend's own absolute URIs.
    override fun resolve(u: String): String = u

    override fun image(id: String, type: String, tag: String?, maxWidth: Int?, maxHeight: Int?): String =
        photos?.let { photoImage(id, maxOf(maxWidth ?: 0, maxHeight ?: 0)) } ?: images["$id/$type"].orEmpty()

    override suspend fun raw(method: String, path: String, body: String?, vararg query: Pair<String, Any?>): String =
        route(method, path, body, query.asList())

    override suspend fun <T> stream(method: String, path: String, body: String?, query: List<Pair<String, Any?>>, timeoutMs: Long, read: (Response) -> T): T {
        val text = route(method, path, body, query)
        return Response.Builder().request(Request.Builder().url("http://127.0.0.1/").build()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
            .body(text.toResponseBody(JSON)).build().use(read)
    }

    // D5: what the player learnt at first play (duration, container title), kept with the next progress write.
    fun tags(itemId: String, durationMs: Long, title: String?) {
        val rel = Ids.decode(itemId) ?: return
        if (durationMs > 0) durations[rel] = durationMs
        title?.takeIf { it.isNotBlank() }?.let { titles[rel] = it }
    }

    // The file was replaced since its progress was saved (§4.4): it starts at 0 and the player says why. Once.
    fun changed(itemId: String): Boolean = Ids.decode(itemId)?.let { changedRels.remove(it) } == true

    internal fun arg(query: List<Pair<String, Any?>>, name: String): String? =
        query.firstOrNull { it.first.equals(name, ignoreCase = true) }?.second?.toString()?.takeIf { it.isNotEmpty() }

    // Emby and Jellyfin spell the same call several ways (Api picks by kind): one route each here.
    private fun normalise(path: String): String {
        val p = path.substringBefore('?').removePrefix("/emby").replace(Regex("^/Users/[^/]+(?=/)"), "")
        return when {
            p == "/UserViews" -> "/Views"
            p.startsWith("/UserItems/") -> "/Items/" + p.removePrefix("/UserItems/")
            p.startsWith("/UserPlayedItems/") -> "/PlayedItems/" + p.removePrefix("/UserPlayedItems/")
            else -> p
        }
    }

    private suspend fun route(method: String, path: String, body: String?, query: List<Pair<String, Any?>>): String = withContext(Dispatchers.IO) {
        val p = normalise(path)
        val parts = p.trim('/').split('/')
        fun unmapped(): Nothing = throw ApiException("FILES-UNMAPPED $method $p", 404)
        fun id(i: Int) = parts.getOrNull(i) ?: unmapped()
        if (photos != null) photoRoute(method, p, parts, query)?.let { return@withContext it }
        when (method) {
            "GET" -> when {
                p == "/Views" -> encode(ItemsResult(listOf(root()), 1))
                p == "/Items" -> {
                    val parent = arg(query, "ParentId")
                    // No search across file sources (§1): it needs an index.
                    if (parent == null || arg(query, "SearchTerm") != null) encode(ItemsResult()) else encode(list(parent, query))
                }
                p == "/Items/Resume" -> continueItems().let { encode(ItemsResult(it, it.size)) }
                p == "/Items/Latest" -> "[]"
                parts.size == 2 && parts[0] == "Items" -> json.encodeToString(Item.serializer(), fileItem(id(1)))
                parts.size == 3 && parts[0] == "Items" && parts[2] in setOf("LocalTrailers", "SpecialFeatures") -> "[]"
                parts.size == 3 && parts[0] == "Items" && parts[2] == "Similar" -> encode(ItemsResult())
                p == "/Shows/NextUp" || p == "/Shows/Upcoming" -> encode(ItemsResult())
                parts.size == 3 && parts[0] == "Shows" && parts[2] == "Episodes" -> encode(episodes(id(1), arg(query, "StartItemId"), arg(query, "Limit")?.toIntOrNull()))
                parts.size == 3 && parts[0] == "Shows" && parts[2] == "Seasons" -> encode(ItemsResult())
                parts.size == 2 && parts[0] == "Users" -> buildJsonObject {
                    put("Id", USER)
                    put("Name", source.name)
                    put("HasPassword", false)
                    putJsonObject("Policy") { put("IsAdministrator", false) }
                }.toString()
                p == "/System/Info/Public" -> {
                    listing("")
                    buildJsonObject { put("Id", source.id); put("ServerName", source.name); put("ProductName", "Wicaby files") }.toString()
                }
                else -> unmapped()
            }
            "POST", "DELETE" -> when {
                parts.size == 3 && parts[0] == "Items" && parts[2] == "PlaybackInfo" -> playbackInfo(id(1))
                parts.size == 2 && parts[0] == "PlayedItems" -> { setPlayedLocal(id(1), method == "POST"); "" }
                parts.size == 3 && parts[0] == "Items" && parts[2] == "HideFromResume" -> { hide(id(1), arg(query, "Hide") != "false"); "" }
                parts.size == 3 && parts[0] == "Items" && parts[2] == "UserData" -> { userData(id(1), body); "" }
                p == "/Sessions/Playing" -> { report(body, start = true); "" }
                p == "/Sessions/Playing/Progress" -> { report(body, force = event(body) == "Pause"); "" }
                p == "/Sessions/Playing/Stopped" -> { report(body, force = true); "" }
                p in NO_OPS -> ""
                else -> unmapped()
            }
            else -> unmapped()
        }
    }

    internal fun encode(r: ItemsResult) = json.encodeToString(ItemsResult.serializer(), r)

    internal fun root() = Item(Ids.ROOT, source.name, "CollectionFolder", collectionType = if (photos != null) "photos" else "mixed", isFolder = true, serverId = source.id)

    private fun folderItem(rel: String, name: String): Item? = Ids.encode(rel)?.let { Item(it, name, "Folder", isFolder = true, serverId = source.id) }

    // A folder card (§4.2, §4.3): its poster and backdrop from its own entries, and its shape as the card type (Series,
    // Season, Movie, Folder). [asFilm]: a film folder's card is its film (it plays; extras stay one folder down).
    // [inside] null (not listed): a season by its name, else a plain folder.
    private fun shapedFolder(rel: String, name: String, inside: List<FileEntry>?, asFilm: Boolean): Item? {
        val base = folderItem(rel, name) ?: return null
        val season = Shapes.seasonNumber(name)
        if (inside == null) return if (season != null) base.copy(type = Shapes.SEASON, indexNumber = season) else base
        val (shape, film) = Shapes.folder(name, inside.filterNot { hidden(it.name) }.map { it.name to it.dir })
        if (asFilm && shape == Shapes.MOVIE && film != null) {
            val e = inside.first { it.name == film }
            val parsed = Names.parse(name)
            return Ids.child(rel, film)?.let { video(it, e, inside.map { f -> f.name }, null, detail = false) }
                ?.let { it.copy(name = parsed.title.ifEmpty { it.name }, productionYear = parsed.year ?: it.productionYear) }
        }
        val side = SidecarRules.folder(inside.filterNot { it.dir }.map { it.name })
        fun art(n: String?, type: String): String? {
            val f = n?.let { x -> inside.firstOrNull { it.name == x } } ?: return null
            val uri = Ids.child(rel, f.name)?.let { backend.uri(it, f) } ?: return null
            images["${base.id}/$type"] = uri
            return "${f.size}-${f.mtimeMs / 1000}"
        }
        val poster = art(side.poster, "Primary")
        val backdrop = art(side.backdrop, "Backdrop")
        return base.copy(
            type = if (shape == Shapes.MOVIE) Shapes.FOLDER else shape, indexNumber = season,
            imageTags = poster?.let { mapOf("Primary" to it) }.orEmpty(), backdropImageTags = listOfNotNull(backdrop),
            childCount = inside.count { !hidden(it.name) && (it.dir || Names.isVideo(it.name)) },
        )
    }

    // The entries of the child folders of a listing, for their shapes and posters; cached like any listing. Bounded:
    // shortcut: only the first PEEK folders are looked into (the rest show as plain folders); a folder of folders
    // larger than that would need lazy per-card loading (a Coil fetcher) instead.
    private suspend fun peek(rels: List<String>): Map<String, List<FileEntry>> = coroutineScope {
        val gate = Semaphore(PEEK_PARALLEL)
        rels.take(PEEK).map { r -> async { r to runCatching { gate.withPermit { listing(r, shown = false) } }.getOrNull() } }
            .awaitAll().mapNotNull { (r, l) -> l?.let { r to it } }.toMap()
    }

    internal fun relOf(id: String) = Ids.decode(id) ?: throw ApiException("FILES-BAD-ID", 404)

    private suspend fun list(parentId: String, query: List<Pair<String, Any?>>): ItemsResult {
        val rel = relOf(parentId)
        val names = listing(rel).map { it.name }
        val shown = visible(rel)
        val by = arg(query, "SortBy").orEmpty()
        fun cmp(dirs: Boolean): Comparator<FileEntry> = when {
            by.startsWith("DateModified") || by.startsWith("DateCreated") -> compareBy<FileEntry> { it.mtimeMs }.thenBy(NatSort) { it.name }
            by.startsWith("Size") -> compareBy<FileEntry> { it.size }.thenBy(NatSort) { it.name }
            // §4.3: season folders as seasons; episodes by SxxEyy; then the natural order.
            dirs -> compareBy<FileEntry> { Shapes.seasonNumber(it.name) ?: Int.MAX_VALUE }.thenBy(NatSort) { it.name }
            else -> compareBy<FileEntry, String>(Shapes.episodeOrder) { it.name }.thenBy(NatSort) { it.name }
        }
        // minSdk 23: List.reversed (stdlib), not Comparator.reversed (API 24).
        fun order(l: List<FileEntry>, dirs: Boolean) = l.sortedWith(cmp(dirs)).let { if (arg(query, "SortOrder") == "Descending") it.reversed() else it }
        // Folders first, then files (§4.1).
        val folders = order(shown.filter { it.dir }, dirs = true)
        val inside = peek(folders.mapNotNull { Ids.child(rel, it.name) })
        val items = (folders + order(shown.filterNot { it.dir }, dirs = false)).mapNotNull { e ->
            val child = Ids.child(rel, e.name) ?: return@mapNotNull null
            if (e.dir) shapedFolder(child, e.name, inside[child], asFilm = true) else video(child, e, names, null, detail = false)
        }
        val start = arg(query, "StartIndex")?.toIntOrNull()?.coerceAtLeast(0) ?: 0
        val limit = arg(query, "Limit")?.toIntOrNull() ?: items.size
        return ItemsResult(items.drop(start).take(limit), items.size)
    }

    private suspend fun entryOf(rel: String): FileEntry? =
        Ids.parent(rel)?.let { parent -> listing(parent).firstOrNull { it.name == Ids.name(rel) } }?.also { if (!it.dir) seen[rel] = it }

    private suspend fun fileItem(id: String): Item {
        val rel = relOf(id)
        if (rel.isEmpty()) return root()
        val parent = Ids.parent(rel)!!
        val siblings = listing(parent)
        val e = siblings.firstOrNull { it.name == Ids.name(rel) } ?: throw ApiException("FILES-NOT-FOUND", 404)
        if (e.dir) return shapedFolder(rel, e.name, runCatching { listing(rel, shown = false) }.getOrNull(), asFilm = false) ?: throw ApiException("FILES-BAD-ID", 404)
        val names = siblings.map { it.name }
        val nfo = SidecarRules.video(e.name, names).nfo?.let { n ->
            val nfoRel = Ids.child(parent, n) ?: return@let null
            runCatching { Nfo.parse(backend.read(nfoRel, siblings.firstOrNull { it.name == n }, Nfo.MAX_BYTES).decodeToString()) }.getOrNull()
        }
        progress.get(rel)?.let { if (!ProgressRules.sameFile(it, e.size, e.mtimeMs) && (it.positionMs > 0 || it.played)) changedRels += rel }
        return video(rel, e, names, nfo, detail = true) ?: throw ApiException("FILES-BAD-ID", 404)
    }

    // A video card or page: the NFO first, else the file name (§4.2); its sidecars from the names in its folder.
    private fun video(rel: String, e: FileEntry, siblings: List<String>, nfo: NfoInfo?, detail: Boolean): Item? {
        val id = Ids.encode(rel) ?: return null
        val parent = Ids.parent(rel).orEmpty()
        val parsed = Names.parse(e.name)
        val stem = e.name.substringBeforeLast('.')
        val side = SidecarRules.video(e.name, siblings)
        seen[rel] = e
        fun sideUri(n: String) = Ids.child(parent, n)?.let { backend.uri(it, listingEntry(parent, n)) }
        val tags = HashMap<String, String?>()
        side.poster?.let { n -> sideUri(n)?.let { images["$id/Primary"] = it; tags["Primary"] = tagOf(parent, n) } }
        val backdropTag = side.backdrop?.let { n -> sideUri(n)?.let { images["$id/Backdrop"] = it; tagOf(parent, n) } }
        val rec = progress.get(rel)?.takeIf { ProgressRules.sameFile(it, e.size, e.mtimeMs) }
        val episode = nfo?.kind == "episode" || (nfo == null && parsed.isEpisode)
        val runtimeMs = rec?.durationMs?.takeIf { it > 0 } ?: durations[rel] ?: nfo?.runtimeMin?.let { it * 60_000L }
        val subs = if (!detail) emptyList() else side.subtitles.mapIndexedNotNull { i, s ->
            val u = sideUri(s.name) ?: return@mapIndexedNotNull null
            MediaStream(
                index = SUB_INDEX + i, type = "Subtitle", codec = s.codec, language = s.language,
                displayTitle = listOfNotNull(s.language ?: s.name, s.codec.uppercase(), "forced".takeIf { s.forced }, "SDH".takeIf { s.hearingImpaired }).joinToString(" · "),
                title = s.name, isForced = s.forced, isExternal = true, deliveryMethod = "External", deliveryUrl = u,
            )
        }
        val container = Names.extOf(e.name)
        return Item(
            id = id,
            // An episode without an NFO keeps its file name: the parsed title is the show's.
            name = nfo?.title ?: if (episode) stem else parsed.title.ifEmpty { stem },
            type = if (episode) "Episode" else "Movie", mediaType = "Video",
            productionYear = nfo?.year ?: parsed.year, overview = nfo?.plot, genres = nfo?.genres.orEmpty(),
            runTimeTicks = runtimeMs?.let { it * TICKS_PER_MS },
            imageTags = tags, backdropImageTags = listOfNotNull(backdropTag),
            seriesId = if (episode) Ids.encode(parent) else null, seriesName = if (episode) seriesName(parent, parsed.title) else null,
            indexNumber = nfo?.episode ?: parsed.episode, parentIndexNumber = nfo?.season ?: parsed.season,
            userData = userDataOf(rec), container = container,
            providerIds = nfo?.providerIds.orEmpty(), serverId = source.id,
            mediaSources = if (detail) listOf(
                MediaSource(
                    id = id, name = e.name, container = container, supportsDirectPlay = true,
                    mediaStreams = subs, runTimeTicks = runtimeMs?.let { it * TICKS_PER_MS }, size = e.size,
                ),
            ) else emptyList(),
        )
    }

    // An episode's show: its folder, or the folder above a "Season N" one; the parsed title at the root.
    private fun seriesName(parent: String, fallback: String): String {
        val folder = Ids.name(parent)
        val show = if (SEASON.matches(folder)) Ids.name(Ids.parent(parent).orEmpty()) else folder
        return show.ifEmpty { fallback }
    }

    private fun listingEntry(parent: String, name: String) = listings[parent]?.entries?.firstOrNull { it.name == name }

    private fun tagOf(parent: String, name: String) = listingEntry(parent, name)?.let { "${it.size}-${it.mtimeMs / 1000}" } ?: name

    private fun userDataOf(rec: ProgressRecord?) = rec?.let {
        UserData(playbackPositionTicks = it.positionMs * TICKS_PER_MS, played = it.played, lastPlayedDate = if (it.lastPlayedAt > 0) isoUtc(it.lastPlayedAt) else null)
    }

    // Continue Watching (§4.4): files with a position, newest first, then "next in folder" after the latest played
    // ones (the natural successor of a played file, no scan). Nothing is checked here: a file is when it opens.
    private suspend fun continueItems(): List<Item> {
        val all = progress.all()
        val out = ProgressRules.continueList(all).mapNotNull { rel -> fromRecord(rel, all.getValue(rel)) }.toMutableList()
        val ids = out.mapTo(HashSet()) { it.id }
        for ((rel, r) in all.entries.filter { it.value.played && !it.value.hidden }.sortedByDescending { it.value.lastPlayedAt }.take(NEXT_SEEDS)) {
            val parent = Ids.parent(rel) ?: continue
            val folder = runCatching { listing(parent) }.getOrNull() ?: continue
            val videos = folder.filter { !it.dir && !hidden(it.name) && Names.isVideo(it.name) }.sortedWith(compareBy(NatSort) { it.name })
            val i = videos.indexOfFirst { it.name == Ids.name(rel) }
            val next = videos.getOrNull(i + 1)?.takeIf { i >= 0 } ?: continue
            val nextRel = Ids.child(parent, next.name) ?: continue
            val nr = progress.get(nextRel)?.takeIf { ProgressRules.sameFile(it, next.size, next.mtimeMs) }
            if (nr != null && (nr.played || nr.positionMs > 0)) continue
            val item = video(nextRel, next, folder.map { it.name }, null, detail = false) ?: continue
            if (ids.add(item.id)) out += item.copy(userData = UserData(lastPlayedDate = isoUtc(r.lastPlayedAt)))
        }
        return out
    }

    private fun fromRecord(rel: String, r: ProgressRecord): Item? {
        val id = Ids.encode(rel) ?: return null
        val name = Ids.name(rel)
        val parsed = Names.parse(name)
        val parent = Ids.parent(rel).orEmpty()
        val stem = name.substringBeforeLast('.')
        return Item(
            id = id, name = r.title ?: if (parsed.isEpisode) stem else parsed.title.ifEmpty { stem },
            type = if (parsed.isEpisode) "Episode" else "Movie", mediaType = "Video", productionYear = parsed.year,
            runTimeTicks = r.durationMs.takeIf { it > 0 }?.let { it * TICKS_PER_MS },
            seriesId = if (parsed.isEpisode) Ids.encode(parent) else null, seriesName = if (parsed.isEpisode) seriesName(parent, parsed.title) else null,
            indexNumber = parsed.episode, parentIndexNumber = parsed.season, userData = userDataOf(r), serverId = source.id,
        )
    }

    // The videos of a folder from [startId] on (Playback's next episode: an episode's series is its folder).
    private suspend fun episodes(folderId: String, startId: String?, limit: Int?): ItemsResult {
        val rel = relOf(folderId)
        val names = listing(rel).map { it.name }
        val videos = visible(rel).filterNot { it.dir }.sortedWith(compareBy(NatSort) { it.name })
        val from = startId?.let { s -> videos.indexOfFirst { e -> Ids.child(rel, e.name)?.let(Ids::encode) == s } }?.coerceAtLeast(0) ?: 0
        val items = videos.drop(from).take(limit ?: videos.size).mapNotNull { e -> Ids.child(rel, e.name)?.let { video(it, e, names, null, detail = false) } }
        return ItemsResult(items, items.size)
    }

    private suspend fun playbackInfo(id: String): String {
        val it = fileItem(id)
        if (it.isFolder) throw ApiException("FILES-NOT-A-FILE", 404)
        return json.encodeToString(PlaybackInfo.serializer(), PlaybackInfo(it.mediaSources, "files-$id"))
    }

    // The file as last listed, else its folder now; null when it cannot be seen (offline): nothing is written then.
    private suspend fun fileOf(rel: String): FileEntry? = seen[rel] ?: runCatching { entryOf(rel) }.getOrNull()

    private fun blank(e: FileEntry) = ProgressRecord(e.size, ProgressRules.mtimeSec(e.mtimeMs))

    private suspend fun setPlayedLocal(id: String, on: Boolean) {
        val rel = relOf(id)
        val e = fileOf(rel) ?: return
        progress.update(rel) { r ->
            (r?.takeIf { ProgressRules.sameFile(it, e.size, e.mtimeMs) } ?: blank(e)).copy(played = on, positionMs = 0, hidden = false, lastPlayedAt = now())
        }
    }

    private fun hide(id: String, on: Boolean) {
        progress.update(relOf(id)) { it?.copy(hidden = on) }
    }

    // Api.updateUserData (a watch state queued offline): position and played as given.
    private suspend fun userData(id: String, body: String?) {
        val o = body?.let { runCatching { json.parseToJsonElement(it) as JsonObject }.getOrNull() } ?: return
        val rel = relOf(id)
        val e = fileOf(rel) ?: return
        val pos = (o["PlaybackPositionTicks"] as? JsonPrimitive)?.longOrNull?.div(TICKS_PER_MS) ?: 0
        val played = (o["Played"] as? JsonPrimitive)?.booleanOrNull == true
        progress.update(rel) { r ->
            val base = r?.takeIf { ProgressRules.sameFile(it, e.size, e.mtimeMs) } ?: blank(e)
            base.copy(positionMs = if (played) 0 else pos, played = played || base.played, lastPlayedAt = now())
        }
    }

    private fun event(body: String?) = body?.let { runCatching { ((json.parseToJsonElement(it) as JsonObject)["EventName"] as? JsonPrimitive)?.contentOrNull }.getOrNull() }

    // The /Sessions/Playing trio, kept locally (§4.4): a write on pause and on stop, and at most every 30 s meanwhile.
    private suspend fun report(body: String?, start: Boolean = false, force: Boolean = false) {
        val o = body?.let { runCatching { json.parseToJsonElement(it) as JsonObject }.getOrNull() } ?: return
        val rel = (o["ItemId"] as? JsonPrimitive)?.contentOrNull?.let(Ids::decode) ?: return
        val t = now()
        if (start) {
            lastWrite[rel] = t
            return
        }
        if (!force && t - (lastWrite[rel] ?: 0L) < WRITE_EVERY_MS) return
        val e = fileOf(rel) ?: return
        val pos = (o["PositionTicks"] as? JsonPrimitive)?.longOrNull?.div(TICKS_PER_MS) ?: 0
        progress.update(rel) { prev ->
            ProgressRules.report(prev, e.size, e.mtimeMs, pos, durations[rel] ?: 0, t).let { r -> titles[rel]?.let { r.copy(title = it) } ?: r }
        }
        lastWrite[rel] = t
    }

    companion object {
        const val USER = "local"
        const val CAP = 10_000
        const val CACHE_MS = 60_000L
        const val WRITE_EVERY_MS = 30_000L
        private const val NEXT_SEEDS = 5
        private const val PEEK = 200
        private const val PEEK_PARALLEL = 8
        // External subtitles get indexes clear of the embedded tracks (Playback numbers those from 0 and 500).
        const val SUB_INDEX = 1000
        private val JSON = "application/json".toMediaType()
        private val STREAM = Regex("^/(Videos|Audio)/([^/]+)/stream")
        private val SEASON = Regex("^(season|saison|staffel|s)\\s*\\d{1,3}$", RegexOption.IGNORE_CASE)
        private val HIDDEN = setOf("@eadir", "#recycle", "\$recycle.bin", "system volume information", "lost+found")
        private val NO_OPS = setOf("/Sessions/Playing/Ping", "/Sessions/Capabilities/Full", "/Sessions/Logout", "/Videos/ActiveEncodings")

        // §4.1: dot-files, NAS and OS system folders.
        fun hidden(name: String) = name.startsWith(".") || name.lowercase() in HIDDEN
    }
}
