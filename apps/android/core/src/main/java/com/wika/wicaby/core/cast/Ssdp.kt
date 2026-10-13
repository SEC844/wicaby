package com.wika.wicaby.core.cast

import android.content.Context
import android.net.wifi.WifiManager
import com.wika.wicaby.core.net.LocalNetwork
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.DatagramPacket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap

// SSDP M-SEARCH for MediaRenderers (cast spec CA-08, the port of the desktop's ssdp.ts). Needs ACCESS_LOCAL_NETWORK
// on Android 17 (CA-00): without it the sends fail with EPERM and nothing is found.
object Ssdp {
    private const val GROUP = "239.255.255.250"
    private const val PORT = 1900
    const val M_SEARCH = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\n" +
        "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n"

    // The LOCATION of a 200 reply, only when it points at the replying host itself and that host is on the LAN (§6).
    fun location(reply: String, source: String): String? {
        if (!reply.startsWith("HTTP/1.1 200", ignoreCase = true)) return null
        val loc = Regex("""^LOCATION:\s*(\S+)\s*$""", setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE)).find(reply)?.groupValues?.get(1) ?: return null
        val u = loc.toHttpUrlOrNull() ?: return null
        return loc.takeIf { u.scheme == "http" && u.host == source && LocalNetwork.isLanAddress(source) }
    }

    // IPv4 addresses of the LAN interfaces; never loopback, point-to-point (VPN) nor mesh (100.64/10).
    private fun lanAddresses(): List<Pair<NetworkInterface, InetAddress>> = runCatching {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback && !it.isPointToPoint && it.supportsMulticast() }
            .flatMap { nif -> nif.inetAddresses.toList().filter { it is Inet4Address && LocalNetwork.isLanAddress(it.hostAddress.orEmpty()) }.map { nif to it } }
    }.getOrDefault(emptyList())

    // LOCATIONs as they answer, for [timeoutMs]. Each interface gets its own ephemeral socket (never port 1900, which
    // the system may hold), two M-SEARCH 500 ms apart.
    fun search(context: Context, timeoutMs: Long = 3_000): Flow<String> = channelFlow {
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val lock = wifi?.createMulticastLock("wicaby-ssdp")?.apply { setReferenceCounted(false); runCatching { acquire() } }
        try {
            val jobs = lanAddresses().map { (nif, ip) ->
                launch {
                    runCatching {
                        MulticastSocket(InetSocketAddress(ip, 0)).use { s ->
                            s.networkInterface = nif
                            s.timeToLive = 2
                            s.soTimeout = 250
                            val msg = M_SEARCH.toByteArray()
                            val group = InetSocketAddress(InetAddress.getByName(GROUP), PORT)
                            val start = System.currentTimeMillis()
                            var sent = 0
                            val buf = ByteArray(2048)
                            while (System.currentTimeMillis() - start < timeoutMs) {
                                if (sent < 2 && System.currentTimeMillis() - start >= sent * 500L) {
                                    runCatching { s.send(DatagramPacket(msg, msg.size, group)) }
                                    sent++
                                }
                                val p = DatagramPacket(buf, buf.size)
                                try {
                                    s.receive(p)
                                } catch (_: SocketTimeoutException) {
                                    continue
                                }
                                location(String(p.data, 0, p.length, Charsets.ISO_8859_1), p.address.hostAddress.orEmpty())?.let { send(it) }
                            }
                        }
                    }
                }
            }
            jobs.forEach { it.join() }
        } finally {
            runCatching { lock?.release() }
        }
    }.flowOn(Dispatchers.IO)
}

// Renderers found while a picker was open, kept 60 s (§2.2) and never written to disk.
object DlnaRenderers {
    private const val KEEP_MS = 60_000L
    private val found = ConcurrentHashMap<String, Pair<Renderer, Long>>()

    fun get(key: String): Renderer? = found[key]?.first

    fun recent(): List<Renderer> = System.currentTimeMillis().let { now -> found.values.filter { now - it.second < KEEP_MS }.map { it.first } }

    // SSDP plus [seeds] (debug builds only: LOCATION URLs typed in Réglages), each description fetched once.
    fun discover(context: Context, seeds: List<String>, client: DlnaClient = DlnaClient()): Flow<Renderer> = channelFlow {
        val seen = HashSet<String>() // only touched from this flow's own coroutine
        fun describe(loc: String) {
            if (seen.add(loc)) launch {
                runCatching { client.describe(loc) }.getOrNull()?.let { r ->
                    found[r.key] = r to System.currentTimeMillis()
                    send(r)
                }
            }
        }
        seeds.forEach(::describe)
        Ssdp.search(context).collect(::describe)
    }
}
