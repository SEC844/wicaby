package com.wika.wicaby.core.plex

import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.Vault
import com.wika.wicaby.core.files.SourceStore
import com.wika.wicaby.core.net.LocalNetwork
import com.wika.wicaby.core.net.origin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

// One Plex server as plex.tv lists it for a linked account (plex-spec §5.2). Non-secret: tokens live sealed apart.
@Serializable
data class PlexServer(
    val id: String,
    val name: String = "",
    val account: String = "",
    val owned: Boolean = false,
    // "Shared by …" (D-10), null for the account's own servers.
    val source: String? = null,
    val httpsRequired: Boolean = false,
    val connections: List<PlexConnection> = emptyList(),
    // Where it answered last (first of its wave next time).
    val lastGood: String? = null,
    // D-3: plain-http LAN origins the user agreed to send the token to.
    val confirmed: List<String> = emptyList(),
    // D-10: shown by default; a hidden one stays stored and leaves the merged views.
    val hidden: Boolean = false,
)

// A linked plex.tv account: its name, Plex Pass, subtitle defaults (§6.4). [token] and [users] (Home user uuid →
// that user's plex.tv token) are sealed by the store's seal (the Android Keystore in the app).
@Serializable
data class PlexAccount(
    val id: String,
    val name: String = "",
    val pass: Boolean = false,
    val subtitles: JsonObject? = null,
    val token: String = "",
    val users: Map<String, String> = emptyMap(),
    // The Home users as last read (offline fallback for the picker).
    val home: List<PlexHomeUser> = emptyList(),
) {
    override fun toString() = "PlexAccount(id=$id, name=$name, pass=$pass, users=${users.keys})"
}

// filesDir/plex/plex.json: accounts (tokens sealed) and the servers they list, cached so startup never waits on
// plex.tv (#103).
class PlexStore(private val dir: File, private val seal: (String) -> String, private val open: (String) -> String?) {
    @Serializable
    private data class Stored(val accounts: List<PlexAccount> = emptyList(), val servers: List<PlexServer> = emptyList())

    private val file get() = File(dir, "plex.json")

    @Synchronized
    private fun read(): Stored = runCatching { plexJson.decodeFromString(Stored.serializer(), file.readText()) }.getOrDefault(Stored())

    @Synchronized
    private fun write(s: Stored) = SourceStore.writeAtomic(file, plexJson.encodeToString(Stored.serializer(), s))

    fun accounts(): List<PlexAccount> = read().accounts

    fun servers(): List<PlexServer> = read().servers

    fun server(id: String): PlexServer? = servers().firstOrNull { it.id == id }

    fun account(id: String): PlexAccount? = accounts().firstOrNull { it.id == id }

    // The account's own token, opened; null when missing or no longer opening (Keystore reset: link again).
    fun accountToken(id: String): String? = account(id)?.token?.let(open)

    fun userToken(account: String, user: String): String? = account(account)?.users?.get(user)?.let(open)

    @Synchronized
    fun putAccount(a: PlexAccount, token: String?) = write(read().let { s ->
        val old = s.accounts.firstOrNull { it.id == a.id }
        val next = a.copy(token = token?.let(seal) ?: old?.token.orEmpty(), users = old?.users.orEmpty() + a.users)
        s.copy(accounts = s.accounts.filter { it.id != a.id } + next)
    })

    @Synchronized
    fun putUserToken(account: String, user: String, token: String) = write(read().let { s ->
        s.copy(accounts = s.accounts.map { if (it.id == account) it.copy(users = it.users + (user to seal(token))) else it })
    })

    @Synchronized
    fun updateServer(id: String, f: (PlexServer) -> PlexServer) = write(read().let { s -> s.copy(servers = s.servers.map { if (it.id == id) f(it) else it }) })

