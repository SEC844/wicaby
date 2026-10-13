package com.wika.wicaby.core.trakt

import android.content.Context
import android.util.Log
import androidx.annotation.StringRes
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Vault
import com.wika.wicaby.core.data.json
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient

// Client-side Trakt scrobbling, as the desktop's src/main/features/trakt.ts: the user's own Trakt
// application (client id + secret), authorized with the device-code flow; start/pause/stop follow
// the playback reports (Playback.kt), and a watched mark set by hand goes to the Trakt history.
// A server that runs the Trakt plugin already scrobbles: it is skipped when detected (admins can
// read the plugin list) or when the user turned it off (offServers).

@Serializable
data class TraktSecrets(val secret: String, val access: String? = null, val refresh: String? = null, val expiresAt: Long = 0) {
    override fun toString() = "TraktSecrets(<redacted>)"
}

// user: the Trakt username, "" until authorized (or when Trakt did not say).
data class TraktAccount(val clientId: String, val user: String, val secrets: TraktSecrets)

// Where the account lives: DataTraktStore on a device, in memory in the unit tests.
interface TraktStore {
    suspend fun load(): TraktAccount?
    suspend fun save(a: TraktAccount?)
    suspend fun offServers(): Set<String>
    suspend fun setOffServers(ids: Set<String>)
}

data class TraktPending(val userCode: String, val url: String, val expiresAt: Long)

// Resolved by the UI, in its language.
data class TraktFailure(@StringRes val res: Int, val detail: String = "")

data class TraktState(
    // "" until the user enters their Trakt application's client id.
    val clientId: String = "",
    // Non-null once authorized ("" when Trakt did not give the username).
    val user: String? = null,
    val pending: TraktPending? = null,
    val error: TraktFailure? = null,
    // Servers whose plays are not scrobbled (the user's choice).
    val offServers: Set<String> = emptySet(),
)

private val CLIENT_RE = Regex("^[A-Za-z0-9_-]{8,128}$")
// A token this close to its expiry is refreshed before use.
private const val REFRESH_MARGIN_MS = 10 * 60_000L

