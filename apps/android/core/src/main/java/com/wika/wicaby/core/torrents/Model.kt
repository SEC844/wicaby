package com.wika.wicaby.core.torrents

import androidx.annotation.StringRes
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.longOrNull

// qBittorrent Web API v2 speaks snake_case JSON; field names follow the wiki.
@OptIn(ExperimentalSerializationApi::class)
internal val qbitJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    isLenient = true
}

// qBittorrent reports "no ETA" as 8640000 s (100 days).
const val ETA_INFINITE = 8_640_000L

@Serializable
data class Torrent(
    val hash: String = "",
    val name: String = "",
    // Size of the selected files; total_size counts skipped files too.
    val size: Long = 0,
    @SerialName("total_size") val totalSize: Long = 0,
    val progress: Float = 0f,
    @SerialName("dlspeed") val dlSpeed: Long = 0,
    @SerialName("upspeed") val upSpeed: Long = 0,
    val eta: Long = ETA_INFINITE,
    val state: String = "",
    val category: String = "",
    val tags: String = "",
    @SerialName("num_seeds") val seeds: Int = 0,
    @SerialName("num_leechs") val peers: Int = 0,
    @SerialName("num_complete") val seedsTotal: Int = 0,
    @SerialName("num_incomplete") val peersTotal: Int = 0,
    val ratio: Double = 0.0,
    @SerialName("added_on") val addedOn: Long = 0,
    @SerialName("completion_on") val completionOn: Long = 0,
    @SerialName("amount_left") val amountLeft: Long = 0,
    val downloaded: Long = 0,
    val uploaded: Long = 0,
    @SerialName("save_path") val savePath: String = "",
    @SerialName("content_path") val contentPath: String = "",
    // Queue position; 0 / -1 when queueing is off or the torrent is seeding.
    val priority: Int = 0,
    @SerialName("seq_dl") val sequential: Boolean = false,
    @SerialName("f_l_piece_prio") val firstLast: Boolean = false,
    @SerialName("force_start") val forceStart: Boolean = false,
) {
    val status: TorrentStatus get() = TorrentStatus.of(state)

    // 4.x says pausedDL/pausedUP, 5.x stoppedDL/stoppedUP.
    val isPaused: Boolean get() = state.startsWith("paused") || state.startsWith("stopped")
    // Finished = all wanted pieces are in, whatever the seeding state (same rule as the desktop app).
    val isComplete: Boolean get() = progress >= 1f && !BUSY.containsMatchIn(state)
    val bytes: Long get() = if (size > 0) size else totalSize
    val hasEta: Boolean get() = eta in 1 until ETA_INFINITE
}

private val BUSY = Regex("^(checking|moving|metaDL|forcedMetaDL|error|missingFiles)")

// labelRes for Compose (stringResource); label resolves it in the UI language (Core.str).
enum class TorrentStatus(@StringRes val labelRes: Int) {
    Downloading(R.string.torrent_state_downloading),
    Seeding(R.string.torrent_state_seeding),
    Paused(R.string.torrent_state_paused),
    Completed(R.string.torrent_state_completed),
    Queued(R.string.torrent_state_queued),
    Checking(R.string.torrent_state_checking),
    Stalled(R.string.torrent_state_stalled),
    Metadata(R.string.torrent_state_metadata),
    Moving(R.string.torrent_state_moving),
    Error(R.string.torrent_state_error),
    ;

    val label: String get() = Core.str(labelRes)

    companion object {
        fun of(state: String): TorrentStatus = when (state) {
            "downloading", "forcedDL" -> Downloading
            "uploading", "forcedUP", "stalledUP" -> Seeding
            "stalledDL" -> Stalled
            "pausedDL", "stoppedDL" -> Paused
            "pausedUP", "stoppedUP" -> Completed
            "queuedDL", "queuedUP" -> Queued
            "checkingDL", "checkingUP", "checkingResumeData", "allocating" -> Checking
            "metaDL", "forcedMetaDL" -> Metadata
            "moving" -> Moving
            "error", "missingFiles" -> Error
            else -> Queued
        }
    }
}

@Serializable
data class Category(val name: String = "", val savePath: String = "")

