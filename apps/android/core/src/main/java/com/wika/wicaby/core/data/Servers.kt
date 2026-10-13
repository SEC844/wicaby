package com.wika.wicaby.core.data

import com.wika.wicaby.core.Core
import com.wika.wicaby.core.livetv.parseServerDate
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap

// TP-06: several servers at once, as on the desktop (renderer/lib/items.ts, api.ts fanOut).
// Core.api stays the primary server (socket, remote control, launcher rows); [extra] are the other
// signed-in ones. With no extra server every helper here hands back exactly what the primary gives.
object Servers {
    @Volatile
    var extra: List<Api> = emptyList()

    val all: List<Api> get() = listOfNotNull(Core.api) + extra.filter { it.server.id != Core.api?.server?.id }

    // desktop onlineSessions(): what the merged views query. An extra server that stops answering drops out
    // (connection-manager reportFailure, status 'offline'); the primary always stays, as alone on the desktop.
    val online: List<Api> get() = all.filter { it === Core.api || it.server.id !in offline }

    // desktop multiServer(): merged views then name each card's server.
    val multi: Boolean get() = online.size > 1

    private val offline: MutableSet<String> = Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())

    // Bumped when an offline server answers again: the merged views on show reload with it (desktop: its views
    // re-run on onlineSessions()).
    private val _back = MutableStateFlow(0)
    val back: StateFlow<Int> = _back

    fun isOffline(serverId: String): Boolean = serverId in offline

    // An extra server's part of a merged load waits this long at most (desktop reportFailure probes for 4 s).
    internal var extraTimeoutMs = 5_000L
    internal var retryMs = 30_000L

    // A file source (core/files) is found by its id too, though it is never one of the merged servers.
    fun of(serverId: String?): Api? = all.firstOrNull { it.server.id == serverId } ?: com.wika.wicaby.core.files.FileSources.api(serverId)

    // Only an extra server: a primary item (or an unknown ServerId) keeps today's routes and intents.
    fun extraOf(serverId: String?): Api? = of(serverId)?.takeIf { it !== Core.api }

    fun forItem(item: Item, fallback: Api): Api = of(item.serverId) ?: fallback

    // The same query on every server in parallel, merged. Alone, the primary's answer (and its error) as is;
    // with several, a server that fails only leaves its part out.
    suspend fun merged(primary: Api, byDate: Boolean = false, fn: suspend (Api) -> List<Item>): List<Item> {
        val others = online.filter { it.server.id != primary.server.id }
        if (others.isEmpty()) return fn(primary)
        return merge(fanOut(listOf(primary) + others, fn), byDate)
    }

    // One list per server, each item tagged with its server (null when that server failed or is offline).
    suspend fun fanOut(apis: List<Api>, fn: suspend (Api) -> List<Item>): List<List<Item>?> =
        each(apis) { a -> fn(a).map { if (it.serverId == null) it.copy(serverId = a.server.id) else it } }

    // [fn] on every server in parallel, null where it failed. An extra server that is offline is skipped; one
    // that does not answer within [extraTimeoutMs] (or not at all) is left out and goes offline until it answers.
    suspend fun <T : Any> each(apis: List<Api>, fn: suspend (Api) -> T): List<T?> = coroutineScope {
        apis.map { a ->
            async {
                val extra = a !== Core.api
                if (extra && a.server.id in offline) return@async null
                try {
                    if (!extra) return@async fn(a)
                    // Detached: a blocking OkHttp call ignores cancellation, so only the wait is bounded.
                    val call = Core.scope.async { fn(a) }
                    try {
                        withTimeoutOrNull(extraTimeoutMs) { call.await() } ?: null.also { goOffline(a) }
                    } finally {
                        call.cancel()
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ApiException) {
                    null
                } catch (e: IOException) {
                    if (extra) goOffline(a)
                    null
                } catch (e: Exception) {
                    null
                }
            }
        }.awaitAll()
    }

    // desktop: the server's socket reconnecting brings it back. Here a probe, at once (a slow answer is not
    // a dead server) then every [retryMs] while it is still an extra server.
    private fun goOffline(a: Api) {
        val id = a.server.id
        if (!offline.add(id)) return
        Core.scope.launch {
            while (true) {
                val gone = extra.none { it.server.id == id }
                if (gone || runCatching { a.stream("GET", "/System/Info/Public", null, emptyList(), 4_000) {} }.isSuccess) break
                delay(retryMs)
            }
            offline.remove(id)
            if (extra.any { it.server.id == id }) _back.value++
        }
    }

    // The same film or series on the other servers (desktop Item.svelte findCopies): searched by name,
    // kept when a provider id matches, one copy per server. [item] first; empty when it is on one server only.
    suspend fun copies(item: Item, current: Api): List<Item> {
        val others = online.filter { it.server.id != current.server.id }
        if (others.isEmpty() || (item.type != "Movie" && item.type != "Series") || providerKeys(item).isEmpty()) return emptyList()
        val found = fanOut(others) { a ->
            a.items("SearchTerm" to item.name, "Recursive" to true, "IncludeItemTypes" to item.type, "Limit" to 20).items.filter { sameTitle(it, item) }.take(1)
        }.mapNotNull { it?.firstOrNull() }
        return if (found.isEmpty()) emptyList() else listOf(item.copy(serverId = item.serverId ?: current.server.id)) + found
    }

    // ---- Pure part (MultiServerTest, and tools/checks/fixtures/servers.json shared with the desktop).

    // Emby and Jellyfin ids collide across servers: keys use the server too.
    fun key(item: Item) = "${item.serverId.orEmpty()}:${item.id}"

    // desktop api.ts libraryRef: a library in home row ids, its plain id on the primary (what single-server
    // settings saved), `<serverId>/<id>` on another server.
    fun libraryRef(lib: Item, primary: String? = Core.api?.server?.id): String =
        if (lib.serverId == null || lib.serverId == primary) lib.id else "${lib.serverId}/${lib.id}"

    // desktop Home.svelte upcoming: merged rows sorted by air date again (each server sorts only its own).
    fun byAirDate(items: List<Item>): List<Item> = items.sortedBy { parseServerDate(it.premiereDate) ?: 0L }

    private val PROVIDERS = Regex("^(imdb|tmdb|tvdb)$", RegexOption.IGNORE_CASE)

    fun providerKeys(item: Item): List<String> =
        item.providerIds.filter { (k, v) -> !v.isNullOrEmpty() && PROVIDERS.matches(k) }.map { (k, v) -> "${item.type}:${k.lowercase()}:$v" }

    fun sameTitle(a: Item, b: Item): Boolean {
        val keys = providerKeys(a).toSet()
        return providerKeys(b).any { it in keys }
    }

    // Keeps the first copy of a title found on several servers (same-server duplicates stay).
    fun dedupe(items: List<Item>): List<Item> {
        val owner = HashMap<String, String?>()
        return items.filter { it ->
            val keys = providerKeys(it)
            if (keys.any { k -> owner.containsKey(k) && owner[k] != it.serverId }) return@filter false
            keys.forEach { k -> owner[k] = it.serverId }
            true
        }
    }

    // One list per server into one: interleaved so no server buries the others, then (byDate) most
    // recently played first, then duplicates dropped.
    fun merge(lists: List<List<Item>?>, byDate: Boolean = false): List<Item> {
        val out = ArrayList<Item>()
        val longest = lists.maxOfOrNull { it?.size ?: 0 } ?: 0
        for (i in 0 until longest) for (l in lists) l?.getOrNull(i)?.let(out::add)
        // Stable, as Array.prototype.sort: undated items keep their interleaved order at the end.
        val sorted = if (byDate) out.sortedByDescending { parseServerDate(it.userData?.lastPlayedDate?.takeIf(String::isNotEmpty)) ?: 0L } else out
        return dedupe(sorted)
    }
}
