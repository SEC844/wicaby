package com.wika.wicaby.core.iptv

import android.util.Log
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Vault
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromStream
import kotlinx.serialization.json.encodeToStream
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

// Client-side IPTV (no server): the user's sources (a name, an M3U playlist URL, an optional XMLTV guide URL), their
// parsed playlists and guides cached on disk and refreshed on demand and every 12 h, and IptvApi, which answers the
// Live TV screens' Emby-shaped calls from them. The source list is sealed by the Keystore Vault (its URLs may carry an
// Xtream password), and so is the playlist cache (its stream URLs carry the same). Logs name hosts only.

@Serializable
data class IptvSource(val id: String, val name: String, val url: String, val guide: String? = null)

class IptvError(val kind: Kind, cause: Throwable? = null) : IOException(kind.name, cause) {
    enum class Kind { BAD_URL, UNREACHABLE, EMPTY, TOO_LARGE }
}

@Serializable
private class PlaylistFile(val at: Long, val playlist: Playlist)

@Serializable
private class GuideFile(val at: Long, val programmes: Map<String, List<GuideProgramme>>)

// Favourites, Récentes and the Live TV display preferences of the IPTV "server" (no secrets: channel ids are hashes).
@Serializable
internal class IptvState(val favorites: List<String> = emptyList(), val played: Map<String, Long> = emptyMap(), val prefs: JsonObject? = null)

/** One channel of the merged lineup: [id] is "<source id>-<channel id>" (unique across sources, a valid item id). */
class IptvEntry(val id: String, val channel: IptvChannel, val source: String)

class IptvLineup(val entries: List<IptvEntry>, val guide: Map<String, List<GuideProgramme>>) {
    val byId: Map<String, IptvEntry> = entries.associateBy { it.id }
}

private class Loaded(val playlist: Playlist, val at: Long, val guide: Map<String, List<GuideProgramme>>? = null, val guideAt: Long = 0)

@OptIn(ExperimentalSerializationApi::class)
object Iptv {
    const val SERVER_ID = "iptv"
    const val KIND = "iptv"
    private const val TAG = "WicabyIptv"
    const val REFRESH_MS = 12 * 3_600_000L
    private const val BEFORE_MS = 6 * 3_600_000L
    private const val AFTER_MS = 7 * 86_400_000L

    // shortcut: a TV heap holds about this many programmes (titles and descriptions); desktop keeps MAX_PROGRAMMES.
    // Raise it if guides get cut on big lineups and the TVs have the memory.
    private const val GUIDE_MAX = 150_000

    private val jsonOut = Json {
        explicitNulls = false
        ignoreUnknownKeys = true
    }

    private val _sources = MutableStateFlow<List<IptvSource>>(emptyList())
    private val _changes = MutableStateFlow(0)
    private val loaded = ConcurrentHashMap<String, Loaded>()
    private val locks = ConcurrentHashMap<String, Mutex>()
    private val guideLocks = ConcurrentHashMap<String, Mutex>()
    private val refreshing: MutableSet<String> = ConcurrentHashMap.newKeySet()

    @Volatile
    private var started = false

    @Volatile
    private var lineup: Pair<Int, IptvLineup>? = null

    @Volatile
    private var state = IptvState()

    /** The sources, in the order they were added. */
    val sources: StateFlow<List<IptvSource>>
        get() {
            start()
            return _sources.asStateFlow()
        }

    /** Bumped when a playlist or a guide changed: the screens reload their channels and revalidate the guide. */
    val changes: StateFlow<Int> get() = _changes.asStateFlow()

    val api: IptvApi by lazy { IptvApi() }

    /** The IPTV "server" for its id (Servers.of): playback and the player's Live TV overlay find it there. */
    fun api(serverId: String?): IptvApi? = if (serverId == SERVER_ID) api else null

    private val dir get() = File(Core.app.filesDir, "iptv")
    private fun cache(id: String) = File(Core.app.cacheDir, "iptv/$id")
    private val sourcesFile get() = File(dir, "sources.sealed")
    private val stateFile get() = File(dir, "state.json")

    private val client: OkHttpClient by lazy {
        Core.http.newBuilder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    }

    @Synchronized
    private fun start() {
        if (started) return
        started = true
        // A file the Keystore no longer opens (key reset) drops the sources, like a server token.
        _sources.value = runCatching {
            sourcesFile.takeIf { it.isFile }?.readText()?.let(Vault::decrypt)?.let { jsonOut.decodeFromString(ListSerializer(IptvSource.serializer()), it) }
        }.getOrNull().orEmpty()
        state = runCatching { stateFile.takeIf { it.isFile }?.inputStream()?.use { jsonOut.decodeFromStream(IptvState.serializer(), it) } }.getOrNull() ?: IptvState()
        Core.scope.launch {
            while (true) {
                delay(3_600_000L)
                for (s in _sources.value) runCatching { refreshIfStale(s) }
            }
        }
    }

    private fun bump() {
        _changes.update { it + 1 }
    }

