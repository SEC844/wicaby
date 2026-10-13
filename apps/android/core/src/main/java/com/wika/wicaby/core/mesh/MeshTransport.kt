package com.wika.wicaby.core.mesh

import android.content.Context
import android.os.Build
import android.util.Log
import com.wika.wicaby.core.BuildConfig
import com.wika.wicaby.core.net.ServerTransport
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

enum class MeshProvider(val id: String, val label: String) {
    Tailscale("tailscale", "Tailscale"),
    NetBird("netbird", "NetBird");

    companion object {
        fun of(id: String?): MeshProvider? = entries.firstOrNull { it.id == id }
    }
}

enum class MeshState { Stopped, Connecting, NeedsLogin, Connected, Error, Unsupported }

@Serializable
data class MeshPeer(
    val name: String = "",
    val dnsName: String? = null,
    val ips: List<String> = emptyList(),
    val online: Boolean = false,
    val os: String? = null,
)

data class MeshStatus(
    val state: MeshState = MeshState.Stopped,
    val provider: MeshProvider? = null,
    // Sign-in page: shown as a QR code on a TV, opened in the browser on a phone.
    val authUrl: String? = null,
    // NetBird device flow: the code the user confirms on that page.
    val userCode: String? = null,
    val selfName: String? = null,
    val selfDnsName: String? = null,
    val ips: List<String> = emptyList(),
    val error: String? = null,
    val peers: List<MeshPeer> = emptyList(),
    // NetBird network routes reachable through a peer, as CIDRs (empty for Tailscale).
    val routes: List<String> = emptyList(),
    // The last non-empty [error] of this process, kept across later states for diagnostics; never persisted.
    val lastError: MeshError? = null,
)

data class MeshError(val message: String, val at: Long)

// What packages/mesh/mesh reports (mesh.Status), as JSON over the gomobile boundary.
@Serializable
private data class WireStatus(
    val state: String = "stopped",
    val authUrl: String? = null,
    val userCode: String? = null,
    val selfName: String? = null,
    val selfDnsName: String? = null,
    val ips: List<String> = emptyList(),
    val error: String? = null,
    val peers: List<MeshPeer> = emptyList(),
    val routes: List<String> = emptyList(),
)

private val json = Json { ignoreUnknownKeys = true }

internal fun parseStatus(text: String, provider: MeshProvider?): MeshStatus {
    val w = runCatching { json.decodeFromString<WireStatus>(text) }.getOrElse { WireStatus(state = "error", error = it.message) }
    val state = when (w.state) {
        "connecting" -> MeshState.Connecting
        "needs-login" -> MeshState.NeedsLogin
        "connected" -> MeshState.Connected
        "error" -> MeshState.Error
        else -> MeshState.Stopped
    }
    return MeshStatus(
        state = state, provider = provider, authUrl = w.authUrl?.takeIf { it.isNotBlank() }, userCode = w.userCode?.takeIf { it.isNotBlank() },
        selfName = w.selfName, selfDnsName = w.selfDnsName, ips = w.ips, error = w.error?.takeIf { it.isNotBlank() }, peers = w.peers,
        routes = w.routes,
    )
}

// The Go forwarder knows peers by IP and full name (nas.tail1.ts.net, nas.netbird.cloud). A
// MagicDNS short name typed as the server ("http://nas:8096") becomes the one peer it names.
internal fun meshOrigin(origin: String, peers: List<MeshPeer>): String {
    val scheme = origin.substringBefore("://")
    val host = origin.substringAfter("://").substringBefore(':')
    if (host.isEmpty() || '.' in host || origin.count { it == ':' } != 2) return origin // IPs, full names, IPv6
    val fqdn = peers.mapNotNull { it.dnsName?.trimEnd('.') }.filter { it.substringBefore('.').equals(host, ignoreCase = true) }.singleOrNull()
        ?: return origin
    return "$scheme://$fqdn" + origin.substringAfter("://").removePrefix(host)
}

// "wicaby-" + the device name as a DNS label, like the desktop app ("wicaby-<pc>").
internal fun meshHostname(deviceName: String): String {
    val base = deviceName.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')
    return "wicaby-${base.ifEmpty { "android" }}".take(63).trimEnd('-')
}

@Serializable
private data class MeshPrefs(val enabled: Boolean = false, val provider: String = "tailscale", val managementUrl: String? = null)

