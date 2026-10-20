package com.wika.wicaby.core.plex

import com.wika.wicaby.core.data.isoUtc
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// PMS JSON → Emby-shaped JSON (plex-spec §4), the twin of desktop shared/plex/map.ts: the apps keep decoding the
// Item / ItemsResult / MediaSource shapes they already read, so no Plex shape reaches a screen. Pure; PlexVectorsTest
// replays tools/checks/fixtures/plex/vectors.json against it, as plex-map-check.mjs does for the desktop.
object PlexMap {
    const val TICKS_PER_MS = 10_000L

    fun msToTicks(ms: JsonElement?): Long? = ms.num()?.takeIf { it.isFinite() }?.let { jsRound(it * TICKS_PER_MS).toLong() }

    fun ticksToMs(ticks: JsonElement?): Long {
        val n = ticks.jsNumber()
        return if (n.isFinite() && n > 0) jsRound(n / TICKS_PER_MS).toLong() else 0
    }

    fun epochToIso(s: JsonElement?): String? = s.num()?.takeIf { it > 0 }?.let { isoUtc((it * 1000).toLong()) }

    // A ratingKey is decimal; sections and people get a prefix so they never collide with one.
    fun sectionId(key: String) = "section-$key"

    fun personId(id: String) = "person-$id"

    data class ParsedId(val kind: String, val key: String)

    private val ID = Regex("^(?:(section|person)-)?(\\d{1,20})$")

    fun parseId(id: String): ParsedId? = ID.find(id)?.let { ParsedId(it.groupValues[1].ifEmpty { "item" }, it.groupValues[2]) }

    private val TYPES = mapOf(
        "movie" to "Movie", "show" to "Series", "season" to "Season", "episode" to "Episode", "artist" to "MusicArtist",
        "album" to "MusicAlbum", "track" to "Audio", "collection" to "BoxSet", "playlist" to "Playlist", "clip" to "Video",
        // D-7: photos reuse the photo feature's shapes.
        "photo" to "Photo", "photoalbum" to "PhotoAlbum",
    )
    private val FOLDERS = setOf("show", "season", "artist", "album", "collection", "playlist", "photoalbum")
    private val COLLECTION_TYPES = mapOf("movie" to "movies", "show" to "tvshows", "artist" to "music", "photo" to "homevideos")

    // Emby type of a PMS item, or null for one the dialect does not map (left out of lists).
    fun itemType(meta: JsonElement?): String? {
        val type = meta["type"].str()
        if (type == "clip" && meta["extraType"].jsNumber() == 1.0) return "Trailer"
        return TYPES[type]
    }

    fun collectionType(sectionType: String?): String? = COLLECTION_TYPES[sectionType]

    fun toView(s: JsonElement?): JsonObject {
        val out = obj()
        out["Id"] = js(sectionId(s["key"].str().orEmpty()))
        s["title"]?.let { out["Name"] = it }
        out["Type"] = js("CollectionFolder")
        out["IsFolder"] = jb(true)
        collectionType(s["type"].str())?.let { out["CollectionType"] = js(it) }
        PlexImages.imageTag(s["thumb"].str())?.let { out["ImageTags"] = JsonObject(mapOf("Primary" to js(it))) }
        return out.json()
    }

    private fun truthyFlag(v: JsonElement?) = v.isTrue() || v.num() == 1.0 || v.str() == "1" && v.isStr()

    fun toUserData(meta: JsonElement?): JsonObject {
        val folder = meta["type"].str() in FOLDERS
        val views = orZero(meta["viewCount"].jsNumber())
        val ud = obj()
        ud["IsFavorite"] = jb(false)
        ud["PlayCount"] = jn(views)
        ud["PlaybackPositionTicks"] = jn(msToTicks(meta["viewOffset"]) ?: 0)
        val leaf = meta["leafCount"].num()
        if (folder && leaf != null) {
            val unplayed = maxOf(0.0, leaf - orZero(meta["viewedLeafCount"].jsNumber()))
            ud["UnplayedItemCount"] = jn(unplayed)
            ud["Played"] = jb(leaf > 0 && unplayed == 0.0)
        } else {
            ud["Played"] = jb(views > 0)
        }
        if (!folder && meta["viewOffset"].truthy() && meta["duration"].truthy()) {
            ud["PlayedPercentage"] = jn(jsRound(meta["viewOffset"].jsNumber() / meta["duration"].jsNumber() * 10_000) / 100)
        }
        epochToIso(meta["lastViewedAt"])?.let { ud["LastPlayedDate"] = js(it) }
        return ud.json()
    }

