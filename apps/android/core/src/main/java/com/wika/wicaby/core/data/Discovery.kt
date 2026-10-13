package com.wika.wicaby.core.data

import android.content.Context
import android.net.wifi.WifiManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException

data class Found(val id: String, val name: String, val address: String)

@Serializable
private data class Reply(val id: String? = null, val name: String? = null, val address: String? = null)

// UDP 7359 discovery, the same probe Emby Theater and the Jellyfin clients send.
suspend fun discover(context: Context, timeoutMs: Long = 2500): List<Found> = withContext(Dispatchers.IO) {
    val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    val lock = wifi?.createMulticastLock("wicaby-discovery")?.apply { setReferenceCounted(false); runCatching { acquire() } }
    val found = LinkedHashMap<String, Found>()
    try {
        DatagramSocket().use { socket ->
            socket.broadcast = true
            socket.soTimeout = 300
            val targets = buildSet {
                add(InetAddress.getByName("255.255.255.255"))
                runCatching {
                    for (nif in NetworkInterface.getNetworkInterfaces()) {
                        if (!nif.isUp || nif.isLoopback) continue
                        nif.interfaceAddresses.mapNotNullTo(this) { it.broadcast }
                    }
                }
            }
            for (msg in listOf("who is EmbyServer? | emby", "who is JellyfinServer?")) {
                val bytes = msg.toByteArray()
                for (t in targets) runCatching { socket.send(DatagramPacket(bytes, bytes.size, t, 7359)) }
            }
            val deadline = System.currentTimeMillis() + timeoutMs
            val buf = ByteArray(4096)
            while (System.currentTimeMillis() < deadline) {
                val packet = DatagramPacket(buf, buf.size)
                try {
                    socket.receive(packet)
                } catch (_: SocketTimeoutException) {
                    continue
                }
                val r = runCatching { json.decodeFromString<Reply>(String(packet.data, 0, packet.length)) }.getOrNull() ?: continue
                if (r.id != null && r.address != null) found[r.id] = Found(r.id, r.name ?: r.address, r.address.trimEnd('/'))
            }
        }
    } finally {
        runCatching { lock?.release() }
    }
    found.values.toList()
}