// server_state from sync/maindata (a superset of transfer/info).
@Serializable
data class ServerState(
    @SerialName("dl_info_speed") val dlSpeed: Long = 0,
    @SerialName("up_info_speed") val upSpeed: Long = 0,
    @SerialName("dl_info_data") val dlData: Long = 0,
    @SerialName("up_info_data") val upData: Long = 0,
    @SerialName("dl_rate_limit") val dlLimit: Long = 0,
    @SerialName("up_rate_limit") val upLimit: Long = 0,
    @SerialName("free_space_on_disk") val freeSpace: Long = -1,
    // connected, firewalled or disconnected.
    @SerialName("connection_status") val connection: String = "",
    @SerialName("use_alt_speed_limits") val altSpeed: Boolean = false,
    @SerialName("dht_nodes") val dhtNodes: Int = 0,
)

typealias TransferInfo = ServerState

// The merged state of sync/maindata. Pure and immutable: [merge] returns a new copy.
// The protocol: send the last rid; the reply carries only what changed since then
// (partial torrent objects, removed hashes...), or everything when full_update is true.
data class MainData(
    val rid: Long = 0,
    val torrents: Map<String, JsonObject> = emptyMap(),
    val categories: Map<String, Category> = emptyMap(),
    val tags: List<String> = emptyList(),
    val server: JsonObject = JsonObject(emptyMap()),
) {
    fun merge(update: JsonObject): MainData {
        val full = (update["full_update"] as? JsonPrimitive)?.booleanOrNull == true
        val rid = (update["rid"] as? JsonPrimitive)?.longOrNull ?: rid

        val torrents = if (full) LinkedHashMap() else LinkedHashMap(torrents)
        (update["torrents"] as? JsonObject)?.forEach { (hash, patch) ->
            val p = patch as? JsonObject ?: return@forEach
            torrents[hash] = if (full) p else (torrents[hash]?.let { patchObject(it, p) } ?: p)
        }
        update.strings("torrents_removed").forEach { torrents.remove(it) }

        val categories = if (full) LinkedHashMap() else LinkedHashMap(categories)
        (update["categories"] as? JsonObject)?.forEach { (name, patch) ->
            val p = patch as? JsonObject ?: return@forEach
            val old = categories[name]
            val c = runCatching { qbitJson.decodeFromJsonElement<Category>(p) }.getOrDefault(Category())
            categories[name] = Category(
                name = c.name.ifEmpty { old?.name ?: name },
                savePath = if ("savePath" in p) c.savePath else old?.savePath.orEmpty(),
            )
        }
        update.strings("categories_removed").forEach { categories.remove(it) }

        val tags = (if (full) LinkedHashSet() else LinkedHashSet(tags)).apply {
            addAll(update.strings("tags"))
            removeAll(update.strings("tags_removed").toSet())
        }.toList()

        val serverPatch = update["server_state"] as? JsonObject
        val server = when {
            serverPatch == null -> if (full) JsonObject(emptyMap()) else server
            full -> serverPatch
            else -> patchObject(server, serverPatch)
        }
        return MainData(rid, torrents, categories, tags, server)
    }

    fun torrentList(): List<Torrent> = torrents.map { (hash, o) ->
        runCatching { qbitJson.decodeFromJsonElement<Torrent>(integral(o)) }.getOrDefault(Torrent(name = hash)).copy(hash = hash)
    }

    fun serverState(): ServerState = runCatching { qbitJson.decodeFromJsonElement<ServerState>(integral(server)) }.getOrDefault(ServerState())
}

// Byte counts and speeds are integers in qBittorrent, but proxies, forks and mocks may send
// 1.5e9 or 6657199308.8; truncate those instead of failing the whole torrent.
internal fun integral(o: JsonObject): JsonObject {
    if (o.values.none { it is JsonPrimitive && !it.isString && it.content.any { c -> c == '.' || c == 'e' || c == 'E' } }) return o
    return JsonObject(
        o.mapValues { (k, v) ->
            if (k in FRACTIONAL || v !is JsonPrimitive || v.isString) v
            else v.content.toDoubleOrNull()?.takeIf { d -> v.content.any { it == '.' || it == 'e' || it == 'E' } }?.let { JsonPrimitive(it.toLong()) } ?: v
        },
    )
}

private val FRACTIONAL = setOf("progress", "ratio", "availability", "max_ratio", "popularity", "global_ratio")

private fun patchObject(base: JsonObject, patch: JsonObject): JsonObject = JsonObject(LinkedHashMap(base).apply { putAll(patch) })

private fun JsonObject.strings(key: String): List<String> =
    (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()