    // Plex codec names → the Emby ones the players and chips read.
    private val SUB_CODECS = mapOf("srt" to "subrip", "pgs" to "pgssub", "vobsub" to "dvdsub", "smi" to "sami")
    private val TEXT_SUBS = setOf("subrip", "ass", "ssa", "webvtt", "vtt", "mov_text", "sami", "text")
    private val STREAM_TYPES = mapOf("1" to "Video", "2" to "Audio", "3" to "Subtitle")

    private fun videoRange(s: JsonElement?, out: Obj) {
        val trc = (s["colorTrc"].str() ?: "").lowercase()
        if (trc.isNotEmpty()) out["ColorTransfer"] = js(trc)
        if (s["DOVIPresent"].truthy() || s["DOVIProfile"].truthy()) {
            out["VideoRange"] = js("HDR")
            out["VideoRangeType"] = js("DOVI")
            if (s["DOVIProfile"].truthy()) out["DvProfile"] = s["DOVIProfile"]!!
            s["DOVIBLCompatID"]?.let { out["DvBlSignalCompatibilityId"] = it }
        } else if (trc == "smpte2084") {
            out["VideoRange"] = js("HDR")
            out["VideoRangeType"] = js("HDR10")
        } else if (trc == "arib-std-b67") {
            out["VideoRange"] = js("HDR")
            out["VideoRangeType"] = js("HLG")
        } else {
            out["VideoRange"] = js("SDR")
            out["VideoRangeType"] = js("SDR")
        }
    }

    // Index = the PMS stream id (unique, what Plex selects by), never the ordinal (plex-spec §4, risk R-2).
    fun toStream(s: JsonElement?): JsonObject? {
        val type = STREAM_TYPES[s["streamType"].str()] ?: return null
        val id = s["id"]?.takeIf { it.isNum() } ?: return null
        val codec = s["codec"].takeIf { it.truthy() }?.str()?.lowercase()?.let { SUB_CODECS[it] ?: it }
        val out = obj()
        out["Index"] = id
        out["Type"] = js(type)
        codec?.let { out["Codec"] = js(it) }
        (s["languageCode"] ?: s["languageTag"]).takeIf { it.truthy() }?.let { out["Language"] = it }
        s["title"].takeIf { it.truthy() }?.let { out["Title"] = it }
        (s["extendedDisplayTitle"] ?: s["displayTitle"]).takeIf { it.truthy() }?.let { out["DisplayTitle"] = it }
        if (s["default"].truthy()) out["IsDefault"] = jb(true)
        if (s["forced"].truthy()) out["IsForced"] = jb(true)
        if (s["hearingImpaired"].truthy()) out["IsHearingImpaired"] = jb(true)
        if (s["visualImpaired"].truthy()) out["IsVisualImpaired"] = jb(true)
        if (type == "Video") {
            s["width"].takeIf { it.truthy() }?.let { out["Width"] = it }
            s["height"].takeIf { it.truthy() }?.let { out["Height"] = it }
            s["frameRate"].takeIf { it.truthy() }?.let { out["RealFrameRate"] = it }
            videoRange(s, out)
        }
        if (type == "Audio") {
            s["channels"].takeIf { it.truthy() }?.let { out["Channels"] = it }
            s["audioChannelLayout"].takeIf { it.truthy() }?.let { out["ChannelLayout"] = it }
        }
        if (s["bitrate"].truthy()) out["BitRate"] = jn(s["bitrate"].jsNumber() * 1000)
        if (type == "Subtitle") {
            out["IsTextSubtitleStream"] = jb(codec != null && codec in TEXT_SUBS)
            s["key"].takeIf { it.truthy() }?.let {
                out["IsExternal"] = jb(true)
                out["DeliveryMethod"] = js("External")
                out["DeliveryUrl"] = it
            }
        }
        return out.json()
    }

    // A part PMS cannot read (exists=false or accessible=false, sent with checkFiles=1).
    internal fun partMissing(p: JsonElement?) = p["exists"].isFalse() || p["accessible"].isFalse()

    private val DIGITS = Regex("^\\d+$")

    private fun resolutionLabel(m: JsonElement?): String? {
        val r = (m["videoResolution"].str() ?: "").lowercase()
        if (r == "4k") return "4K"
        if (DIGITS.matches(r)) return "${r}p"
        return r.ifEmpty { null }?.uppercase()
    }