class TraktService(
    private val store: TraktStore,
    private val scope: CoroutineScope,
    private val http: OkHttpClient = traktHttp,
    private val now: () -> Long = System::currentTimeMillis,
) {
    // Debug builds point it at tools/mock-server/mock-trakt.mjs (MainActivity, extra "trakt_url").
    @Volatile
    var base: String = TRAKT_API

    private val _state = MutableStateFlow(TraktState())
    val state: StateFlow<TraktState> = _state

    @Volatile private var pending: TraktPending? = null
    @Volatile private var error: TraktFailure? = null
    @Volatile private var poll: Job? = null
    private val plugins = HashMap<String, Boolean?>()

    // Calls run one after the other: start, pause and stop reach Trakt in order, and a refresh happens once.
    private val queue = Channel<suspend () -> Unit>(Channel.UNLIMITED).also { q ->
        scope.launch { for (job in q) runCatching { job() }.onFailure { Log.w(TAG, "call failed: ${it.message}") } }
    }

    private fun client(clientId: String) = TraktClient(base, clientId, http)

    suspend fun reload() {
        val a = store.load()
        _state.value = TraktState(a?.clientId.orEmpty(), a?.user?.takeIf { a.secrets.access != null }, pending, error, store.offServers())
    }

    suspend fun connect(clientId: String, clientSecret: String) {
        val id = clientId.trim()
        val prev = store.load()
        // An empty secret keeps the stored one for the same client id.
        val secret = clientSecret.trim().ifEmpty { if (prev?.clientId == id) prev.secrets.secret else "" }
        stopPolling()
        if (!CLIENT_RE.matches(id) || !CLIENT_RE.matches(secret)) return fail(R.string.trakt_error_invalid_client)
        error = null
        store.save(TraktAccount(id, "", TraktSecrets(secret)))
        val client = client(id)
        val code = try {
            client.deviceCode()
        } catch (e: Exception) {
            return fail(R.string.trakt_error_failed, e)
        }
        val expiresAt = now() + code.expiresIn * 1000
        val mine = TraktPending(code.userCode, code.verificationUrl, expiresAt)
        pending = mine
        reload()
        poll = scope.launch {
            var interval = code.interval.coerceAtLeast(1) * 1000
            while (true) {
                delay(interval)
                if (now() > expiresAt) return@launch fail(R.string.trakt_error_expired)
                val r = try {
                    client.pollToken(code.deviceCode, secret)
                } catch (e: Exception) {
                    ensureActive()
                    val status = (e as? TraktException)?.status
                    return@launch fail(if (status == 418) R.string.trakt_error_denied else if (status == 410) R.string.trakt_error_expired else R.string.trakt_error_failed, e)
                }
                when (r) {
                    Poll.Pending -> Unit
                    Poll.SlowDown -> interval += 1000
                    is Poll.Done -> {
                        val user = runCatching { client.username(r.tokens.accessToken) }.getOrDefault("")
                        ensureActive()
                        if (pending !== mine) return@launch
                        store.save(TraktAccount(id, user, secrets(secret, r.tokens)))
                        pending = null
                        poll = null
                        reload()
                        return@launch
                    }
                }
            }
        }
    }

    private suspend fun fail(@StringRes res: Int, e: Exception? = null) {
        pending = null
        poll = null
        error = TraktFailure(res, e?.message.orEmpty())
        Log.w(TAG, "authorization failed: ${e?.message ?: res}")
        reload()
    }

    private fun stopPolling() {
        poll?.cancel()
        poll = null
        pending = null
    }

    suspend fun cancel() {
        stopPolling()
        error = null
        reload()
    }

    suspend fun disconnect() {
        stopPolling()
        error = null
        store.load()?.let { a ->
            a.secrets.access?.let { t -> runCatching { client(a.clientId).revoke(t, a.secrets.secret) }.onFailure { Log.w(TAG, "revoke failed: ${it.message}") } }
        }
        store.save(null)
        reload()
    }

    suspend fun setScrobble(serverId: String, on: Boolean) {
        val off = store.offServers()
        store.setOffServers(if (on) off - serverId else off + serverId)
        reload()
    }

    // Whether the server runs the Trakt plugin; null when its plugin list cannot be read (not an admin).
    suspend fun plugin(api: Api): Boolean? {
        val key = "${api.server.id}|${api.userId}"
        synchronized(plugins) { if (key in plugins) return plugins[key] }
        val found = runCatching { hasTraktPlugin(json.parseToJsonElement(api.raw("GET", "/Plugins"))) }.getOrNull()
        synchronized(plugins) { plugins[key] = found }
        return found
    }

    // From the playback reports: start (and unpause), pause, stop. Trakt marks a stop at 80 % or more watched.
    // Not for file sources (spec §1: Trakt is deferred for them; their watch state is local).
    fun scrobble(action: String, api: Api, item: Item, positionMs: Long, durationMs: Long) {
        if (api.server.isFiles) return
        scrobble(action, api.server.id, item, positionMs, durationMs) { plugin(api) }
    }

    internal fun scrobble(action: String, serverId: String, item: Item, positionMs: Long, durationMs: Long, detect: suspend () -> Boolean?) {
        val body = scrobbleBody(item, if (durationMs > 0) positionMs * 100.0 / durationMs else 0.0) ?: return
        send(serverId, detect) { c, token -> c.scrobble(action, token, body) }
    }

    // "Vu" set or cleared on an item page, or an entry removed from the history.
    fun history(api: Api, item: Item, watched: Boolean) {
        if (api.server.isFiles) return
        history(api.server.id, item, watched) { plugin(api) }
    }

    internal fun history(serverId: String, item: Item, watched: Boolean, detect: suspend () -> Boolean?) {
        val body = historyBody(item) ?: return
        send(serverId, detect) { c, token -> if (watched) c.addHistory(token, body) else c.removeLatestPlay(token, item) }
    }

    private fun send(serverId: String, detect: suspend () -> Boolean?, call: suspend (TraktClient, String) -> Unit) {
        queue.trySend {
            val a = store.load()?.takeIf { it.secrets.access != null } ?: return@trySend
            if (serverId in store.offServers() || detect() == true) return@trySend
            authorized(a, call)
        }
    }

    private suspend fun authorized(a: TraktAccount, call: suspend (TraktClient, String) -> Unit) {
        val client = client(a.clientId)
        var s = a.secrets
        if (s.refresh != null && s.expiresAt - REFRESH_MARGIN_MS < now()) s = refresh(client, a, s)
        try {
            call(client, s.access!!)
        } catch (e: TraktException) {
            if (e.status != 401 || s.refresh == null) throw e
            call(client, refresh(client, a, s).access!!)
        }
    }

    private suspend fun refresh(client: TraktClient, a: TraktAccount, s: TraktSecrets): TraktSecrets {
        try {
            val next = secrets(s.secret, client.refresh(s.refresh!!, s.secret))
            store.save(a.copy(secrets = next))
            return next
        } catch (e: TraktException) {
            // A refresh token Trakt no longer accepts: the user has to authorize again.
            if (e.status == 400 || e.status == 401) {
                store.save(a.copy(secrets = TraktSecrets(s.secret)))
                error = TraktFailure(R.string.trakt_error_reauthorize)
                reload()
            }
            throw e
        }
    }

    private fun secrets(secret: String, t: Tokens) =
        TraktSecrets(secret, t.accessToken, t.refreshToken, (if (t.createdAt > 0) t.createdAt * 1000 else now()) + t.expiresIn * 1000)

    companion object {
        private const val TAG = "Trakt"

        val shared: TraktService by lazy { TraktService(DataTraktStore(Core.app), Core.scope).also { s -> Core.scope.launch { s.reload() } } }
    }
}

// Its own DataStore file. The client secret and the tokens are sealed by the Keystore Vault, like the server token.
private val Context.traktStore by preferencesDataStore("wicaby_trakt")

class DataTraktStore(private val context: Context) : TraktStore {
    private val clientKey = stringPreferencesKey("client_id")
    private val userKey = stringPreferencesKey("user")
    private val secretsKey = stringPreferencesKey("secrets")
    private val offKey = stringSetPreferencesKey("off_servers")

    override suspend fun load(): TraktAccount? {
        val p = context.traktStore.data.first()
        val id = p[clientKey] ?: return null
        val s = p[secretsKey]?.let(Vault::decrypt)?.let { runCatching { traktJson.decodeFromString(TraktSecrets.serializer(), it) }.getOrNull() } ?: return null
        return TraktAccount(id, p[userKey].orEmpty(), s)
    }

    override suspend fun save(a: TraktAccount?) {
        context.traktStore.edit {
            if (a == null) {
                it.remove(clientKey); it.remove(userKey); it.remove(secretsKey)
            } else {
                it[clientKey] = a.clientId
                it[userKey] = a.user
                it[secretsKey] = Vault.encrypt(traktJson.encodeToString(TraktSecrets.serializer(), a.secrets))
            }
        }
    }

    override suspend fun offServers(): Set<String> = context.traktStore.data.first()[offKey].orEmpty()

    override suspend fun setOffServers(ids: Set<String>) {
        context.traktStore.edit { it[offKey] = ids }
    }
}