// Log lines lose URLs (login links, management servers, local proxy tokens) and anything
// that looks like a key or a code (auth/setup keys, node keys, UUIDs).
private val LOG_URL = Regex("""\b[A-Za-z][A-Za-z0-9+.-]*://[^\s"'<>]+""")
private val LOG_SECRET = Regex("""[A-Za-z0-9_-]{20,}""")
// Scheme-less links (login.tailscale.com/a/abc123) and short user codes (NetBird ABCD-EFGH).
private val LOG_HOST_PATH = Regex("""\b[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d+)?/[^\s"'<>]*""")
private val LOG_USER_CODE = Regex("""\b[A-Z0-9]{4,8}(-[A-Z0-9]{4,8})+\b""")

internal fun redactMeshLog(line: String): String =
    line.replace(LOG_URL, "<url>").replace(LOG_HOST_PATH, "<url>")
        .replace(LOG_SECRET, "<redacted>").replace(LOG_USER_CODE, "<redacted>")

/**
 * Wicaby's own node on the user's Tailscale or NetBird network: the vpn-helper Go
 * library (tsnet / NetBird client/embed) bound with gomobile, entirely in userspace.
 * There is no VpnService and no system-wide tunnel, and the Tailscale/NetBird apps
 * are not needed. Servers on the mesh are reached through loopback forwarders
 * (http://127.0.0.1:<port>/<token>), one per origin. As the [ServerTransport],
 * Core.http rewrites their URLs, so the API, artwork, ExoPlayer and downloads
 * follow. Nothing else can leave through it: the Go side only forwards to current
 * mesh peers.
 *
 * State (node key, NetBird config) lives under filesDir/mesh/<provider>, app-private.
 * Auth keys / setup keys are passed once and never stored: Tailscale and NetBird
 * keep their own node credentials after the first registration.
 *
 * Lifetime: the node runs on Go threads inside the app process, with no foreground
 * service. That is enough while Wicaby is in the foreground (browsing, playback).
 * In the background Android may freeze or kill the process. A running media session
 * or download service keeps it alive, so the mesh keeps working for those. When the
 * process comes back, [resume] reconnects from the saved state in a few seconds.
 * A dedicated foreground service would only be needed for long background transfers
 * without a service of their own; not worth a permanent notification today.
 *
 * Needs Android 8.0 (API 26), the AAR's minSdk. Below that it reports
 * [MeshState.Unsupported] and never loads the native library.
 */
class MeshTransport(context: Context, deviceName: String) : ServerTransport {
    private val app = context.applicationContext
    private val root = File(app.filesDir, "mesh")
    private val prefsFile = File(root, "wicaby.json")
    private val hostname = meshHostname(deviceName)

