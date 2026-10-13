package com.wika.wicaby.core.livetv

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Live TV DisplayPreferences document `wicaby-livetv` (spec §5.4): the lt.* keys, 6 kB chunking,
// the read-modify-write merge and the refuse-to-write rule. Mirrors D/shared/livetv/prefs.ts
// (golden vectors: prefs.json). prefs.ts's LivePrefs is LiveTvPrefs here (LivePrefs.kt, C-3, is
// the store that reads and writes the document).

const val PREFS_ID = "wicaby-livetv"
const val PREFS_CLIENT = "wicaby"
const val PREFS_VERSION = "1"
const val CHUNK_BYTES = 6000
const val RECENTS_CAP = 20

@Serializable
enum class Badge(val id: String) {
    @SerialName("live") LIVE("live"),
    @SerialName("new") NEW("new"),
    @SerialName("premiere") PREMIERE("premiere"),
    @SerialName("repeat") REPEAT("repeat"),
    @SerialName("hd") HD("hd"),
    @SerialName("rating") RATING("rating"),
}

val DEFAULT_BADGES: List<Badge> = listOf(Badge.LIVE, Badge.NEW, Badge.HD)

/** lt.dvrPadding, in seconds. */
@Serializable
data class DvrPadding(val pre: Double, val post: Double)

@Serializable
data class LiveTvPrefs(
    val sort: SortMode = SortMode.NUMBER,
    val favFirst: Boolean = false,
    val lens: LensRef = LensRef.All,
    /** Favourite order (membership stays IsFavorite). */
    val fav: List<String> = emptyList(),
    val hidden: List<String> = emptyList(),
    val groups: List<ClientGroup> = emptyList(),
    val recents: List<String> = emptyList(),
    val badges: List<Badge> = DEFAULT_BADGES,
    val dvrPadding: DvrPadding? = null,
)

fun defaultPrefs(): LiveTvPrefs = LiveTvPrefs()

/** The fields of [LiveTvPrefs] in document order; [key] is the prefs.ts field name. */
enum class PrefField(val key: String, internal val single: String?, internal val chunked: String?) {
    SORT("sort", "lt.sort", null),
    FAV_FIRST("favFirst", "lt.favFirst", null),
    LENS("lens", "lt.lens", null),
    FAV("fav", null, "lt.fav"),
    HIDDEN("hidden", null, "lt.hidden"),
    GROUPS("groups", null, "lt.groups"),
    RECENTS("recents", "lt.recents", null),
    BADGES("badges", "lt.badges", null),
    DVR_PADDING("dvrPadding", "lt.dvrPadding", null),
    ;

    companion object {
        fun fromKey(key: String): PrefField? = entries.firstOrNull { it.key == key }
    }
}

/** Partial<LivePrefs>: the [fields] set in [values] (last writer wins per field). */
data class PrefsPatch(val values: LiveTvPrefs = LiveTvPrefs(), val fields: Set<PrefField> = emptySet()) {
    fun isEmpty(): Boolean = fields.isEmpty()

    operator fun plus(other: PrefsPatch): PrefsPatch =
        PrefsPatch(other.fields.fold(values) { acc, f -> acc.withField(f, other.values) }, fields + other.fields)

    companion object {
        fun of(values: LiveTvPrefs, vararg fields: PrefField): PrefsPatch = PrefsPatch(values, fields.toSet())
    }
}

/** [this] with [field] copied from [from]. */
fun LiveTvPrefs.withField(field: PrefField, from: LiveTvPrefs): LiveTvPrefs = when (field) {
    PrefField.SORT -> copy(sort = from.sort)
    PrefField.FAV_FIRST -> copy(favFirst = from.favFirst)
    PrefField.LENS -> copy(lens = from.lens)
    PrefField.FAV -> copy(fav = from.fav)
    PrefField.HIDDEN -> copy(hidden = from.hidden)
    PrefField.GROUPS -> copy(groups = from.groups)
    PrefField.RECENTS -> copy(recents = from.recents)
    PrefField.BADGES -> copy(badges = from.badges)
    PrefField.DVR_PADDING -> copy(dvrPadding = from.dvrPadding)
}

/** UTF-8 length of a UTF-16 string, as prefs.ts counts it (a high surrogate and its successor are 4 bytes). */
fun utf8Length(s: String): Int {
    var n = 0
    var i = 0
    while (i < s.length) {
        val c = s[i].code
        when {
            c < 0x80 -> n += 1
            c < 0x800 -> n += 2
            c in 0xD800..0xDBFF && i + 1 < s.length -> {
                n += 4
                i++
            }
            else -> n += 3
        }
        i++
    }
    return n
}

