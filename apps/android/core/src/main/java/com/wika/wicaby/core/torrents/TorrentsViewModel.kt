package com.wika.wicaby.core.torrents

import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

// Process-wide qBittorrent settings, shared by the TV and mobile apps.
object Torrents {
    val store: QbitStore by lazy { QbitStore(Core.app) }
}

// labelRes names the filter; emptyRes is the empty-list title ("No torrents in progress").
enum class TorrentFilter(@StringRes val labelRes: Int, @StringRes val emptyRes: Int) {
    All(R.string.torrent_filter_all, R.string.torrents_empty_all),
    Downloading(R.string.torrent_filter_downloading, R.string.torrents_empty_downloading),
    Completed(R.string.torrent_filter_completed, R.string.torrents_empty_completed),
    Paused(R.string.torrent_filter_paused, R.string.torrents_empty_paused),
    ;

    val label: String get() = Core.str(labelRes)

    fun matches(t: Torrent): Boolean = when (this) {
        All -> true
        Downloading -> !t.isComplete && !t.isPaused
        Completed -> t.isComplete
        Paused -> t.isPaused
    }
}

sealed interface QbitConnection {
    // No address saved yet: show the setup screen.
    data object Unconfigured : QbitConnection
    data object Connecting : QbitConnection
    data class Online(val version: String) : QbitConnection
    data class Offline(val message: String, val kind: QbitException.Kind) : QbitConnection
}

data class SetupState(val busy: Boolean = false, val error: String? = null)

data class TorrentsState(
    // False until the saved settings were read once (avoid flashing the setup screen).
    val ready: Boolean = false,
    val config: QbitConfig? = null,
    val connection: QbitConnection = QbitConnection.Connecting,
    // Filtered by [filter], newest first.
    val torrents: List<Torrent> = emptyList(),
    val counts: Map<TorrentFilter, Int> = emptyMap(),
    val categories: List<Category> = emptyList(),
    // Global speeds, alternative speed mode, free space (desktop: TorrentsState.transfer).
    val transfer: ServerState = ServerState(),
    val filter: TorrentFilter = TorrentFilter.All,
    val setup: SetupState = SetupState(),
    // Hashes with an action in flight.
    val pending: Set<String> = emptySet(),
    // One-shot message (action failed, torrent added...); call consumeNotice() once shown.
    val notice: String? = null,
)

// Polls sync/maindata every 2 s while [state] has collectors (collectAsState /
// collectAsStateWithLifecycle), and stops when nobody watches.
class TorrentsViewModel(private val store: QbitStore = Torrents.store) : ViewModel() {
    private val _state = MutableStateFlow(TorrentsState())
    val state: StateFlow<TorrentsState> = _state.asStateFlow()

    private var client: QbitClient? = null
    private var clientConfig: QbitConfig? = null
    private var data = MainData()
    private val wake = Channel<Unit>(Channel.CONFLATED)

    init {
        viewModelScope.launch {
            val watched = _state.subscriptionCount.map { it > 0 }.distinctUntilChanged()
            combine(store.config, watched) { c, w -> c to w }.collectLatest { (config, active) ->
                _state.update { it.copy(ready = true, config = config) }
                if (config == null) {
                    client = null
                    clientConfig = null
                    data = MainData()
                    _state.update { it.copy(connection = QbitConnection.Unconfigured, torrents = emptyList(), counts = emptyMap(), categories = emptyList(), transfer = ServerState()) }
                    return@collectLatest
                }
                if (config != clientConfig) {
                    clientConfig = config
                    data = MainData()
                    client = runCatching { QbitClient(config.url, config.username, config.password) }.getOrNull()
                    _state.update { it.copy(connection = QbitConnection.Connecting, torrents = emptyList(), counts = emptyMap()) }
                }
                if (active) pollLoop()
            }
        }
    }

    private suspend fun pollLoop() {
        var failures = 0
        while (true) {
            failures = if (poll()) 0 else failures + 1
            val wait = if (failures == 0) 2_000L else minOf(15_000L, 3_000L * failures)
            withTimeoutOrNull(wait) { wake.receive() }
        }
    }

    // One sync/maindata round trip; false on failure.
    private suspend fun poll(): Boolean {
        val c = client
        if (c == null) {
            offline(QbitException(R.string.qbit_bad_url, QbitException.Kind.BadUrl))
            return false
        }
        return try {
            val version = c.appVersion ?: c.version()
            data = c.sync(data)
            publish(QbitConnection.Online(version))
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            offline(e)
            false
        }
    }

    private fun offline(e: Exception) {
        val q = e as? QbitException
        _state.update { it.copy(connection = QbitConnection.Offline(q?.message ?: Core.str(R.string.qbit_unreachable), q?.kind ?: QbitException.Kind.Network)) }
    }