    private fun isType(s: JsonElement?, type: Int) = s["streamType"].num() == type.toDouble()

    // One source per playable Media (versions; an edition's title names it). Multi-part media is one source whose
    // streams are the first part's: the parts play as one queue (D-4). Server file paths are never sent.
    fun toMediaSources(meta: JsonElement?): List<JsonObject> {
        val out = ArrayList<JsonObject>()
        for (m in meta["Media"].list()) {
            val parts = m["Part"].list()
            if (parts.isEmpty() || parts.all(::partMissing)) continue
            val first = parts.firstOrNull { !partMissing(it) } ?: parts[0]
            val raw = first["Stream"].list()
            val streams = raw.mapNotNull(::toStream)
            fun selected(type: Int) = raw.firstOrNull { isType(it, type) && it["selected"].truthy() } ?: raw.firstOrNull { isType(it, type) && it["default"].truthy() }
            val src = obj()
            src["Id"] = js(m["id"].str().toString())
            src["Protocol"] = js("File")
            src["SupportsDirectPlay"] = jb(true)
            src["SupportsDirectStream"] = jb(true)
            src["SupportsTranscoding"] = jb(true)
            src["MediaStreams"] = jarr(streams)
            val name = m["editionTitle"] ?: meta["editionTitle"] ?: m["title"]
            if (name != null) {
                if (name.truthy()) src["Name"] = name
            } else {
                resolutionLabel(m)?.let { src["Name"] = js(it) }
            }
            (m["container"] ?: first["container"]).takeIf { it.truthy() }?.let { src["Container"] = it }
            if (m["bitrate"].truthy()) src["Bitrate"] = jn(m["bitrate"].jsNumber() * 1000)
            val size = parts.sumOf { orZero(it["size"]?.jsNumber() ?: 0.0) }
            if (size != 0.0) src["Size"] = jn(size)
            msToTicks(m["duration"] ?: meta["duration"])?.takeIf { it != 0L }?.let { src["RunTimeTicks"] = jn(it) }
            selected(2)?.let { a -> a["id"]?.let { src["DefaultAudioStreamIndex"] = it } }
            raw.firstOrNull { isType(it, 3) && it["selected"].truthy() }?.let { s -> s["id"]?.let { src["DefaultSubtitleStreamIndex"] = it } }
            out += src.json()
        }
        return out
    }

    private fun people(meta: JsonElement?): List<JsonObject> {
        fun one(p: JsonElement, type: String): JsonObject? {
            val id = p["id"].str() ?: return null
            val tag = p["tag"].takeIf { it.truthy() } ?: return null
            val out = obj()
            out["Id"] = js(personId(id))
            out["Name"] = tag
            out["Type"] = js(type)
            p["role"].takeIf { it.truthy() }?.let { out["Role"] = it }
            PlexImages.imageTag(p["thumb"].str())?.let { out["PrimaryImageTag"] = js(it) }
            return out.json()
        }
        return meta["Director"].list().mapNotNull { one(it, "Director") } + meta["Writer"].list().mapNotNull { one(it, "Writer") } +
            meta["Role"].list().mapNotNull { one(it, "Actor") }
    }

    // Rating[] image "imdb://image.rating" → source "imdb".
    private fun providerRatings(meta: JsonElement?): List<JsonObject> = meta["Rating"].list()
        .filter { it["value"].isNum() && it["image"].truthy() }
        .map { r -> JsonObject(linkedMapOf("Source" to js((r["image"].str() ?: "").split("://")[0]), "Type" to (r["type"] ?: js("audience")), "Value" to r["value"]!!)) }

    fun toChapters(meta: JsonElement?): List<JsonObject>? = meta["Chapter"].list()
        .filter { it["startTimeOffset"].isNum() }
        .map { c ->
            val out = obj()
            out["StartPositionTicks"] = jn(c["startTimeOffset"].jsNumber() * TICKS_PER_MS)
            c["tag"].takeIf { it.truthy() }?.let { out["Name"] = it }
            out.json()
        }.ifEmpty { null }

    private fun idOf(v: JsonElement?) = js(v.str().toString())