/**
 * Splits an array into JSON arrays of at most [max] UTF-8 bytes each (an element is never split; a
 * single oversized element gets a chunk of its own). An empty array writes no key.
 */
fun chunkArray(prefix: String, items: List<JsonElement>, max: Int = CHUNK_BYTES): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    val cur = ArrayList<String>()
    var size = 2 // '[' + ']'
    var n = 0
    fun flush() {
        if (cur.isEmpty()) return
        out["$prefix.${n++}"] = cur.joinToString(",", "[", "]")
        cur.clear()
        size = 2
    }
    for (it in items) {
        val json = jsStringify(it)
        val len = utf8Length(json)
        if (cur.isNotEmpty() && size + len + 1 > max) flush()
        cur.add(json)
        size += len + (if (cur.size > 1) 1 else 0)
    }
    flush()
    return out
}

private fun parseJson(s: String?): JsonElement? = s?.let { runCatching { LiveJson.parseToJsonElement(it) }.getOrNull() }

/** Reads prefix.0, prefix.1, … until a gap; a chunk that is not a JSON array is skipped. */
fun readChunks(custom: Map<String, String>, prefix: String): List<JsonElement> {
    val out = ArrayList<JsonElement>()
    var i = 0
    while (true) {
        val raw = custom["$prefix.$i"] ?: break
        (parseJson(raw) as? JsonArray)?.let { out.addAll(it) }
        i++
    }
    return out
}

private fun JsonElement.nonEmptyString(): String? = jsString()?.takeIf { it.isNotEmpty() }
private fun List<JsonElement>.strings(): List<String> = mapNotNull { it.nonEmptyString() }.distinct()

private fun asLens(v: JsonElement?): LensRef? {
    val o = v as? JsonObject ?: return null
    return when (o["kind"].jsString()) {
        "all" -> LensRef.All
        "favorites" -> LensRef.Favorites
        "recents" -> LensRef.Recents
        "radio" -> LensRef.Radio
        "tag" -> o["tag"]?.nonEmptyString()?.let { LensRef.Tag(it) }
        "group" -> o["id"]?.nonEmptyString()?.let { LensRef.Group(it) }
        else -> null
    }
}

/** CustomPrefs → LiveTvPrefs. Unknown or broken values fall back to the defaults. */
fun decodePrefs(custom: Map<String, String>?): LiveTvPrefs {
    val c = custom ?: emptyMap()
    val groups = readChunks(c, "lt.groups").mapNotNull { g ->
        val o = g as? JsonObject ?: return@mapNotNull null
        val id = o["id"]?.nonEmptyString() ?: return@mapNotNull null
        val name = o["name"].jsString() ?: return@mapNotNull null
        val ids = o["ids"] as? JsonArray ?: return@mapNotNull null
        ClientGroup(id, name, ids.strings())
    }
    val rec = parseJson(c["lt.recents"]) as? JsonArray
    val pad = parseJson(c["lt.dvrPadding"]) as? JsonObject
    val pre = pad?.get("pre").jsNumber()
    val post = pad?.get("post").jsNumber()
    val d = defaultPrefs()
    return LiveTvPrefs(
        sort = SortMode.fromId(c["lt.sort"]) ?: d.sort,
        favFirst = c["lt.favFirst"] == "1",
        lens = asLens(parseJson(c["lt.lens"])) ?: d.lens,
        fav = readChunks(c, "lt.fav").strings(),
        hidden = readChunks(c, "lt.hidden").strings(),
        groups = groups,
        recents = rec?.strings()?.take(RECENTS_CAP) ?: d.recents,
        badges = c["lt.badges"]?.split(',')?.mapNotNull { b -> Badge.entries.firstOrNull { it.id == b } } ?: d.badges,
        dvrPadding = if (pre != null && post != null && pre >= 0 && post >= 0) DvrPadding(pre, post) else null,
    )
}

