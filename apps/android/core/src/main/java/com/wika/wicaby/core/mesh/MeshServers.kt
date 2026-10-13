package com.wika.wicaby.core.mesh

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

data class PeerServer(val peer: MeshPeer, val server: Server)

/**
 * Emby/Jellyfin servers on the mesh (onboarding OB-C1): each online peer is probed on the default
 * ports through Core.http, so the mesh forwarder carries the requests. Only call it on an explicit
 * request ("Trouver les serveurs"): on a large network it costs a few seconds and some traffic.
 */
object MeshServers {
    const val PARALLEL = 16
    const val TIMEOUT_MS = 1500L

    // HTTPS (8920) is listed first and wins over HTTP (8096), as in Api.probe.
    fun addresses(peer: MeshPeer): List<String> {
        val host = peer.ips.firstOrNull { ':' !in it } ?: peer.ips.firstOrNull()?.let { "[$it]" } ?: return emptyList()
        return listOf("https://$host:8920", "http://$host:8096")
    }

    /** The online [peers] that answer as a media server, in [peers] order. */
    suspend fun find(peers: List<MeshPeer>, addresses: (MeshPeer) -> List<String> = ::addresses, timeoutMs: Long = TIMEOUT_MS): List<PeerServer> =
        coroutineScope {
            val gate = Semaphore(PARALLEL)
            peers.filter { it.online }.map { peer ->
                async {
                    val found = addresses(peer).map { a -> async { gate.withPermit { runCatching { Api.probeOne(a, timeoutMs) }.getOrNull() } } }.awaitAll()
                    found.firstOrNull { it != null }?.let { PeerServer(peer, it) }
                }
            }.awaitAll().filterNotNull()
        }
}