    private fun saveSources(list: List<IptvSource>) {
        dir.mkdirs()
        writeAtomic(sourcesFile) { it.write(Vault.encrypt(jsonOut.encodeToString(ListSerializer(IptvSource.serializer()), list)).toByteArray()) }
        _sources.value = list
    }

    private fun writeAtomic(f: File, write: (java.io.OutputStream) -> Unit) {
        f.parentFile?.mkdirs()
        val tmp = File(f.parentFile, f.name + ".tmp")
        tmp.outputStream().buffered().use(write)
        if (!tmp.renameTo(f)) {
            f.delete()
            tmp.renameTo(f)
        }
    }

    // ---- Sources ----

    /** Adds a source after its playlist loaded (the guide follows in the background). Throws IptvError. */
    suspend fun add(name: String, url: String, guide: String?): IptvSource {
        start()
        val u = url.trim()
        val g = guide?.trim()?.ifEmpty { null }
        if (!isWebUrl(u) || (g != null && !isWebUrl(g))) throw IptvError(IptvError.Kind.BAD_URL)
        val src = IptvSource(UUID.randomUUID().toString().replace("-", "").take(8), name.trim().ifEmpty { hostOf(u) }.take(80), u, g)
        val p = fetchPlaylist(src)
        if (p.channels.isEmpty()) throw IptvError(IptvError.Kind.EMPTY)
        store(src, p)
        saveSources(_sources.value + src)
        bump()
        // Marked as refreshing: the screens' first calls must not start a second guide download.
        refreshing.add(src.id)
        Core.scope.launch {
            try {
                refreshGuide(src)
            } finally {
                refreshing.remove(src.id)
            }
        }
        return src
    }

    suspend fun remove(id: String) {
        start()
        saveSources(_sources.value.filterNot { it.id == id })
        loaded.remove(id)
        cache(id).deleteRecursively()
        val prefix = "$id-"
        updateState { s -> IptvState(s.favorites.filterNot { it.startsWith(prefix) }, s.played.filterKeys { !it.startsWith(prefix) }, s.prefs) }
        bump()
    }

    /** Playlist and guide of every source again, now. Failures keep what was cached; true when all answered. */
    suspend fun refreshAll(): Boolean {
        var ok = true
        for (s in _sources.value) {
            try {
                store(s, fetchPlaylist(s))
                bump()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                ok = false
            }
            refreshGuide(s)
        }
        return ok
    }

    fun channelCount(id: String): Int? = loaded[id]?.playlist?.channels?.size

    fun updatedAt(id: String): Long? = loaded[id]?.at

    // ---- Data ----

