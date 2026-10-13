package com.wika.wicaby.core.mesh

import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap

// An IP literal's bytes without any DNS lookup; null for a name. A host with ':' is only ever parsed as IPv6.
private fun ipLiteral(host: String): ByteArray? {
    val h = host.trim('[', ']')
    if (':' in h) return runCatching { InetAddress.getByName(h).address }.getOrNull()
    val parts = h.split('.')
    if (parts.size != 4) return null
    val octets = parts.map { p -> p.takeIf { it.length in 1..3 && it.all(Char::isDigit) }?.toInt()?.takeIf { it <= 255 } ?: return null }
    return ByteArray(4) { octets[it].toByte() }
}

private fun bit(b: ByteArray, i: Int) = (b[i / 8].toInt() shr (7 - i % 8)) and 1

/** Whether [host], an IP literal, is inside one of [routes] (NetBird network routes, CIDRs). Never by a default route. */
internal fun inRoutedNet(host: String, routes: List<String>): Boolean {
    val ip = ipLiteral(host) ?: return false
    return routes.any { r ->
        val base = ipLiteral(r.substringBefore('/'))
        val bits = r.substringAfter('/', "").toIntOrNull()
        // A default route (exit node) would send every address through the mesh.
        base != null && bits != null && base.size == ip.size && bits in 1..ip.size * 8 && (0 until bits).all { bit(base, it) == bit(ip, it) }
    }
}

internal fun tcpReachable(host: String, port: Int): Boolean =
    runCatching { Socket().use { it.connect(InetSocketAddress(InetAddress.getByAddress(ipLiteral(host)), port), DIRECT_MS) } }.isSuccess

private const val DIRECT_MS = 1500
private const val DIRECT_TTL_MS = 60_000L

/**
 * Direct first for a host inside a routed network, as the desktop app does: such a network is often the LAN itself
 * (at home), so the mesh is used only when the host does not answer directly within 1.5 s. A direct verdict holds
 * for a minute, or until a call to that origin fails ([failed]). Peers themselves always go through the mesh.
 */
internal class DirectFirst(
    private val reachable: (host: String, port: Int) -> Boolean = ::tcpReachable,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val direct = ConcurrentHashMap<String, Long>()

    /** True when [origin] ("scheme://host:port") is a routed-network host that answers directly: connect without the mesh. */
    fun goDirect(origin: String, routes: List<String>, peers: List<MeshPeer>): Boolean {
        val hostPort = origin.substringAfter("://")
        val host = hostPort.substringBeforeLast(':')
        val port = hostPort.substringAfterLast(':').toIntOrNull() ?: return false
        if (!inRoutedNet(host, routes) || peers.any { p -> p.ips.any { it.equals(host.trim('[', ']'), ignoreCase = true) } }) return false
        direct[origin]?.let { if (now() - it < DIRECT_TTL_MS) return true }
        return reachable(host, port).also { if (it) direct[origin] = now() else direct.remove(origin) }
    }

    fun failed(origin: String) {
        direct.remove(origin)
    }

    fun clear() = direct.clear()
}