    fun toItem(meta: JsonElement?): JsonObject? {
        val type = itemType(meta) ?: return null
        if (!meta["ratingKey"].truthy()) return null
        val plexType = meta["type"].str()
        val out = obj()
        out["Id"] = idOf(meta["ratingKey"])
        out["Name"] = meta["title"] ?: js("")
        out["Type"] = js(type)
        val folder = plexType in FOLDERS
        out["IsFolder"] = jb(folder)
        when {
            plexType == "track" -> out["MediaType"] = js("Audio")
            plexType == "photo" -> out["MediaType"] = js("Photo")
            plexType == "playlist" -> out["MediaType"] = js(when (meta["playlistType"].str()) { "audio" -> "Audio"; "photo" -> "Photo"; else -> "Video" })
            !folder -> out["MediaType"] = js("Video")
        }
        meta["summary"].takeIf { it.truthy() }?.let { out["Overview"] = it }
        meta["tagline"].takeIf { it.truthy() }?.let { out["Taglines"] = jarr(listOf(it)) }
        meta["year"].takeIf { it.truthy() }?.let { out["ProductionYear"] = it }
        meta["originallyAvailableAt"].takeIf { it.truthy() }?.let { out["PremiereDate"] = js("${it.str()}T00:00:00.0000000Z") }
        meta["contentRating"].takeIf { it.truthy() }?.let { out["OfficialRating"] = it }
        val rt = (meta["ratingImage"].str() ?: "").startsWith("rottentomatoes://")
        val rating = meta["rating"]?.takeIf { it.isNum() }
        when {
            meta["audienceRating"].isNum() -> out["CommunityRating"] = meta["audienceRating"]!!
            rating != null && !rt -> out["CommunityRating"] = rating
        }
        if (rating != null && rt) out["CriticRating"] = jn(jsRound(rating.jsNumber() * 10))
        providerRatings(meta).takeIf { it.isNotEmpty() }?.let { out["ProviderRatings"] = jarr(it) }
        msToTicks(meta["duration"])?.takeIf { it != 0L }?.let { out["RunTimeTicks"] = jn(it) }
        meta["index"]?.takeIf { it.isNum() }?.let { out["IndexNumber"] = it }
        meta["parentIndex"]?.takeIf { it.isNum() }?.let { out["ParentIndexNumber"] = it }
        val parentKey = meta["parentRatingKey"].takeIf { it.truthy() }
        val grandKey = meta["grandparentRatingKey"].takeIf { it.truthy() }
        val parentTitle = meta["parentTitle"].takeIf { it.truthy() }
        val grandTitle = meta["grandparentTitle"].takeIf { it.truthy() }
        fun nameId(name: JsonElement, id: JsonElement) = jarr(listOf(JsonObject(linkedMapOf("Name" to name, "Id" to idOf(id)))))
        when (plexType) {
            "episode" -> {
                grandKey?.let { out["SeriesId"] = idOf(it) }
                grandTitle?.let { out["SeriesName"] = it }
                parentKey?.let { out["SeasonId"] = idOf(it) }
                parentTitle?.let { out["SeasonName"] = it }
                parentKey?.let { out["ParentId"] = idOf(it) }
            }
            "season" -> {
                parentKey?.let {
                    out["SeriesId"] = idOf(it)
                    out["ParentId"] = idOf(it)
                }
                parentTitle?.let { out["SeriesName"] = it }
            }
            "album" -> {
                parentTitle?.let { out["AlbumArtist"] = it }
                if (parentKey != null && parentTitle != null) out["AlbumArtists"] = nameId(parentTitle, parentKey)
            }
            "track" -> {
                parentTitle?.let { out["Album"] = it }
                parentKey?.let { out["AlbumId"] = idOf(it) }
                grandTitle?.let { out["AlbumArtist"] = it }
                if (grandKey != null && grandTitle != null) out["AlbumArtists"] = nameId(grandTitle, grandKey)
                // A track artist other than the album's (originalTitle) has no item of its own in PMS: a name only.
                (meta["originalTitle"] ?: meta["grandparentTitle"]).takeIf { it.truthy() }?.let { out["Artists"] = jarr(listOf(it)) }
                if (!meta["originalTitle"].truthy() && grandTitle != null && grandKey != null) out["ArtistItems"] = nameId(grandTitle, grandKey)
                PlexImages.imageTag(meta["parentThumb"].str())?.let { out["AlbumPrimaryImageTag"] = js(it) }
            }
        }
        meta["librarySectionID"]?.let { if (plexType == "movie" || plexType == "show" || plexType == "artist") out["ParentId"] = js(sectionId(it.str().orEmpty())) }
        meta["childCount"]?.takeIf { it.isNum() }?.let { out["ChildCount"] = it }
        meta["leafCount"]?.takeIf { it.isNum() }?.let { out["RecursiveItemCount"] = it }
        PlexGuid.providerIds(meta).takeIf { it.isNotEmpty() }?.let { out["ProviderIds"] = it.toJson() }
        meta["Genre"].list().mapNotNull { g -> g["tag"].takeIf { it.truthy() } }.takeIf { it.isNotEmpty() }?.let { out["Genres"] = jarr(it) }
        meta["studio"].takeIf { it.truthy() }?.let { out["Studios"] = jarr(listOf(JsonObject(mapOf("Name" to it)))) }
        meta["Label"].list().mapNotNull { l -> l["tag"].takeIf { it.truthy() } }.takeIf { it.isNotEmpty() }?.let { out["Tags"] = jarr(it) }
        people(meta).takeIf { it.isNotEmpty() }?.let { out["People"] = jarr(it) }
        // Images: the tag is the PMS path's timestamp; PlexImages.imagePaths() keeps the paths for the adapter.
        val images = meta["Image"].list()
        val tags = LinkedHashMap<String, JsonElement>()
        PlexImages.imageTag((images.firstOrNull { it["type"].str() == "coverPoster" || it["type"].str() == "snapshot" }?.get("url") ?: meta["thumb"]).str())?.let { tags["Primary"] = js(it) }
        PlexImages.imageTag(images.firstOrNull { it["type"].str() == "clearLogo" }?.get("url").str())?.let { tags["Logo"] = js(it) }
        if (tags.isNotEmpty()) out["ImageTags"] = JsonObject(tags)
        PlexImages.imageTag((images.firstOrNull { it["type"].str() == "background" }?.get("url") ?: meta["art"]).str())?.let { out["BackdropImageTags"] = jstrs(listOf(it)) }
        if (grandKey != null && (plexType == "episode" || plexType == "season")) {
            PlexImages.imageTag(meta["grandparentThumb"].str())?.let { out["SeriesPrimaryImageTag"] = js(it) }
            PlexImages.imageTag(meta["grandparentArt"].str())?.let {
                out["ParentBackdropItemId"] = idOf(grandKey)
                out["ParentBackdropImageTags"] = jstrs(listOf(it))
            }
        }
        // A playlist entry: what the playlist screens remove and move (the same item may appear twice).
        meta["playlistItemID"]?.let { out["PlaylistItemId"] = idOf(it) }
        if (meta["addedAt"].truthy()) epochToIso(meta["addedAt"])?.let { out["DateCreated"] = js(it) }
        if (meta["updatedAt"].truthy()) out["Etag"] = idOf(meta["updatedAt"])
        // A photo is an image, not a stream: its size only.
        val media = if (plexType == "photo") emptyList() else toMediaSources(meta)
        if (plexType == "photo") meta["Media"].list().firstOrNull()?.let { m ->
            m["width"].takeIf { it.truthy() }?.let { out["Width"] = it }
            m["height"].takeIf { it.truthy() }?.let { out["Height"] = it }
        }
        if (media.isNotEmpty()) {
            out["MediaSources"] = jarr(media)
            media[0]["MediaStreams"]?.let { out["MediaStreams"] = it }
            val v = media[0]["MediaStreams"].list().firstOrNull { it["Type"].str() == "Video" }
            v["Width"].takeIf { it.truthy() }?.let { out["Width"] = it }
            v["Height"].takeIf { it.truthy() }?.let { out["Height"] = it }
            if (out["MediaType"].str() == "Video") media[0]["Container"]?.let { out["Container"] = it }
        }
        toChapters(meta)?.let { out["Chapters"] = jarr(it) }
        meta["Extras"]["Metadata"]?.let { extras ->
            out["LocalTrailerCount"] = jn(extras.list().count { it["type"].str() == "clip" && it["extraType"].jsNumber() == 1.0 }.toLong())
        }
        out["UserData"] = if (plexType != "collection" && plexType != "playlist") toUserData(meta) else JsonObject(
            linkedMapOf("IsFavorite" to jb(false), "Played" to jb(false), "PlayCount" to jn(0), "PlaybackPositionTicks" to jn(0)),
        )
        return out.json()
    }