    /** Every source's playlist in memory (disk cache, else the network); stale ones refresh in the background. */
    internal suspend fun ensure() {
        start()
        var failed: Exception? = null
        var any = false
        for (s in _sources.value) {
            try {
                val l = load(s)
                any = true
                val now = System.currentTimeMillis()
                if ((now - l.at > REFRESH_MS || l.guide == null || now - l.guideAt > REFRESH_MS) && refreshing.add(s.id)) {
                    Core.scope.launch {
                        try {
                            refreshIfStale(s)
                        } finally {
                            refreshing.remove(s.id)
                        }
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failed = e
            }
        }
        if (!any && failed != null) throw failed
    }

    private suspend fun load(s: IptvSource): Loaded = lock(s.id).withLock {
        loaded[s.id]?.let { return@withLock it }
        val p = runCatching {
            File(cache(s.id), "playlist.sealed").takeIf { it.isFile }?.readText()?.let(Vault::decrypt)?.let { jsonOut.decodeFromString(PlaylistFile.serializer(), it) }
        }.getOrNull()
        val g = runCatching { File(cache(s.id), "guide.json").takeIf { it.isFile }?.inputStream()?.buffered()?.use { jsonOut.decodeFromStream(GuideFile.serializer(), it) } }.getOrNull()
        val l = if (p != null) Loaded(p.playlist, p.at, g?.programmes, g?.at ?: 0) else Loaded(fetchPlaylist(s), System.currentTimeMillis()).also { writePlaylist(s.id, it.playlist, it.at) }
        loaded[s.id] = l
        // A lineup built before this source loaded (a logo asked early) is stale.
        lineup = null
        l
    }

    private suspend fun refreshIfStale(s: IptvSource) {
        val l = loaded[s.id] ?: return
        val now = System.currentTimeMillis()
        if (now - l.at > REFRESH_MS) {
            try {
                store(s, fetchPlaylist(s))
                bump()
            } catch (e: IOException) {
                // the cached lineup stays
            }
        }
        val g = loaded[s.id]
        if (g != null && (g.guide == null || now - g.guideAt > REFRESH_MS)) refreshGuide(s)
    }

    private suspend fun store(s: IptvSource, p: Playlist) = lock(s.id).withLock {
        val at = System.currentTimeMillis()
        val old = loaded[s.id]
        loaded[s.id] = Loaded(p, at, old?.guide, old?.guideAt ?: 0)
        writePlaylist(s.id, p, at)
    }

    private fun writePlaylist(id: String, p: Playlist, at: Long) = runCatching {
        writeAtomic(File(cache(id), "playlist.sealed")) { it.write(Vault.encrypt(jsonOut.encodeToString(PlaylistFile.serializer(), PlaylistFile(at, p))).toByteArray()) }
    }

    private suspend fun fetchPlaylist(s: IptvSource): Playlist {
        val t0 = System.currentTimeMillis()
        val p = try {
            iptvGet(client.newBuilder().callTimeout(2, TimeUnit.MINUTES).build(), s.url, ::readPlaylist)
        } catch (e: IptvTooLarge) {
            throw IptvError(IptvError.Kind.TOO_LARGE, e)
        } catch (e: IOException) {
            log("playlist ${hostOf(s.url)}: ${e.javaClass.simpleName}")
            throw IptvError(IptvError.Kind.UNREACHABLE, e)
        }
        log("playlist ${hostOf(s.url)}: ${p.channels.size} channels, ${p.skipped} skipped, ${System.currentTimeMillis() - t0} ms")
        return p
    }

    // The source's guide URL, else the playlist's url-tvg; the first that answers wins.
    // shortcut: a playlist naming several complementary guides gets only the first that loads; merge them if one shows up.
    private suspend fun refreshGuide(s: IptvSource) = (guideLocks.getOrPut(s.id) { Mutex() }).withLock {
        val l = loaded[s.id] ?: return@withLock
        val urls = (listOfNotNull(s.guide) + l.playlist.guides).distinct()
        for (u in urls) {
            val now = System.currentTimeMillis()
            val c = collectGuide(l.playlist.channels, now - BEFORE_MS, now + AFTER_MS, GUIDE_MAX)
            try {
                iptvGet(client.newBuilder().callTimeout(15, TimeUnit.MINUTES).build(), u) { feedGuide(it, c.parser) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                log("guide ${hostOf(u)}: ${e.javaClass.simpleName}")
                continue
            }
            val g = c.finish()
            log("guide ${hostOf(u)}: ${c.parser.channels} channels, ${c.count()} programmes kept of ${c.parser.programmes}, ${c.parser.skipped} skipped, ${System.currentTimeMillis() - now} ms")
            lock(s.id).withLock {
                val cur = loaded[s.id] ?: return@withLock
                loaded[s.id] = Loaded(cur.playlist, cur.at, g, now)
            }
            runCatching { writeAtomic(File(cache(s.id), "guide.json")) { jsonOut.encodeToStream(GuideFile.serializer(), GuideFile(now, g), it) } }
            bump()
            return@withLock
        }
        // Nothing answered: an empty guide (rows say so) until the next refresh, not a fetch on every open.
        lock(s.id).withLock { loaded[s.id]?.let { cur -> if (cur.guide == null) loaded[s.id] = Loaded(cur.playlist, cur.at, emptyMap(), System.currentTimeMillis()) } }
    }

    private fun lock(id: String) = locks.getOrPut(id) { Mutex() }

    /** The merged lineup of every loaded source, rebuilt when something changed. */
    fun lineup(): IptvLineup {
        val v = _changes.value
        lineup?.takeIf { it.first == v }?.let { return it.second }
        val entries = ArrayList<IptvEntry>()
        val guide = HashMap<String, List<GuideProgramme>>()
        for (s in _sources.value) {
            val l = loaded[s.id] ?: continue
            for (c in l.playlist.channels) entries += IptvEntry("${s.id}-${c.id}", c, s.id)
            l.guide?.forEach { (id, list) -> guide["${s.id}-$id"] = list }
        }
        return IptvLineup(entries, guide).also { lineup = v to it }
    }

    // ---- Favourites, Récentes, display preferences ----

    internal val current: IptvState get() = state

    @Synchronized
    internal fun updateState(f: (IptvState) -> IptvState) {
        state = f(state)
        runCatching { writeAtomic(stateFile) { jsonOut.encodeToStream(IptvState.serializer(), state, it) } }
    }

    private fun log(msg: String) {
        runCatching { Log.i(TAG, msg) }
    }
}

/**
 * EXTVLCOPT http-user-agent / http-referrer of the channel being played, sent to its stream's host (playlist and
 * segments). A network interceptor on Core.http, so it applies to ExoPlayer's data source and to nothing on other hosts.
 */
object IptvHeaders : Interceptor {
    @Volatile
    private var byHost: Map<String, Pair<String?, String?>> = emptyMap()

    fun use(url: String, userAgent: String?, referrer: String?) {
        val host = hostOf(url).lowercase()
        byHost = if (userAgent == null && referrer == null) byHost - host else byHost + (host to (userAgent to referrer))
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val h = byHost[req.url.host.lowercase()] ?: return chain.proceed(req)
        val b = req.newBuilder()
        h.first?.let { b.header("User-Agent", it) }
        h.second?.let { b.header("Referer", it) }
        return chain.proceed(b.build())
    }
}
