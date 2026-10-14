package com.wika.wicaby.core

import android.app.Application
import android.content.Context
import android.content.res.Configuration
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.provider.Settings
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import com.wika.wicaby.core.cast.EphemeralTokens
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Prefs
import com.wika.wicaby.core.data.ServerAuthInterceptor
import com.wika.wicaby.core.data.ServerSocket
import com.wika.wicaby.core.data.SocketMessage
import com.wika.wicaby.core.player.MessageBanner
import com.wika.wicaby.core.player.RemoteControl
import com.wika.wicaby.core.mesh.MeshTransport
import com.wika.wicaby.core.net.AddressSwitch
import com.wika.wicaby.core.net.ServerTransport
import com.wika.wicaby.core.net.TransportInterceptor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import okhttp3.OkHttpClient
import java.util.Locale
import java.util.concurrent.TimeUnit

// Process-wide state shared by the TV and mobile apps. Each Application calls init() first.
object Core {
    lateinit var app: Application
        private set

    // Sent as the client Version and in the DeviceProfile name.
    var version: String = ""
        private set
    var profileName: String = "Wicaby"
        private set

    // Outlives screens: used for fire-and-forget calls such as "playback stopped".
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // How to reach a server. Direct by default; a mesh VPN swaps in a forwarder.
    @Volatile
    var transport: ServerTransport = ServerTransport.Direct

    // Wicaby's own Tailscale/NetBird node (Réglages > Accès à distance). init() makes it the
    // transport: it forwards only servers that are mesh peers, everything else stays direct.
    val mesh: MeshTransport by lazy { MeshTransport(app, deviceName) }

    // B09: each signed-in server's LAN or WAN address, whichever answers; the mesh still forwards its peers.
    val addresses: AddressSwitch by lazy { AddressSwitch(mesh) { com.wika.wicaby.core.data.Servers.all.map { it.server } } }

    // One client for the API, images, the player and downloads, so the transport covers them all.
    val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .addInterceptor(TransportInterceptor { transport })
            // Per hop (redirects too): credentials for the active server only, stripped elsewhere.
            .addNetworkInterceptor(ServerAuthInterceptor({ transport }, { com.wika.wicaby.core.data.Servers.extra }) { api })
            // Immich photo source (photos spec PH-13): x-api-key for its own origin only, dropped on any other hop.
            .addNetworkInterceptor(com.wika.wicaby.core.photos.ImmichKeyInterceptor({ transport }) { com.wika.wicaby.core.photos.Immich.source })
            // IPTV: the playing channel's EXTVLCOPT User-Agent and Referer, on its stream host only.
            .addNetworkInterceptor(com.wika.wicaby.core.iptv.IptvHeaders)
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    lateinit var prefs: Prefs
        private set

    // The signed-in API client; set by the UI once a session exists. A new session (sign-in, user
    // or server switch, sign-out) closes the old socket before the next one opens.
    @Volatile
    var api: Api? = null
        set(v) {
            val changed = sessionKey(field) != sessionKey(v)
            field = v
            if (!changed) return
            restartSocket()
            if (v != null && ::app.isInitialized) addresses.repick(v.server)
            // CA-11: disposable cast tokens a crash or a quit left on this server are revoked (unit tests: no prefs).
            if (v?.token != null && ::prefs.isInitialized) scope.launch { EphemeralTokens.shared.cleanup(v) }
        }

    // Réglages > "Autoriser le contrôle à distance": off posts SupportsMediaControl:false and drops commands.
    @Volatile
    var remoteControl: Boolean = true
        set(v) {
            if (field == v) return
            field = v
            restartSocket()
        }

    // Every server message (LibraryChanged, UserDataChanged, timer events…) of the current session.
    private val _socketMessages = MutableSharedFlow<SocketMessage>(extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val socketMessages: SharedFlow<SocketMessage> = _socketMessages

    private var socket: ServerSocket? = null

    // A frame on the current session's socket (cast/RemoteTargets mirror). false while none is open.
    fun socketSend(type: String, data: JsonElement? = null): Boolean = socket?.send(type, data) ?: false

    private fun sessionKey(a: Api?) = a?.let { "${it.server.id}|${it.server.address}|${it.userId}|${it.token}" }

    @Synchronized
    private fun restartSocket() {
        socket?.close()
        socket = null
        val a = api ?: return
        // Unit tests set api without an Application: no socket there.
        if (a.token == null || !::app.isInitialized) return
        // Plex has no Emby socket (its token never rides in a URL); a server-ended play comes back on the timeline.
        if (a.server.kind == "plex") return
        val key = sessionKey(a)
        val control = remoteControl
        socket = ServerSocket(http, a.socketUrl(), capabilities = { a.capabilities(control) }, deliver = { m ->
            if (sessionKey(api) == key) {
                _socketMessages.tryEmit(m)
                // Checked again on the main thread: a user switch may land between the post and the dispatch.
                RemoteControl.handle(m, control) { sessionKey(api) == key }
            }
        }).also { it.open() }
    }

    // Streaming cap in Mb/s, 0 = auto.
    @Volatile
    var maxMbps: Int = 0

    // Per-codec HDMI passthrough override, keyed by server codec name ("ac3", "eac3", "dts",
    // "truehd"): true forces it on in the DeviceProfile, false turns it off (decoded instead).
    @Volatile
    var passthroughOverride: Map<String, Boolean> = emptyMap()

    val deviceName: String by lazy {
        runCatching { Settings.Global.getString(app.contentResolver, "device_name") }.getOrNull()
            ?: "${Build.MANUFACTURER} ${Build.MODEL}"
    }

    // UI language for the text :core builds outside Compose (torrent states, errors, sizes).
    // Below API 33 the Application context ignores the in-app language, so the apps pass
    // their choice to setUiLocale(); null follows the app configuration (the system
    // language, or the per-app language Android 13+ applies to the whole process).
    @Volatile
    private var localizedContext: Context? = null

    val localized: Context get() = localizedContext ?: app

    fun setUiLocale(locale: Locale?) {
        localizedContext = locale?.let {
            app.createConfigurationContext(Configuration(app.resources.configuration).apply { setLocale(it) })
        }
    }

    val locale: Locale
        get() = localized.resources.configuration.let {
            if (Build.VERSION.SDK_INT >= 24) it.locales[0] else @Suppress("DEPRECATION") it.locale
        }

    fun str(@StringRes id: Int, vararg args: Any): String = localized.getString(id, *args)

    fun plural(@PluralsRes id: Int, count: Int, vararg args: Any): String =
        localized.resources.getQuantityString(id, count, *args)

    fun init(app: Application, version: String, profileName: String) {
        this.app = app
        this.version = version
        this.profileName = profileName
        prefs = Prefs(app)
        app.registerActivityLifecycleCallbacks(MessageBanner)
        transport = addresses
        mesh.resume()
        // File sources (core/files): their list, and Api.of() for their ids.
        com.wika.wicaby.core.files.FileSources.init()
        // Immich photo source (photos spec PH-13): its address and sealed key.
        com.wika.wicaby.core.photos.Immich.init(app)
        // B09: another network may reach the servers by another address.
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = addresses.repickAll()
            override fun onLost(network: Network) = addresses.repickAll()
        }
        runCatching {
            app.getSystemService(ConnectivityManager::class.java)
                .registerNetworkCallback(NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), cb)
        }
    }
}