    // A container's items (unmapped types left out) with Emby paging: TotalRecordCount is PMS's totalSize when it
    // sent one (X-Plex-Container-Size was set), else the page's size.
    fun toItemsResult(c: JsonElement?, startIndex: Int = 0): JsonObject {
        val metas = c["Metadata"].list()
        val items = metas.mapNotNull(::toItem)
        val offset = orZero(c["offset"].jsNumber()).let { if (it == 0.0) startIndex.toDouble() else it }
        val total = c["totalSize"]?.takeIf { it.isNum() }?.jsNumber() ?: (metas.size + offset)
        return JsonObject(linkedMapOf("Items" to jarr(items), "TotalRecordCount" to jn(total), "StartIndex" to jn(offset)))
    }

    // Extras split the Emby way: /LocalTrailers gets the trailers, /SpecialFeatures the rest.
    fun toExtras(meta: JsonElement?, trailers: Boolean): List<JsonObject> = meta["Extras"]["Metadata"].list()
        .filter { it["type"].str() == "clip" && (it["extraType"].jsNumber() == 1.0) == trailers }
        .mapNotNull(::toItem)

    // Marker[] → the Jellyfin MediaSegments answer player/Segments.kt already reads. Intro markers on a movie are
    // dropped (Plezy #2235); credits come only from a marker (#2137).
    private val SEGMENTS = mapOf("intro" to "Intro", "credits" to "Outro", "commercial" to "Commercial")

