package com.wika.wicaby.core.scrobble

import android.content.Context
import android.util.Log
import androidx.annotation.StringRes
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Vault
import kotlinx.coroutines.CompletableDeferred
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
import kotlinx.serialization.builtins.ListSerializer
import okhttp3.OkHttpClient

// Music scrobbling from Wicaby itself, as the desktop's src/main/features/scrobble.ts: playing now on a track's start,
// then one listen once the standard rule is met ([shouldScrobble]); MusicSession counts the heard time (playback only).
// Off until the user connects a service. Listens that fail for a reason worth retrying wait in a queue (QUEUE_CAP at
// most, oldest dropped) and go again after the next listen that goes through, and every RETRY_MS.

/** What MusicSession tells the scrobbler. */
interface Scrobbler {
    fun nowPlaying(item: Item)

    /** The track ended: [startedAt] in Unix seconds, [listenedMs] heard (pauses and seeks not counted). */
    fun listened(item: Item, startedAt: Long, listenedMs: Long)
}

@Serializable
data class ScrobbleAccounts(
    val lbUser: String? = null,
    val lbToken: String? = null,
    val fmKey: String = "",
    val fmSecret: String? = null,
    val fmUser: String? = null,
    val fmSession: String? = null,
) {
    override fun toString() = "ScrobbleAccounts(<redacted>)"
}

@Serializable
data class QueuedListen(val to: String, val at: Long, val info: TrackInfo)

// Where the accounts and the queue live: DataScrobbleStore on a device, in memory in the unit tests.
interface ScrobbleStore {
    suspend fun load(): ScrobbleAccounts
    suspend fun save(a: ScrobbleAccounts)
    suspend fun queue(): List<QueuedListen>
    suspend fun setQueue(q: List<QueuedListen>)
}

// Resolved by the UI, in its language.
data class ScrobbleFailure(@StringRes val res: Int, val detail: String = "")

data class ScrobbleState(
    // ListenBrainz user name once a token is saved ("" when ListenBrainz did not say).
    val lbUser: String? = null,
    // "" until the user enters their Last.fm API key; fmUser once authorized; authUrl while waiting for the user.
    val fmKey: String = "",
    val fmUser: String? = null,
    val authUrl: String? = null,
    val queued: Int = 0,
    val error: ScrobbleFailure? = null,
)

private const val LB = "listenbrainz"
private const val FM = "lastfm"
private const val QUEUE_CAP = 500
private const val RETRY_MS = 15 * 60_000L
private const val AUTH_POLL_MS = 3_000L
private const val AUTH_WAIT_MS = 10 * 60_000L
private val LB_TOKEN_RE = Regex("^[A-Za-z0-9-]{8,128}$")
private val LASTFM_KEY_RE = Regex("^[A-Za-z0-9]{16,64}$")