    private fun publish(connection: QbitConnection? = null) {
        val all = data.torrentList().sortedByDescending { it.addedOn }
        _state.update { s ->
            s.copy(
                connection = connection ?: s.connection,
                torrents = all.filter(s.filter::matches),
                counts = TorrentFilter.entries.associateWith { f -> all.count(f::matches) },
                categories = data.categories.values.sortedBy { it.name.lowercase() },
                transfer = data.serverState(),
            )
        }
    }

    // ---------------------------------------------------------------- setup

    // Tests the address and credentials, then saves them. Progress and errors land in state.setup.
    // password = null keeps the stored one (editing the address without retyping it).
    fun connect(url: String, username: String, password: String?) {
        if (_state.value.setup.busy) return
        _state.update { it.copy(setup = SetupState(busy = true)) }
        viewModelScope.launch {
            try {
                val password = password ?: store.current()?.password.orEmpty()
                val c = QbitClient(url, username.trim(), password)
                if (username.isNotBlank()) c.login()
                c.version()
                val config = QbitConfig(c.base.toString(), username.trim(), password)
                client = c
                clientConfig = config
                data = MainData()
                store.save(config)
                _state.update { it.copy(setup = SetupState()) }
                wake.trySend(Unit)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(setup = SetupState(error = e.message ?: Core.str(R.string.connection_failed))) }
            }
        }
    }

    // Forgets the address and password.
    fun disconnect() {
        val c = client
        viewModelScope.launch {
            runCatching { c?.logout() }
            store.clear()
        }
    }

    fun refresh() {
        wake.trySend(Unit)
    }

    fun setFilter(filter: TorrentFilter) {
        _state.update { it.copy(filter = filter) }
        publish()
    }

    fun consumeNotice() {
        _state.update { it.copy(notice = null) }
    }

    // ---------------------------------------------------------------- actions

    // Magnet links, http(s) .torrent URLs or bare info hashes, one per line.
    // Returns false (and does nothing) when no line looks like one.
    fun addLinks(text: String, options: AddOptions = AddOptions()): Boolean {
        val links = parseLinks(text)
        if (links.isEmpty()) return false
        act(emptySet(), success = Core.plural(R.plurals.torrents_added, links.size, links.size)) { addUrls(links, options) }
        return true
    }

    fun addTorrentFile(fileName: String, bytes: ByteArray, options: AddOptions = AddOptions()) {
        act(emptySet(), success = Core.plural(R.plurals.torrents_added, 1, 1)) { addFile(fileName, bytes, options) }
    }

    fun pause(hash: String) = act(setOf(hash)) { pause(listOf(hash)) }

    fun resume(hash: String) = act(setOf(hash)) { resume(listOf(hash)) }

    fun togglePause(t: Torrent) = if (t.isPaused) resume(t.hash) else pause(t.hash)

    fun pauseAll() = act(emptySet()) { pause(emptyList()) }

    fun resumeAll() = act(emptySet()) { resume(emptyList()) }

    fun remove(hash: String, deleteFiles: Boolean) =
        act(setOf(hash), success = Core.str(if (deleteFiles) R.string.torrent_removed_files else R.string.torrent_removed)) { remove(listOf(hash), deleteFiles) }

    fun recheck(hash: String) = act(setOf(hash)) { recheck(listOf(hash)) }

    // "" removes the category.
    fun setCategory(hash: String, category: String) = act(setOf(hash)) { setCategory(listOf(hash), category) }

    fun toggleAltSpeed() = act(emptySet()) { toggleAltSpeed() }

    private fun act(hashes: Set<String>, success: String? = null, block: suspend QbitClient.() -> Unit) {
        val c = client ?: return
        _state.update { it.copy(pending = it.pending + hashes) }
        viewModelScope.launch {
            try {
                c.block()
                if (success != null) _state.update { it.copy(notice = success) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(notice = e.message ?: Core.str(R.string.action_failed)) }
            } finally {
                _state.update { it.copy(pending = it.pending - hashes) }
                wake.trySend(Unit)
            }
        }
    }
}

private val HASH = Regex("^([0-9a-fA-F]{40}|[A-Za-z2-7]{32}|[0-9a-fA-F]{64})$")

fun parseLinks(text: String): List<String> = text.split('\n', '\r', ' ', '\t').map { it.trim() }.filter { it.isNotEmpty() }.mapNotNull { s ->
    when {
        s.startsWith("magnet:?", ignoreCase = true) -> s
        s.startsWith("http://", ignoreCase = true) || s.startsWith("https://", ignoreCase = true) -> s
        HASH.matches(s) -> "magnet:?xt=urn:btih:$s"
        else -> null
    }
}