    fun toSegments(meta: JsonElement?): JsonObject {
        val movie = meta["type"].str() == "movie"
        val items = meta["Marker"].list()
            .filter { m -> SEGMENTS[m["type"].str()] != null && !(m["type"].str() == "intro" && movie) }
            .filter { it["startTimeOffset"].isNum() && it["endTimeOffset"].isNum() && it["endTimeOffset"].jsNumber() > it["startTimeOffset"].jsNumber() }
            .map { m -> Triple(SEGMENTS[m["type"].str()]!!, m["startTimeOffset"].jsNumber() * TICKS_PER_MS, m["endTimeOffset"].jsNumber() * TICKS_PER_MS) }
            .sortedBy { it.second }
            .map { (t, s, e) -> JsonObject(linkedMapOf("Type" to js(t), "StartTicks" to jn(s), "EndTicks" to jn(e))) }
        return JsonObject(mapOf("Items" to jarr(items)))
    }

    // Server hubs (caps.serverHubs) → [{Name, Key, Items}], the one new Emby-shaped answer (plex-spec §8).
    fun toHubs(c: JsonElement?): List<JsonObject> = c["Hub"].list()
        .map { h -> Triple(h["title"].str() ?: "", (h["hubIdentifier"] ?: h["key"]).str() ?: "", h["Metadata"].list().mapNotNull(::toItem)) }
        .filter { it.third.isNotEmpty() }
        .map { (name, key, items) -> JsonObject(linkedMapOf("Name" to js(name), "Key" to js(key), "Items" to jarr(items))) }

    private fun readableMedia(meta: JsonElement?, mediaSourceId: String?): JsonElement? {
        val media = meta["Media"].list().filter { m -> m["Part"].list().any { !partMissing(it) } }
        return (if (!mediaSourceId.isNullOrEmpty()) media.firstOrNull { it["id"].str() == mediaSourceId } else null) ?: media.firstOrNull()
    }

    // The part a stream, BIF or direct play request reads: the first readable part of the chosen Media.
    fun playablePart(meta: JsonElement?, mediaSourceId: String? = null): JsonObject? =
        readableMedia(meta, mediaSourceId)["Part"].list().firstOrNull { !partMissing(it) } as? JsonObject

    // Every readable part of a Media, in order: a multi-part film plays them as one queue (D-4).
    fun partQueue(meta: JsonElement?, mediaSourceId: String? = null): List<JsonObject> =
        readableMedia(meta, mediaSourceId)["Part"].objs().filter { !partMissing(it) }

    // Seasons hidden by the show (flattenSeasons=1, Plezy #1008): the Series page lists every episode instead.
    fun seasonsFlattened(show: JsonElement?): Boolean = truthyFlag(show["flattenSeasons"])

    // plex.tv's account profile → the subtitle default of a Plex play (§6.4, #1182): autoSelectSubtitle 0/1/2 =
    // manual/foreign/always, and the subtitle language.
    fun accountSubtitles(profile: JsonElement?): JsonObject {
        val n = profile["autoSelectSubtitle"].jsNumber()
        val mode = listOf("manual", "foreign", "always").getOrNull(if (n == Math.floor(n) && !n.isNaN()) n.toInt() else -1)
        val language = profile["defaultSubtitleLanguage"]?.takeIf { it.isStr() } ?: JsonPrimitive("")
        return JsonObject(if (mode != null) linkedMapOf("mode" to js(mode), "language" to language) else linkedMapOf("language" to language))
    }
}