/** The keys [field] of [p] encodes to (chunk keys numbered from 0). */
fun encodeField(field: PrefField, p: LiveTvPrefs): Map<String, String> = when (field) {
    PrefField.SORT -> mapOf("lt.sort" to p.sort.id)
    PrefField.FAV_FIRST -> mapOf("lt.favFirst" to if (p.favFirst) "1" else "0")
    PrefField.LENS -> mapOf("lt.lens" to jsStringify(LiveJson.encodeToJsonElement(LensRef.serializer(), p.lens)))
    PrefField.RECENTS -> mapOf("lt.recents" to jsStringify(JsonArray(p.recents.take(RECENTS_CAP).map(::JsonPrimitive))))
    PrefField.BADGES -> mapOf("lt.badges" to p.badges.joinToString(",") { it.id })
    PrefField.DVR_PADDING -> p.dvrPadding?.let { mapOf("lt.dvrPadding" to jsStringify(JsonObject(linkedMapOf("pre" to jsonNumber(it.pre), "post" to jsonNumber(it.post))))) } ?: emptyMap()
    PrefField.FAV -> chunkArray("lt.fav", p.fav.map(::JsonPrimitive))
    PrefField.HIDDEN -> chunkArray("lt.hidden", p.hidden.map(::JsonPrimitive))
    PrefField.GROUPS -> chunkArray("lt.groups", p.groups.map { LiveJson.encodeToJsonElement(ClientGroup.serializer(), it) })
}

private val CHUNK_INDEX_RE = Regex("\\d+")

private fun ownsKey(field: PrefField, key: String): Boolean {
    field.single?.let { return key == it }
    val prefix = field.chunked!! + "."
    return key.startsWith(prefix) && CHUNK_INDEX_RE.matches(key.substring(prefix.length))
}

/**
 * Read-modify-write: start from the server's CustomPrefs, replace only the changed fields (their old
 * keys, including chunk keys the new value no longer uses, are deleted), keep everything else (other
 * apps' keys, other fields written by another device), and stamp lt.v.
 */
fun mergeCustomPrefs(server: Map<String, String>?, changes: PrefsPatch): Map<String, String> {
    val out = LinkedHashMap<String, String>(server ?: emptyMap())
    for (field in PrefField.entries) {
        if (field !in changes.fields) continue
        out.keys.removeAll { ownsKey(field, it) }
        out.putAll(encodeField(field, changes.values))
    }
    out["lt.v"] = PREFS_VERSION
    return out
}

/** The full DTO to POST: the server document with Id, Client and CustomPrefs set (Emby reads the client from the body, §5.2). */
fun prefsBody(serverDto: JsonObject?, custom: Map<String, String>): JsonObject {
    val out = LinkedHashMap<String, JsonElement>(serverDto ?: emptyMap())
    out["Id"] = JsonPrimitive(PREFS_ID)
    out["Client"] = JsonPrimitive(PREFS_CLIENT)
    out["CustomPrefs"] = JsonObject(custom.mapValues { JsonPrimitive(it.value) })
    return JsonObject(out)
}

/** A server CustomPrefs object as a string map (non-string values are dropped). */
fun customPrefsOf(dto: JsonObject?): Map<String, String> {
    val o = dto?.get("CustomPrefs") as? JsonObject ?: return emptyMap()
    val out = LinkedHashMap<String, String>()
    for ((k, v) in o) v.jsString()?.let { out[k] = it }
    return out
}

// ---- Write queue: refuse to write while the document failed to load ----

enum class PrefsLoad(val id: String) { PENDING("pending"), OK("ok"), FAILED("failed") }

data class PrefsSync(val load: PrefsLoad = PrefsLoad.PENDING, val queued: PrefsPatch = PrefsPatch())

fun syncInit(): PrefsSync = PrefsSync()

fun queueChange(s: PrefsSync, changes: PrefsPatch): PrefsSync = s.copy(queued = s.queued + changes)

fun loaded(s: PrefsSync, ok: Boolean): PrefsSync = s.copy(load = if (ok) PrefsLoad.OK else PrefsLoad.FAILED)

data class PrefsWrite(val body: JsonObject, val next: PrefsSync)

/** The next POST, or null when nothing is queued or the document is not loaded (no empty overwrite). */
fun planWrite(s: PrefsSync, server: JsonObject?): PrefsWrite? {
    if (s.load != PrefsLoad.OK || s.queued.isEmpty()) return null
    return PrefsWrite(prefsBody(server, mergeCustomPrefs(customPrefsOf(server), s.queued)), s.copy(queued = PrefsPatch()))
}

/** Favourite toggles and order edits are refused while favourites or prefs failed to load (§6.5). */
fun canEditFavorites(s: PrefsSync, favoritesLoaded: Boolean): Boolean = s.load == PrefsLoad.OK && favoritesLoaded