    // Every call into Go that starts, stops or signs out runs here, in order.
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "wicaby-mesh").apply { isDaemon = true } }

    val supported: Boolean = Build.VERSION.SDK_INT >= 26

    private val _status = MutableStateFlow(if (supported) MeshStatus() else MeshStatus(state = MeshState.Unsupported))
    val status: StateFlow<MeshStatus> = _status.asStateFlow()

    // Provider of the running node (null = not running) and the run it belongs to:
    // status callbacks from a stopped run are dropped.
    @Volatile private var running: MeshProvider? = null
    @Volatile private var run = 0

    // origin -> loopback base for the current run. `refused` remembers origins the node
    // said are not on the mesh, keyed by the peer list they were refused against.
    private val routes = ConcurrentHashMap<String, String>()
    private val refused = ConcurrentHashMap<String, Int>()
    @Volatile private var peersKey = 0

    @Volatile private var prefs: MeshPrefs = readPrefs()

    val enabled: Boolean get() = prefs.enabled
    val provider: MeshProvider get() = MeshProvider.of(prefs.provider) ?: MeshProvider.Tailscale
    val managementUrl: String? get() = prefs.managementUrl

    // ---- ServerTransport ----

    override fun forward(origin: String): String? {
        if (running == null || _status.value.state != MeshState.Connected) return null
        routes[origin]?.let { return it }
        val key = peersKey
        if (refused[origin] == key) return null
        return try {
            com.wika.wicaby.mesh.mobile.Mobile.forward(meshOrigin(origin, _status.value.peers)).also { routes[origin] = it }
        } catch (e: Exception) {
            // Not a mesh peer (the usual answer for LAN and internet hosts): connect directly.
            refused[origin] = key
            null
        }
    }

    // ---- Control (all asynchronous; watch [status]) ----

    /** Restarts the node at app start if the user left it on. */
    fun resume() {
        if (supported && prefs.enabled) worker.execute { launch(null) }
    }

    /**
     * Joins [provider]'s network. Without [authKey] the status soon carries an
     * [MeshStatus.authUrl] to sign in with. [managementUrl] is a Headscale or
     * self-hosted NetBird URL (null = the hosted service). [authKey] is a Tailscale
     * auth key or NetBird setup key, used once.
     */
    fun login(provider: MeshProvider, managementUrl: String? = null, authKey: String? = null) {
        if (!supported) return
        worker.execute {
            writePrefs(MeshPrefs(enabled = true, provider = provider.id, managementUrl = managementUrl?.trim()?.takeIf { it.isNotEmpty() }))
            halt()
            launch(authKey?.trim()?.takeIf { it.isNotEmpty() })
        }
    }

    /** Leaves the network for now; the node stays registered, so the next login is instant. */
    fun disconnect() {
        worker.execute {
            writePrefs(prefs.copy(enabled = false))
            halt()
            publish(MeshStatus(state = if (supported) MeshState.Stopped else MeshState.Unsupported))
        }
    }

    /** Signs this device out of the network and forgets its key. */
    fun logout() {
        worker.execute {
            val p = running
            if (p != null) runCatching { com.wika.wicaby.mesh.mobile.Mobile.logout() }.onFailure { Log.w(TAG, "logout: ${redactMeshLog(it.message.orEmpty())}") }
            halt()
            File(root, provider.id).deleteRecursively()
            writePrefs(prefs.copy(enabled = false))
            publish(MeshStatus(state = MeshState.Stopped))
        }
    }

    // ---- Worker thread ----

    private fun launch(authKey: String?) {
        if (running != null) return
        val provider = provider
        val dir = File(root, provider.id).apply { mkdirs() }
        val myRun = ++run
        routes.clear()
        refused.clear()
        publish(MeshStatus(state = MeshState.Connecting, provider = provider))
        try {
            // TMPDIR and friends for the Go runtime (gomobile reads them from the context).
            go.Seq.setContext(app)
            // Go-side lines carry login URLs, auth codes and peer addresses: debug builds only, redacted.
            com.wika.wicaby.mesh.mobile.Mobile.setLogger({ line -> if (BuildConfig.DEBUG) Log.i(TAG, redactMeshLog(line)) }, BuildConfig.DEBUG)
            com.wika.wicaby.mesh.mobile.Mobile.start(provider.id, dir.absolutePath, hostname, prefs.managementUrl ?: "", authKey ?: "") { text ->
                if (run == myRun) onStatus(parseStatus(text, provider))
            }
            running = provider
            if (BuildConfig.DEBUG) Log.i(TAG, "started ${provider.id} node $hostname")
        } catch (e: Throwable) {
            // Exception from Go, or UnsatisfiedLinkError if the ABI is missing from the APK.
            Log.w(TAG, "start failed: ${e.javaClass.simpleName} ${redactMeshLog(e.message.orEmpty())}")
            publish(MeshStatus(state = MeshState.Error, provider = provider, error = e.message ?: e.toString()))
        }
    }

    private fun halt() {
        if (running == null) return
        run++
        running = null
        routes.clear()
        refused.clear()
        runCatching { com.wika.wicaby.mesh.mobile.Mobile.stop() }
    }

    private fun onStatus(s: MeshStatus) {
        val key = s.peers.hashCode()
        if (key != peersKey) {
            peersKey = key
            refused.clear()
        }
        publish(s)
    }

    private fun publish(s: MeshStatus) {
        val prev = _status.value
        // The same error on every status callback keeps its first time.
        val last = if (s.error == null || (s.error == prev.error && prev.lastError != null)) prev.lastError else MeshError(s.error, System.currentTimeMillis())
        _status.value = s.copy(lastError = last)
    }

    private fun readPrefs(): MeshPrefs =
        runCatching { json.decodeFromString<MeshPrefs>(prefsFile.readText()) }.getOrDefault(MeshPrefs())

    private fun writePrefs(p: MeshPrefs) {
        prefs = p
        runCatching {
            root.mkdirs()
            val tmp = File(root, "wicaby.json.tmp")
            tmp.writeText(json.encodeToString(MeshPrefs.serializer(), p))
            tmp.renameTo(prefsFile)
        }.onFailure { Log.w(TAG, "saving mesh prefs: ${it.javaClass.simpleName}") }
    }

    private companion object {
        const val TAG = "WicabyMesh"
    }
}