    // What plex.tv lists for [account]: one server per resource, its connections refreshed, the user's choices kept.
    @Synchronized
    fun putResources(account: String, resources: List<PlexResource>) = write(read().let { s ->
        val next = resources.map { r ->
            val old = s.servers.firstOrNull { it.id == r.clientIdentifier }
            PlexServer(
                r.clientIdentifier, r.name.ifEmpty { old?.name.orEmpty() }, account, r.owned, r.sourceTitle, r.httpsRequired,
                r.connections.filter { c -> c.uri.startsWith("http://", true) || c.uri.startsWith("https://", true) }.take(24),
                old?.lastGood, old?.confirmed.orEmpty(), old?.hidden ?: false,
            )
        }
        s.copy(servers = s.servers.filterNot { o -> next.any { it.id == o.id } } + next)
    })

    @Synchronized
    fun removeAccount(id: String) = write(read().let { s -> s.copy(accounts = s.accounts.filter { it.id != id }, servers = s.servers.filter { it.account != id }) })
}

// The Plex sign-in flow and connection choice for the apps (plex-spec §5), the Android twin of the desktop's
// ConnectionManager plex* methods: link with a code (no password form, no WebView), Home users with their PIN, one
// session per server, the connection race, D-3 and D-10. The account and Home user tokens go only to plex.tv; each
// server gets its own accessToken, bound to the addresses plex.tv vouched for over TLS.
class PlexAccounts(
    val store: PlexStore,
    val tv: PlexTv,
    private val http: OkHttpClient,
    private val subnets: () -> List<String>? = { PlexConnections.localSubnets() },
    private val now: () -> Long = System::currentTimeMillis,
) {
    data class Link(val code: String, val url: String, val expiresInS: Int)

    sealed interface Poll {
        data object Waiting : Poll
        data object Expired : Poll
        // Linked: who may watch ([users]: pick one, a protected one with its PIN), or, alone in the Home, signed in.
        data class Linked(val account: String, val users: List<PlexHomeUser>, val signedIn: List<SignIn>) : Poll
    }

    // One server signed in as one Home user: the apps store it as any Session (Prefs, the token sealed by Vault).
    data class SignIn(val server: Server, val token: String, val userId: String, val userName: String, val owned: Boolean, val relay: Boolean, val confirm: String?) {
        override fun toString() = "SignIn(server=$server, userId=$userId, userName=$userName, token=<redacted>, confirm=$confirm)"
    }

    private class PinState(val id: Long, val at: Long, val ttlMs: Long, var nextPoll: Long = 0, var backoff: Long = 2000)

    @Volatile
    private var pin: PinState? = null

    private fun text(id: Int, fallback: String) = runCatching { Core.str(id) }.getOrDefault(fallback)

    // Link with a code: a PIN the user enters at plex.tv/link (shown as text and as a QR code of [Link.url]).
    suspend fun link(): Link {
        val p = tv.createPin()
        if (p.id == 0L || p.code.isEmpty()) throw IOException(text(R.string.server_unreachable_probe, "plex.tv unreachable"))
        val ttl = maxOf(60, p.expiresIn ?: 900)
        pin = PinState(p.id, now(), ttl * 1000L)
        return Link(p.code, PlexTv.linkUrl(p.code), ttl)
    }

    // Every 2 s from the link screen: Waiting until the code is entered, Expired after its TTL; 429 backs off.
    suspend fun poll(): Poll {
        val p = pin
        if (p == null || now() - p.at > p.ttlMs) {
            pin = null
            return Poll.Expired
        }
        if (now() < p.nextPoll) return Poll.Waiting
        val answer = try {
            tv.pin(p.id)
        } catch (e: IOException) {
            p.backoff = minOf(if ((e as? ApiException)?.status == 429) p.backoff * 2 else p.backoff, 30_000)
            p.nextPoll = now() + p.backoff
            return Poll.Waiting
        }
        if (answer == null) {
            pin = null
            return Poll.Expired
        }
        val token = answer.authToken?.takeIf { it.isNotEmpty() } ?: return Poll.Waiting
        if (pin !== p) return Poll.Waiting
        pin = null
        return linked(token)
    }

    private suspend fun linked(token: String): Poll.Linked {
        val me = tv.user(token)
        if (!ACCOUNT_ID.matches(me.uuid)) throw ApiException(text(R.string.plex_error_relink, "link the Plex account again"), 401)
        val name = me.title?.takeIf { it.isNotEmpty() } ?: me.username?.takeIf { it.isNotEmpty() } ?: "Plex"
        val home = runCatching { tv.homeUsers(token) }.getOrDefault(emptyList())
        val pass = (me.subscription?.get("active")).isTrue()
        store.putAccount(PlexAccount(me.uuid, name, pass, me.profile?.let(PlexMap::accountSubtitles), home = home), token)
        val resources = tv.servers(token)
        if (resources.isEmpty()) throw ApiException(text(R.string.plex_link_no_servers, "no Plex server"), 404)
        store.putResources(me.uuid, resources)
        // Nobody else in the Home: no one to pick, the account is who is watching.
        val alone = home.size <= 1 && home.none { it.protected }
        val signedIn = if (alone) sessions(me.uuid, me.uuid, name, resources) else emptyList()
        return Poll.Linked(me.uuid, if (alone) emptyList() else home, signedIn)
    }

    // Who is watching (§5.5): the Home users, protected ones with a PIN; the last list when plex.tv is down.
    suspend fun users(account: String): List<PlexHomeUser> {
        val a = store.account(account) ?: throw ApiException(text(R.string.plex_error_relink, "link the Plex account again"), 401)
        val token = store.accountToken(account) ?: throw ApiException(text(R.string.plex_error_relink, "link the Plex account again"), 401)
        val home = runCatching { tv.homeUsers(token) }.getOrNull()?.also { store.putAccount(a.copy(home = it, users = emptyMap()), null) } ?: a.home
        return home.ifEmpty { listOf(PlexHomeUser(uuid = a.id, title = a.name)) }
    }

    // Signs a Home user in: their plex.tv token (the switch, with their PIN when protected), then their own token for
    // every server of the account. A protected user is never picked without the PIN; a wrong one is plex_error_wrong_pin.
    // A user token that a PIN change upstream made stale (401) is switched again (#553).
    suspend fun signIn(account: String, user: String, pin: String? = null): List<SignIn> {
        val a = store.account(account) ?: throw ApiException(text(R.string.plex_error_relink, "link the Plex account again"), 401)
        val accountToken = store.accountToken(account) ?: throw ApiException(text(R.string.plex_error_relink, "link the Plex account again"), 401)
        val home = a.home.ifEmpty { runCatching { tv.homeUsers(accountToken) }.getOrDefault(emptyList()) }
        val who = home.firstOrNull { it.uuid == user || it.title == user } ?: if (user == a.id || user == a.name) PlexHomeUser(uuid = a.id, title = a.name) else
            throw ApiException(text(R.string.plex_error_wrong_pin, "wrong PIN"), 401)
        val token = if (who.uuid == a.id && !who.protected) accountToken else {
            if (who.protected && pin.isNullOrEmpty()) throw ApiException(text(R.string.plex_error_wrong_pin, "wrong PIN"), 401)
            try {
                tv.switchUser(accountToken, who.uuid, pin)
            } catch (e: ApiException) {
                if (e.status == 401 || e.status == 403) throw ApiException(text(R.string.plex_error_wrong_pin, "wrong PIN"), 401)
                throw e
            }
        }
        store.putUserToken(account, who.uuid, token)
        val resources = tv.servers(token)
        store.putResources(account, resources)
        val out = sessions(account, who.uuid, who.title, resources)
        if (out.isEmpty()) throw ApiException(text(R.string.plex_error_no_access, "no access to this Plex server"), 403)
        return out
    }

    // One sign-in per listed server this user has a token for, at the address that answered (servers that do not
    // answer now keep their best-ranked address and join when they do).
    private suspend fun sessions(account: String, userId: String, userName: String, resources: List<PlexResource>): List<SignIn> =
        resources.mapNotNull { r ->
            val token = r.accessToken?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val s = store.server(r.clientIdentifier) ?: return@mapNotNull null
            val route = runCatching { connect(s.id, interactive = true) }.getOrNull() ?: fallback(s) ?: return@mapNotNull null
            SignIn(Server(s.id, s.name, route.address, "plex"), token, userId, userName, s.owned, route.relay, route.confirm)
        }

    data class Route(val address: String, val local: Boolean, val relay: Boolean, val confirm: String?)

    // A server that does not answer now: its best-ranked address, with the D-3 prompt when it is plain-http LAN.
    internal fun fallback(s: PlexServer): Route? {
        val address = rank(s).waves.flatten().firstOrNull() ?: return null
        return Route(address, false, false, needsConfirm(s, address))
    }

    // Where this server's token may go (desktop plexOrigins): an origin plex.tv vouched for (https, or http on a
    // non-LAN address) or a plain-http LAN one the user confirmed (D-3).
    fun tokenAllowed(s: PlexServer, address: String): Boolean {
        val u = address.toHttpUrlOrNull() ?: return false
        val o = origin(u)
        return o in s.confirmed || s.connections.any { c -> c.uri.toHttpUrlOrNull()?.let { l -> origin(l) == o && (l.isHttps || !LocalNetwork.isLanAddress(l.host)) } == true }
    }

    private fun rank(s: PlexServer) = PlexConnections.rankConnections(s.connections, s.httpsRequired, subnets(), s.lastGood)

    // A plain-http LAN connection plex.tv listed: the token goes there only once the user agreed (D-3).
    fun needsConfirm(s: PlexServer, address: String): String? {
        val u = address.toHttpUrlOrNull() ?: return null
        val o = origin(u)
        return o.takeIf { !u.isHttps && LocalNetwork.isLanAddress(u.host) && s.connections.any { c -> c.uri.toHttpUrlOrNull()?.let(::origin) == o } && o !in s.confirmed }
    }

    // The connections plex.tv listed, ranked and raced (§5.3); the winner must answer /identity with this server's
    // machineIdentifier and becomes lastGood. [interactive] false (a background re-pick): an unconfirmed plain-http LAN
    // address is not a candidate, so no token goes there without the user (D-3).
    suspend fun connect(serverId: String, interactive: Boolean = false): Route {
        val s = store.server(serverId) ?: throw IOException(text(R.string.server_unreachable_probe, "unknown Plex server"))
        val ranked = rank(s)
        val waves = if (interactive) ranked.waves else ranked.waves.map { w -> w.filter { needsConfirm(s, it) == null } }
        if (waves.all { it.isEmpty() }) {
            throw IOException(
                if (ranked.dropped.any { it.why == "http-refused" }) text(R.string.plex_error_secure_required, "secure connection required")
                else text(R.string.server_unreachable_probe, "unreachable"),
            )
        }
        val (uri, _) = try {
            PlexConnections.raceWaves(waves) { identity(it, serverId) }
        } catch (_: IOException) {
            throw IOException(text(R.string.server_unreachable_probe, "unreachable"))
        }
        store.updateServer(serverId) { it.copy(lastGood = uri) }
        val c = s.connections.firstOrNull { it.uri == uri }
        return Route(uri, c?.local ?: false, c?.relay ?: false, needsConfirm(s, uri))
    }

    // D-3: the user agrees to send the token to this plain-http LAN address of the server, from now on.
    fun confirm(serverId: String, address: String) {
        val s = store.server(serverId) ?: return
        val o = needsConfirm(s, address) ?: return
        store.updateServer(serverId) { it.copy(confirmed = (it.confirmed + o).distinct()) }
    }

    // D-10: shared servers show by default; a hidden one stays stored.
    fun setHidden(serverId: String, hidden: Boolean) = store.updateServer(serverId) { it.copy(hidden = hidden) }

    fun servers(account: String? = null): List<PlexServer> = store.servers().filter { account == null || it.account == account }

    // Background: the account's connections again (addresses change); the cache stays when plex.tv is down.
    suspend fun refresh(account: String) {
        val token = store.accountToken(account) ?: return
        runCatching { store.putResources(account, tv.servers(token)) }
    }

    // Forgets the account: its tokens, and the servers only it listed.
    fun unlink(account: String) = store.removeAccount(account)

    // The plex.tv watchlist of the Home user signed in to [serverId] (D-6), with that user's own token.
    fun watchlist(serverId: String, userId: String?): PlexWatchlist? {
        val s = store.server(serverId) ?: return null
        val a = store.account(s.account) ?: return null
        val token = (if (userId == null || userId == a.id) store.accountToken(a.id) else store.userToken(a.id, userId)) ?: return null
        return object : PlexWatchlist {
            override suspend fun guids() = tv.watchlist(token)
            override suspend fun set(guid: String, on: Boolean) = tv.setWatchlisted(token, guid, on)
        }
    }

    // How [server]'s Api is built (Api.of): owner (D-2), remote (§6.2), the watchlist (D-6).
    fun options(server: Server, userId: String?, userName: String = ""): PlexApi.Options {
        val s = store.server(server.id)
        val c = s?.connections?.firstOrNull { it.uri.equals(server.address.trimEnd('/'), true) }
        val owner = s?.owned == true && (userId == null || userId == s.account)
        return PlexApi.Options(userName, owner, c != null && (!c.local || c.relay), watchlist(server.id, userId), unbound = s == null || !tokenAllowed(s, server.address))
    }

    // An unauthenticated /identity: the machineIdentifier proves which server answered (a token never goes to a probe).
    private suspend fun identity(uri: String, serverId: String): String = withContext(Dispatchers.IO) {
        val client = http.newBuilder().callTimeout(PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS).followRedirects(false).build()
        client.newCall(Request.Builder().url(uri.trimEnd('/') + "/identity").header("Accept", "application/json").build()).execute().use { r ->
            val id = if (r.isSuccessful) runCatching { plexJson.parseToJsonElement(r.body.string()) }.getOrNull().let { it["MediaContainer"] ?: it }["machineIdentifier"].str() else null
            if (id != serverId) throw IOException("another server answered")
            uri
        }
    }

    companion object {
        private val ACCOUNT_ID = Regex("^[0-9a-f]{8,40}$", RegexOption.IGNORE_CASE)
        const val PROBE_TIMEOUT_MS = 2_500L
    }
}