class ScrobbleService(
    private val store: ScrobbleStore,
    private val scope: CoroutineScope,
    private val version: String,
    private val http: OkHttpClient = scrobbleHttp,
    private val now: () -> Long = System::currentTimeMillis,
) : Scrobbler {
    // Tests point both at a MockWebServer.
    @Volatile var lbBase = LISTENBRAINZ_API
    @Volatile var lastfmBase = LASTFM_API

    private val _state = MutableStateFlow(ScrobbleState())
    val state: StateFlow<ScrobbleState> = _state

    @Volatile private var error: ScrobbleFailure? = null
    @Volatile private var authUrl: String? = null
    @Volatile private var poll: Job? = null

    // Calls run one after the other: playing now before its listen, and the queue never sent twice at once.
    private val jobs = Channel<suspend () -> Unit>(Channel.UNLIMITED).also { q ->
        scope.launch { for (job in q) runCatching { job() }.onFailure { Log.w(TAG, "scrobble failed: ${it.message}") } }
    }

    private fun lb() = ListenBrainzClient(lbBase, http)
    private fun fm(a: ScrobbleAccounts) = LastfmClient(a.fmKey, a.fmSecret.orEmpty(), lastfmBase, http)

    suspend fun reload() {
        val a = store.load()
        _state.value = ScrobbleState(a.lbUser.takeIf { a.lbToken != null }, a.fmKey, a.fmUser.takeIf { a.fmSession != null }, authUrl, store.queue().size, error)
    }

    // ---- ListenBrainz ----

    /** False: the token is malformed or refused (unreachable: true, with the state's error). */
    suspend fun connectListenBrainz(token: String): Boolean {
        val t = token.trim()
        error = null
        if (!LB_TOKEN_RE.matches(t)) return false.also { reload() }
        val user = try {
            lb().validate(t)
        } catch (e: ScrobbleException) {
            if (!e.auth) error = ScrobbleFailure(R.string.scrobble_error_failed, e.message.orEmpty())
            null
        }
        if (user != null) store.save(store.load().copy(lbUser = user, lbToken = t))
        reload()
        return user != null || error != null
    }

    suspend fun disconnectListenBrainz() {
        error = null
        store.save(store.load().copy(lbUser = null, lbToken = null))
        drop(LB)
    }

    // ---- Last.fm (web auth: auth.getToken, the user allows it on last.fm, auth.getSession) ----

    /** False: the API key or secret is malformed. */
    suspend fun connectLastfm(apiKey: String, secret: String): Boolean {
        val key = apiKey.trim()
        val prev = store.load()
        // An empty secret keeps the stored one for the same API key.
        val sec = secret.trim().ifEmpty { if (prev.fmKey == key) prev.fmSecret.orEmpty() else "" }
        stopPolling()
        error = null
        if (!LASTFM_KEY_RE.matches(key) || !LASTFM_KEY_RE.matches(sec)) return false.also { reload() }
        val a = prev.copy(fmKey = key, fmSecret = sec, fmUser = null, fmSession = null)
        store.save(a)
        val client = fm(a)
        val token = try {
            client.getToken()
        } catch (e: ScrobbleException) {
            error = if (e.auth) ScrobbleFailure(R.string.scrobble_error_invalid_key) else ScrobbleFailure(R.string.scrobble_error_failed, e.message.orEmpty())
            reload()
            return true
        }
        val url = client.authUrl(token)
        authUrl = url
        reload()
        val until = now() + AUTH_WAIT_MS
        poll = scope.launch {
            while (true) {
                delay(AUTH_POLL_MS)
                if (now() > until) return@launch authFailed(ScrobbleFailure(R.string.scrobble_error_expired))
                val s = try {
                    client.getSession(token)
                } catch (e: ScrobbleException) {
                    ensureActive()
                    return@launch authFailed(if (e.code == 15) ScrobbleFailure(R.string.scrobble_error_expired) else ScrobbleFailure(R.string.scrobble_error_failed, e.message.orEmpty()))
                } ?: continue
                ensureActive()
                if (authUrl != url) return@launch
                store.save(store.load().copy(fmUser = s.second, fmSession = s.first))
                authUrl = null
                poll = null
                reload()
                return@launch
            }
        }
        return true
    }

    private suspend fun authFailed(f: ScrobbleFailure) {
        authUrl = null
        poll = null
        error = f
        Log.w(TAG, "Last.fm authorization failed")
        reload()
    }

    private fun stopPolling() {
        poll?.cancel()
        poll = null
        authUrl = null
    }

    suspend fun cancelLastfm() {
        stopPolling()
        error = null
        reload()
    }

    suspend fun disconnectLastfm() {
        stopPolling()
        error = null
        store.save(store.load().copy(fmUser = null, fmSession = null))
        drop(FM)
    }

    // ---- Playback ----

    override fun nowPlaying(item: Item) {
        val info = trackInfo(item) ?: return
        // Playing now is never queued: late, it would be wrong.
        jobs.trySend {
            val a = store.load()
            a.lbToken?.let { t -> runCatching { lb().submit(t, listenBody(info, null, version)) }.onFailure { failed(LB, it) } }
            a.fmSession?.let { sk -> runCatching { fm(a).nowPlaying(sk, info) }.onFailure { failed(FM, it) } }
        }
    }

    override fun listened(item: Item, startedAt: Long, listenedMs: Long) {
        val info = trackInfo(item) ?: return
        if (!shouldScrobble(info.durationMs ?: 0, listenedMs)) return
        jobs.trySend {
            var sent = false
            for (to in listOf(LB, FM)) {
                val q = QueuedListen(to, startedAt, info)
                try {
                    if (send(q)) sent = true
                } catch (e: Exception) {
                    if (failed(to, e)) enqueue(q)
                }
            }
            if (sent) drain()
        }
    }

    /** Sends the waiting listens again (a timer, the app's start). */
    fun flush() {
        jobs.trySend { drain() }
    }

    // False: that service is not connected.
    private suspend fun send(q: QueuedListen): Boolean {
        val a = store.load()
        if (q.to == LB) {
            val t = a.lbToken ?: return false
            lb().submit(t, listenBody(q.info, q.at, version))
        } else {
            val sk = a.fmSession ?: return false
            fm(a).scrobble(sk, q.info, q.at)
        }
        return true
    }

    // True when the listen is worth keeping for later (network, rate limit, server error, or a refused token the
    // user can fix by connecting again).
    private suspend fun failed(to: String, e: Throwable): Boolean {
        val s = e as? ScrobbleException
        Log.w(TAG, "$to failed: ${e.message}")
        if (s?.auth == true) {
            error = ScrobbleFailure(if (to == FM) R.string.scrobble_error_lastfm_reauthorize else R.string.scrobble_error_listenbrainz_reauthorize)
            reload()
        }
        return s == null || s.retry || s.auth
    }

    private suspend fun enqueue(q: QueuedListen) {
        store.setQueue((store.queue() + q).takeLast(QUEUE_CAP))
        reload()
    }

    // On [jobs], awaited: a drain in flight would otherwise write the dropped listens back.
    private suspend fun drop(to: String) {
        val done = CompletableDeferred<Unit>()
        jobs.trySend {
            try {
                store.setQueue(store.queue().filter { it.to != to })
                reload()
            } finally {
                done.complete(Unit)
            }
        }
        done.await()
    }

    // Oldest first; a service stops at its first failure worth retrying.
    private suspend fun drain() {
        val waiting = store.queue()
        if (waiting.isEmpty()) return
        val stalled = mutableSetOf<String>()
        val done = mutableSetOf<Int>()
        for ((i, q) in waiting.withIndex()) {
            if (q.to in stalled) continue
            try {
                if (!send(q)) continue
            } catch (e: Exception) {
                if (failed(q.to, e)) {
                    stalled += q.to
                    continue
                }
            }
            done += i
        }
        if (done.isNotEmpty()) {
            // Nothing else writes the queue meanwhile: every job runs on [jobs], one at a time.
            store.setQueue(waiting.filterIndexed { i, _ -> i !in done })
            reload()
        }
    }

    companion object {
        private const val TAG = "Scrobble"

        val shared: ScrobbleService by lazy {
            ScrobbleService(DataScrobbleStore(Core.app), Core.scope, Core.version).also { s ->
                Core.scope.launch {
                    s.reload()
                    delay(30_000)
                    while (true) {
                        s.flush()
                        delay(RETRY_MS)
                    }
                }
            }
        }
    }
}

