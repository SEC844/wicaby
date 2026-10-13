package com.wika.wicaby.core.net

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.wika.wicaby.core.Core
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.InetAddress

// Android 17 (API 37) blocks every LAN TCP and UDP socket of an app that targets 37 until the
// user grants ACCESS_LOCAL_NETWORK: OkHttp to a LAN server times out, discovery gets EPERM.
// Remote servers (https on the internet, mesh forwarders on loopback) are not affected.
object LocalNetwork {
    const val PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"

    // Older releases do not know the permission (checkSelfPermission would say denied) and allow the LAN.
    fun granted(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < 37 || ctx.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED

    // Request it with ActivityResultContracts.RequestPermission() and PERMISSION: the result says
    // whether it was refused (a second refusal is permanent and shows no dialog any more).

    // Wicaby's page in the system settings, where a refused permission can still be turned on.
    fun openSettings(ctx: Context) {
        val tries = listOf(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null)),
            Intent(Settings.ACTION_SETTINGS),
        )
        for (i in tries) {
            try {
                ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return
            } catch (_: ActivityNotFoundException) {
            } catch (_: SecurityException) {
            }
        }
    }

    // RFC 1918, link-local (169.254/16, fe80::/10) and unique-local (fc00::/7) IP literals.
    // Loopback (mesh forwarders), 100.64/10 (Tailscale, NetBird) and names are not LAN addresses.
    fun isLanAddress(ip: String): Boolean {
        val s = ip.trim().removePrefix("[").substringBefore('%').removeSuffix("]")
        val literal = s.matches(Regex("""\d{1,3}(\.\d{1,3}){3}""")) || (':' in s && s.all { it.isLetterOrDigit() || it == ':' || it == '.' })
        if (!literal) return false
        // A literal never triggers a DNS lookup.
        val b = runCatching { InetAddress.getByName(s).address }.getOrNull() ?: return false
        val b0 = b[0].toInt() and 0xff
        val b1 = b[1].toInt() and 0xff
        return if (b.size == 4) {
            b0 == 10 || (b0 == 172 && b1 in 16..31) || (b0 == 192 && b1 == 168) || (b0 == 169 && b1 == 254)
        } else {
            (b0 and 0xfe) == 0xfc || (b0 == 0xfe && (b1 and 0xc0) == 0x80)
        }
    }

    // Whether reaching [host] needs the permission. Single-label and .local names are mDNS or
    // LAN DNS names; other names count by what DNS answers (port 53 stays open on Android 17).
    internal fun isLanHost(host: String, resolve: (String) -> List<String>): Boolean = when {
        isLanAddress(host) -> true
        host.firstOrNull()?.isDigit() == true && host.all { it.isDigit() || it == '.' } -> false
        ':' in host -> false
        '.' !in host.trimEnd('.') || host.trimEnd('.').endsWith(".local", ignoreCase = true) -> true
        else -> runCatching { resolve(host) }.getOrDefault(emptyList()).any(::isLanAddress)
    }

    // A server address ("192.168.1.5", "nas:8096", "https://media.example.org/emby", as typed or
    // stored) that sits on the LAN and is not reached through a mesh forwarder.
    suspend fun isLanServer(address: String): Boolean = withContext(Dispatchers.IO) {
        val url = (if ("://" in address) address else "http://${address.trim()}").toHttpUrlOrNull() ?: return@withContext false
        if (Core.transport.forward(origin(url)) != null) return@withContext false
        isLanHost(url.host) { name -> InetAddress.getAllByName(name).mapNotNull { it.hostAddress } }
    }

    // What the setup and start screens check before a connection: false on Android 16 and older.
    suspend fun blocks(ctx: Context, address: String): Boolean = !granted(ctx) && isLanServer(address)
}
