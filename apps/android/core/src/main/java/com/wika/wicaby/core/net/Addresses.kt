package com.wika.wicaby.core.net

import android.content.Context
import android.os.SystemClock
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.json
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/** A server's other addresses (B09): learned from /System/Info/Public, or typed in Settings ([edited]). */
@Serializable
data class KnownAddresses(val local: String? = null, val remote: String? = null, val edited: Boolean = false)

// The anonymous answer an address gives: its server id and the addresses the server announces.
@Serializable
internal data class PublicInfo(val id: String = "", val localAddress: String? = null, val wanAddress: String? = null)

/** Tag on a request that must reach its own URL: AddressSwitch probes each address of a server as itself. */
object AsAddressed

// The base TransportInterceptor puts in front of a URL on [stored]: [alt]'s origin plus the path it adds before
// the stored one's ("https://h/jf" for "http://lan:8096" → "", for "http://lan:8096/jf" → "/jf"); null if none fits.
internal fun altBase(stored: HttpUrl, alt: HttpUrl): String? {
    val sp = stored.encodedPath.trimEnd('/')
    val ap = alt.encodedPath.trimEnd('/')
    if (!ap.endsWith(sp)) return null
    return origin(alt) + ap.removeSuffix(sp)
}

/**
 * What a pick races, the stored address first. An address that cannot stand in for it (altBase) is left out,
 * and so is a learned plain-HTTP one when the stored address is HTTPS: the token never leaves TLS unless the
 * user typed that address.
 */
internal fun candidates(address: String, known: KnownAddresses): List<String> {
    val stored = address.toHttpUrlOrNull() ?: return listOf(address)
    val alts = listOfNotNull(known.local, known.remote).mapNotNull { a ->
        val u = a.trim().trimEnd('/').toHttpUrlOrNull() ?: return@mapNotNull null
        if (!known.edited && stored.isHttps && !u.isHttps) return@mapNotNull null
        altBase(stored, u)?.let { a.trim().trimEnd('/') }
    }
    return (listOf(address.trimEnd('/')) + alts).distinctBy { it.lowercase() }
}

// The first of [list] whose answer names server [id] (a host answering for another server never counts); null when none.
internal suspend fun firstAnswering(list: List<String>, id: String, probe: suspend (String) -> PublicInfo?): Pair<String, PublicInfo>? =
    if (list.isEmpty()) null else coroutineScope {
        val result = CompletableDeferred<Pair<String, PublicInfo>?>()
        val jobs = list.map { a -> launch { runCatching { probe(a) }.getOrNull()?.takeIf { it.id == id }?.let { result.complete(a to it) } } }
        launch {
            jobs.joinAll()
            result.complete(null)
        }
        try {
            result.await()
        } finally {
            coroutineContext.cancelChildren()
        }
    }

// What a server announces, kept: an HTTPS remote address, or a plain-HTTP one on the LAN only (no token in clear
// on the internet). The user's own addresses are never overwritten.
internal fun learned(old: KnownAddresses, info: PublicInfo): KnownAddresses {
    if (old.edited) return old
    fun clean(a: String?) = a?.trim()?.trimEnd('/')?.takeIf { it.toHttpUrlOrNull() != null }
    val remote = clean(info.wanAddress)?.takeIf { r -> r.toHttpUrlOrNull()?.let { it.isHttps || LocalNetwork.isLanAddress(it.host) } == true }
    return KnownAddresses(clean(info.localAddress) ?: old.local, remote ?: old.remote)
}

/**
 * B09: LAN/WAN switching. Every URL keeps the server's stored address; this transport sends it to the address of
 * the same server that answered last ([repick]: at connect time, on a network change, after a connection failure).
 * The mesh ([inner]) still forwards whichever address is used when it is a mesh peer.
 */
class AddressSwitch(val inner: ServerTransport, private val servers: () -> List<Server>) : ServerTransport {
    // Stored origin → base of the other address in use. No entry: the stored address.
    private val chosen = ConcurrentHashMap<String, String>()
    private val inUse = ConcurrentHashMap<String, String>()
    private val picks = ConcurrentHashMap<String, Job>()
    private val lastPick = ConcurrentHashMap<String, Long>()

