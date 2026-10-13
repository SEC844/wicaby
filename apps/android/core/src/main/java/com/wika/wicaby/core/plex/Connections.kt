package com.wika.wicaby.core.plex

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.io.IOException
import java.net.Inet4Address
import java.net.NetworkInterface

// One connection plex.tv lists for a server (clients.plex.tv resources).
@Serializable
data class PlexConnection(
    val uri: String = "",
    val protocol: String? = null,
    val address: String? = null,
    val port: Int? = null,
    val local: Boolean = false,
    val relay: Boolean = false,
    @SerialName("IPv6") val ipv6: Boolean = false,
)

// Choosing how to reach a Plex server (plex-spec §5.3), the twin of desktop shared/plex/connections.ts: the listed
// connections ranked into three waves (local, remote, then the bandwidth-capped relay), https before http inside a
// wave, lastGood first of its wave. Dropped first: plain http when the server requires https (Plezy #929), and a
// "local" private IPv4 address on no network of this device (a Docker bridge, #811). The ranking vectors are
// tools/checks/fixtures/plex/connections.json, shared with the desktop.
object PlexConnections {
    data class Dropped(val uri: String, val why: String)

    data class Ranked(val waves: List<List<String>>, val dropped: List<Dropped>)

    // Head start of each wave over the next, in ms.
    val WAVE_DELAYS_MS = listOf(0L, 600L, 1500L)

    private val HTTP = Regex("^https?://", RegexOption.IGNORE_CASE)
    private val OCTET = Regex("^\\d{1,3}$")

    private fun ipv4(s: String?): Long? {
        val p = (s ?: "").split('.')
        if (p.size != 4 || !p.all { OCTET.matches(it) && it.toInt() <= 255 }) return null
        return p.fold(0L) { n, x -> n * 256 + x.toInt() }
    }

    fun inSubnet(ip: String, cidr: String): Boolean {
        val net = cidr.substringBefore('/')
        val bits = jsNumber(cidr.split('/').getOrNull(1))
        val a = ipv4(ip) ?: return false
        val b = ipv4(net) ?: return false
        if (!(bits >= 0 && bits <= 32) || bits != Math.floor(bits)) return false
        val shift = 32 - bits.toInt()
        return a shr shift == b shr shift
    }

    private fun isPrivate4(n: Long): Boolean {
        val a = n shr 24
        val b = (n shr 16) and 0xff
        return a == 10L || (a == 172L && b in 16..31) || (a == 192L && b == 168L) || (a == 169L && b == 254L)
    }

    private fun secure(c: PlexConnection) = (c.protocol ?: c.uri.split(':')[0]).lowercase() == "https"

    // [subnets]: this device's IPv4 networks ("a.b.c.d/len"); null: unknown, nothing dropped by network.
    fun rankConnections(conns: List<PlexConnection>, httpsRequired: Boolean = false, subnets: List<String>? = null, lastGood: String? = null): Ranked {
        val dropped = ArrayList<Dropped>()
        val kept = ArrayList<PlexConnection>()
        val seen = HashSet<String>()
        for (c in conns) {
            if (c.uri.isEmpty() || c.uri in seen || !HTTP.containsMatchIn(c.uri)) continue
            seen += c.uri
            if (httpsRequired && !secure(c)) {
                dropped += Dropped(c.uri, "http-refused")
                continue
            }
            // Loopback always answers here; another private network only when this device is on it.
            val ip = if (c.ipv6) null else ipv4(c.address)
            if (c.local && !c.relay && ip != null && isPrivate4(ip) && subnets != null && subnets.none { inSubnet(c.address!!, it) }) {
                dropped += Dropped(c.uri, "other-subnet")
                continue
            }
            kept += c
        }
        fun first(c: PlexConnection) = if (c.uri == lastGood) 0 else if (secure(c)) 1 else 2
        fun order(list: List<PlexConnection>) = list.sortedBy(::first).map { it.uri }
        return Ranked(listOf(order(kept.filter { it.local && !it.relay }), order(kept.filter { !it.local && !it.relay }), order(kept.filter { it.relay })), dropped)
    }

    // This device's IPv4 networks, for the Docker-bridge filter.
    fun localSubnets(): List<String> = runCatching {
        NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp }.flatMap { i ->
            i.interfaceAddresses.filter { it.address is Inet4Address }.map { "${it.address.hostAddress}/${it.networkPrefixLength}" }
        }
    }.getOrDefault(emptyList())

    private sealed interface Event

    private class Tick(val wave: Int) : Event

    private class Done(val k: Int, val result: Result<Any?>) : Event

    // Races the waves: each starts after its delay, or at once when every probe started so far has failed, but rank
    // decides, not speed. An answer wins only once every better-ranked candidate (in its wave and every earlier one)
    // has failed: lastGood, then https, beat a faster plain http, and a local address still pending holds back
    // remote and relay answers (the desktop's LAN-first fix, §1.3: a user at home never goes through the capped relay
    // or the remote Plex Pass rule). Probes run detached: a blocking call that ignores cancellation never holds up
    // the answer. Throws IOException when all fail.
    @Suppress("UNCHECKED_CAST")
    suspend fun <T> raceWaves(waves: List<List<String>>, delays: List<Long> = WAVE_DELAYS_MS, probe: suspend (String) -> T): Pair<String, T> {
        val flat = waves.flatten()
        if (flat.isEmpty()) throw IOException("no candidate")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val events = Channel<Event>(Channel.UNLIMITED)
        val answered = HashMap<Int, Any?>()
        val failed = HashSet<Int>()
        var started = 0
        var next = 0
        fun start(i: Int) {
            while (next <= i && next < waves.size) {
                for (uri in waves[next]) {
                    val k = started++
                    scope.launch { events.send(Done(k, runCatching { probe(uri) })) }
                }
                next++
            }
        }
        try {
            waves.indices.forEach { i -> scope.launch { delay(delays.getOrElse(i) { delays.lastOrNull() ?: 0L }); events.send(Tick(i)) } }
            while (true) {
                when (val e = events.receive()) {
                    is Tick -> if (e.wave >= next) start(e.wave)
                    is Done -> e.result.fold({ answered[e.k] = it }, { failed += e.k })
                }
                while (true) {
                    if (failed.size == flat.size) throw IOException("unreachable")
                    var best = 0
                    while (best < started && best in failed) best++
                    if (best < started) {
                        if (best in answered) return flat[best] to answered[best] as T
                        break
                    }
                    // Everything started so far failed: the next wave starts now (an empty wave has nothing to fail).
                    if (next < waves.size) start(next) else break
                }
            }
        } finally {
            scope.cancel()
        }
    }
}