// The app's Plex state (Core.init): the store under filesDir with tokens sealed by the Android Keystore (Vault).
object Plex {
    @Volatile
    private var instance: PlexAccounts? = null

    val accounts: PlexAccounts
        get() = instance ?: synchronized(this) {
            instance ?: PlexAccounts(
                PlexStore(File(Core.app.filesDir, "plex"), Vault::encrypt, Vault::decrypt),
                // The same client id on every plex.tv call: plex.tv binds a PIN to the device that asked for it.
                PlexTv(Core.http) { PlexClient(Core.prefs.current().deviceId, Core.deviceName, Core.version) },
                Core.http,
            ).also { instance = it }
        }

    // Tests and previews: another store or plex.tv.
    fun use(a: PlexAccounts?) {
        instance = a
    }

    // Api.of() for a plex session.
    fun api(server: Server, deviceId: String, token: String?, userId: String?): PlexApi {
        val options = runCatching { accounts.options(server, userId) }.getOrDefault(PlexApi.Options(unbound = true))
        return PlexApi(server, deviceId, token, userId, options)
    }

    // AddressSwitch's re-pick for a plex server (a network change, a failed call): the race, no D-3 prompt.
    suspend fun pick(server: Server): String? = runCatching { accounts.connect(server.id).address }.getOrNull()
}
