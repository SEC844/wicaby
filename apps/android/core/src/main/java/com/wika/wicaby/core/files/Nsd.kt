package com.wika.wicaby.core.files

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

// What "Find on this network" offers: it only fills the Add form (url, user, name); nothing connects before Test.
data class FoundShare(val name: String, val protocol: String, val url: String, val user: String? = null)

// File sources §6.2 on Android: NsdManager browses _webdav._tcp, _webdavs._tcp and _smb._tcp for 2.5 s and resolves
// each reply (registerServiceInfoCallback on API 34+, resolveService before). SMB announces a host only: the address
// ends with "\" and the user types the share.
object Nsd {
    const val WINDOW_MS = 2_500L
    private const val RESOLVE_MS = 1_500L
    private const val MAX = 64
    private val TYPES = listOf("_webdav._tcp", "_webdavs._tcp", "_smb._tcp")

    suspend fun find(context: Context, windowMs: Long = WINDOW_MS): List<FoundShare> {
        val nsd = context.getSystemService(NsdManager::class.java) ?: return emptyList()
        val replies = Channel<Pair<String, NsdServiceInfo>>(Channel.UNLIMITED)
        val listeners = TYPES.map { type ->
            object : NsdManager.DiscoveryListener {
                override fun onServiceFound(info: NsdServiceInfo) { replies.trySend(type to info) }
                override fun onServiceLost(info: NsdServiceInfo) {}
                override fun onDiscoveryStarted(serviceType: String) {}
                override fun onDiscoveryStopped(serviceType: String) {}
                override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
                override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            }.also { runCatching { nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, it) } }
        }
        val out = LinkedHashMap<String, FoundShare>()
        try {
            withTimeoutOrNull(windowMs) {
                for ((type, info) in replies) {
                    val r = resolve(nsd, info) ?: continue
                    val host = hostOf(r) ?: continue
                    val txt = r.attributes.orEmpty().mapValues { (_, v) -> v?.decodeToString().orEmpty() }
                    entry(type, r.serviceName.orEmpty(), host, r.port, txt)?.let { out.getOrPut(it.url) { it } }
                    if (out.size >= MAX) break
                }
            }
        } finally {
            listeners.forEach { runCatching { nsd.stopServiceDiscovery(it) } }
        }
        return out.values.toList()
    }

    // One reply as a form entry (pure: NsdTest). [host] is an address; TXT path= is the base path, u= the user.
    fun entry(type: String, name: String, host: String, port: Int, txt: Map<String, String>): FoundShare? {
        val h = host.substringBefore('%').let { if (':' in it) "[$it]" else it }
        if (h.isEmpty() || port !in 1..65535) return null
        val user = txt["u"]?.trim()?.takeIf { it.isNotEmpty() }
        val t = type.trim('.')
        return when (t) {
            "_webdav._tcp", "_webdavs._tcp" -> {
                val secure = t == "_webdavs._tcp"
                val path = txt["path"]?.trim().orEmpty().let { if (it.isEmpty() || it.startsWith("/")) it else "/$it" }.trimEnd('/')
                val p = if (port == (if (secure) 443 else 80)) "" else ":$port"
                FoundShare(name.ifEmpty { host }, FileSource.WEBDAV, "${if (secure) "https" else "http"}://$h$p$path", user)
            }
            "_smb._tcp" -> FoundShare(name.ifEmpty { host }, FileSource.SMB, "\\\\$h\\", user)
            else -> null
        }
    }

    // IPv4 first: a link-local IPv6 address means nothing in a URL.
    private fun hostOf(info: NsdServiceInfo): String? {
        val all: List<InetAddress> = if (Build.VERSION.SDK_INT >= 34) info.hostAddresses else listOfNotNull(@Suppress("DEPRECATION") info.host)
        return (all.firstOrNull { it is Inet4Address } ?: all.firstOrNull())?.hostAddress
    }

    private suspend fun resolve(nsd: NsdManager, info: NsdServiceInfo): NsdServiceInfo? {
        if (Build.VERSION.SDK_INT >= 34) {
            var cb: NsdManager.ServiceInfoCallback? = null
            try {
                return withTimeoutOrNull(RESOLVE_MS) {
                    suspendCancellableCoroutine { c ->
                        val once = AtomicBoolean()
                        val done = { s: NsdServiceInfo? -> if (once.compareAndSet(false, true)) c.resume(s) }
                        cb = object : NsdManager.ServiceInfoCallback {
                            override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) = done(null)
                            override fun onServiceUpdated(serviceInfo: NsdServiceInfo) = done(serviceInfo)
                            override fun onServiceLost() {}
                            override fun onServiceInfoCallbackUnregistered() {}
                        }.also { nsd.registerServiceInfoCallback(info, { it.run() }, it) }
                    }
                }
            } finally {
                cb?.let { runCatching { nsd.unregisterServiceInfoCallback(it) } }
            }
        }
        // One resolve at a time before API 34: the caller's loop is sequential.
        return withTimeoutOrNull(RESOLVE_MS) {
            suspendCancellableCoroutine { c ->
                val once = AtomicBoolean()
                @Suppress("DEPRECATION")
                nsd.resolveService(info, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) { if (once.compareAndSet(false, true)) c.resume(null) }
                    override fun onServiceResolved(serviceInfo: NsdServiceInfo) { if (once.compareAndSet(false, true)) c.resume(serviceInfo) }
                })
            }
        }
    }
}