// Its own DataStore file. The token, secret and session key are sealed by the Keystore Vault, like the server token;
// the queue holds track names only.
private val Context.scrobbleStore by preferencesDataStore("wicaby_scrobble")

class DataScrobbleStore(private val context: Context) : ScrobbleStore {
    private val accountsKey = stringPreferencesKey("accounts")
    private val queueKey = stringPreferencesKey("queue")
    private val queueSerializer = ListSerializer(QueuedListen.serializer())

    override suspend fun load(): ScrobbleAccounts =
        context.scrobbleStore.data.first()[accountsKey]?.let(Vault::decrypt)?.let { runCatching { scrobbleJson.decodeFromString(ScrobbleAccounts.serializer(), it) }.getOrNull() } ?: ScrobbleAccounts()

    override suspend fun save(a: ScrobbleAccounts) {
        context.scrobbleStore.edit { it[accountsKey] = Vault.encrypt(scrobbleJson.encodeToString(ScrobbleAccounts.serializer(), a)) }
    }

    override suspend fun queue(): List<QueuedListen> =
        context.scrobbleStore.data.first()[queueKey]?.let { runCatching { scrobbleJson.decodeFromString(queueSerializer, it) }.getOrNull() }.orEmpty()

    override suspend fun setQueue(q: List<QueuedListen>) {
        context.scrobbleStore.edit { it[queueKey] = scrobbleJson.encodeToString(queueSerializer, q) }
    }
}