    override fun forward(origin: String): String? {
        val alt = chosen[origin] ?: return inner.forward(origin)
        val u = alt.toHttpUrlOrNull() ?: return inner.forward(origin)
        return inner.forward(origin(u))?.let { it.trimEnd('/') + u.encodedPath.trimEnd('/') } ?: alt
    }

    // A connection to a stored origin failed: pick again, at most every 15 s per server.
    override fun failed(origin: String) {
        val s = servers().firstOrNull { it.origin == origin } ?: return
        val last = lastPick[s.id] ?: 0L
        if (picks[s.id]?.isActive == true || SystemClock.elapsedRealtime() - last < 15_000) return
        repick(s)
    }

    // Requests to [origin] (server [id]'s stored one) go to [base] ([address]); null: to the stored address.
    internal fun use(id: String, origin: String, base: String?, address: String) {
        if (base == null) chosen.remove(origin) else chosen[origin] = base
        inUse[id] = address
    }

    /** The address [server]'s requests go to now (Settings). */
    fun inUse(server: Server): String = server.origin?.let { o -> chosen[o]?.let { inUse[server.id] } } ?: server.address

    fun known(id: String): KnownAddresses = runCatching {
        prefs()?.getString(id, null)?.let { json.decodeFromString(KnownAddresses.serializer(), it) }
    }.getOrNull() ?: KnownAddresses()

    private fun save(id: String, k: KnownAddresses) {
        prefs()?.edit()?.putString(id, json.encodeToString(KnownAddresses.serializer(), k))?.apply()
    }

    /** Settings: the user's local and remote addresses (blank: none). False when one is not an http(s) URL. */
    fun edit(server: Server, local: String, remote: String): Boolean {
        fun norm(a: String) = a.trim().trimEnd('/').ifEmpty { null }
        val l = norm(local)
        val r = norm(remote)
        if (listOfNotNull(l, r).any { a -> a.toHttpUrlOrNull() == null || !(a.startsWith("http://", true) || a.startsWith("https://", true)) }) return false
        // Both blank: back to what the server announces.
        save(server.id, if (l == null && r == null) KnownAddresses() else KnownAddresses(l, r, edited = true))
        repick(server)
        return true
    }

    /** Races the server's addresses and sends its requests to the first that answers as that server. */
    fun repick(server: Server): Job? {
        if (prefs() == null) return null
        picks[server.id]?.cancel()
        lastPick[server.id] = SystemClock.elapsedRealtime()
        return Core.scope.launch {
            val stored = server.address.toHttpUrlOrNull() ?: return@launch
            val origin = server.origin ?: return@launch
            // Plex: the connections plex.tv lists, ranked and raced (plex spec §5.3), not /System/Info/Public.
            if (server.kind == "plex") {
                val address = com.wika.wicaby.core.plex.Plex.pick(server) ?: return@launch
                val u = address.toHttpUrlOrNull()
                use(server.id, origin, u?.takeUnless { address.equals(server.address.trimEnd('/'), true) }?.let { altBase(stored, it) }, address)
                return@launch
            }
            val list = candidates(server.address, known(server.id))
            val (address, info) = firstAnswering(list, server.id) { probe(server, it) } ?: return@launch
            val u = address.toHttpUrlOrNull()
            val base = u?.takeUnless { address.equals(server.address.trimEnd('/'), true) }?.let { altBase(stored, it) }
            use(server.id, origin, base, address)
            val k = known(server.id)
            learned(k, info).takeIf { it != k }?.let { save(server.id, it) }
        }.also { picks[server.id] = it }
    }

    fun repickAll() = servers().forEach { repick(it) }

    private suspend fun probe(server: Server, address: String): PublicInfo? = withContext(Dispatchers.IO) {
        val req = Request.Builder().url("$address${if (server.isEmby) "/emby" else ""}/System/Info/Public")
            .header("Accept", "application/json").tag(AsAddressed::class.java, AsAddressed).build()
        client.newCall(req).execute().use { r -> if (r.isSuccessful) json.decodeFromString(PublicInfo.serializer(), r.body.string()) else null }
    }

    private val client by lazy { Core.http.newBuilder().callTimeout(6, TimeUnit.SECONDS).build() }

    // Unit tests have no Application: no store, no picks.
    private fun prefs() = runCatching { Core.app.getSharedPreferences("server_addresses", Context.MODE_PRIVATE) }.getOrNull()
}
