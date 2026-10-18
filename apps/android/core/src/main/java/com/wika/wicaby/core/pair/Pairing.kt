package com.wika.wicaby.core.pair

import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.json
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.security.SecureRandom

// TV sign-in from the phone, Emby included (it has no Quick Connect): the TV shows
// http://<lan-ip>:<port>/wicaby/pair?t=<token> as a QR code, the signed-in phone scans it and
// POSTs its server address, user id and access token there; the TV checks the token against
// the server and signs in with it.
const val PAIR_PATH = "/wicaby/pair"
const val PAIR_TTL_MS = 5 * 60_000L

// The pair POST is cleartext LAN HTTP: only kinds whose token is a revocable session may use it.
// Navidrome's "token" is the account password itself; Plex links the TV's own account instead.
fun pairable(kind: String): Boolean = kind != "plex" && kind != "navidrome"

@Serializable
data class PairRequest(val token: String, val server: String, val userId: String, val accessToken: String) {
    override fun toString() = "PairRequest(server=$server, userId=$userId, <secrets redacted>)"
}

// 128 random bits, valid 5 minutes, good for one sign-in.
class PairToken(random: SecureRandom = SecureRandom(), private val now: () -> Long = System::currentTimeMillis) {
    val value: String = ByteArray(16).also(random::nextBytes).joinToString("") { "%02x".format(it) }
    private val expiresAt = now() + PAIR_TTL_MS
    private var used = false

    val expired get() = now() >= expiresAt

    // The first matching try spends it, whatever the sign-in then gives. Constant-time compare.
    @Synchronized
    fun consume(candidate: String): Boolean {
        if (used || expired) return false
        if (!MessageDigest.isEqual(value.toByteArray(), candidate.toByteArray())) return false
        used = true
        return true
    }
}

// Private (RFC 1918), link-local and IPv6 unique-local addresses: what a home network uses.
fun isLanAddress(a: InetAddress): Boolean =
    a.isSiteLocalAddress || a.isLinkLocalAddress || (a is Inet6Address && (a.address[0].toInt() and 0xfe) == 0xfc)

private val IPV4 = Regex("""\d{1,3}(\.\d{1,3}){3}""")
private val TOKEN = Regex("[0-9a-f]{32}")

// The phone side: a scanned text is a pairing target only as http to a LAN IPv4 literal (a host
// name could resolve anywhere) on our path, with a well-formed token.
class PairTarget(val url: String, val host: String, val token: String)

fun parsePairUrl(text: String): PairTarget? {
    val u = text.trim().toHttpUrlOrNull() ?: return null
    if (u.scheme != "http" || u.encodedPath != PAIR_PATH || !IPV4.matches(u.host)) return null
    val token = u.queryParameter("t")?.takeIf { TOKEN.matches(it) } ?: return null
    val addr = runCatching { InetAddress.getByName(u.host) }.getOrNull() ?: return null
    if (!isLanAddress(addr)) return null
    return PairTarget(u.newBuilder().query(null).build().toString(), u.host, token)
}

// Sends this device's session to the TV; true once the TV has signed in with it.
suspend fun sendPair(target: PairTarget, server: String, userId: String, accessToken: String): Boolean = withContext(Dispatchers.IO) {
    val body = json.encodeToString(PairRequest.serializer(), PairRequest(target.token, server, userId, accessToken))
    val req = Request.Builder().url(target.url).post(body.toRequestBody("application/json".toMediaType())).build()
    Core.http.newCall(req).execute().use { it.isSuccessful }
}

internal class HttpRequest(val method: String, val path: String, val body: String)

// Just enough HTTP/1.1 for one small POST: request line, headers, a Content-Length body.
// Null for anything malformed, over the limits or not complete by [deadline] (epoch ms): a peer
// trickling bytes must not hold the one-at-a-time server.
internal fun readRequest(input: InputStream, deadline: Long = Long.MAX_VALUE, maxHead: Int = 8192, maxBody: Int = 4096): HttpRequest? {
    val late = { System.currentTimeMillis() >= deadline }
    val head = StringBuilder()
    while (!head.endsWith("\r\n\r\n")) {
        val b = input.read()
        if (b < 0 || head.length >= maxHead || late()) return null
        head.append(b.toChar())
    }
    val lines = head.trim().split("\r\n")
    val parts = lines.first().split(' ')
    if (parts.size != 3) return null
    val length = lines.drop(1).firstOrNull { it.substringBefore(':').trim().equals("Content-Length", true) }
        ?.substringAfter(':')?.trim()?.toIntOrNull() ?: 0
    if (length !in 0..maxBody) return null
    val body = ByteArray(length)
    var read = 0
    while (read < length) {
        val n = input.read(body, read, length - read)
        if (n < 0 || late()) return null
        read += n
    }
    return HttpRequest(parts[0], parts[1].substringBefore('?'), String(body, Charsets.UTF_8))
}

// The TV side: a one-shot endpoint bound to [bind] (the TV's LAN address) on a free port. It takes
// POST PAIR_PATH from LAN peers only, and closes after the token is spent (whatever [signIn]
// returns), on expiry, or on close().
class PairServer(bind: Inet4Address, val token: PairToken = PairToken(), private val signIn: suspend (PairRequest) -> Boolean) : Closeable {
    private val socket = ServerSocket(0, 4, bind)
    @Volatile private var current: Socket? = null
    val url = "http://${bind.hostAddress}:${socket.localPort}$PAIR_PATH?t=${token.value}"

    // True when a phone signed the TV in; false on expiry, a refused sign-in or close().
    suspend fun run(): Boolean = coroutineScope {
        // A blocking accept or read ignores cancellation: closing the sockets ends it.
        val closer = launch(start = CoroutineStart.UNDISPATCHED) { try { awaitCancellation() } finally { close() } }
        try { serve() } finally { closer.cancel() }
    }

    private suspend fun serve(): Boolean = withContext(Dispatchers.IO) {
        socket.soTimeout = 1000 // wakes up to notice expiry and cancellation
        try {
            while (isActive && !token.expired) {
                val client = try { socket.accept() } catch (_: SocketTimeoutException) { continue }
                current = client
                val done = client.use { handle(it) }
                if (done != null) return@withContext done
            }
            false
        } catch (_: IOException) {
            false // closed
        } finally {
            socket.close()
        }
    }

    // Null: not a sign-in attempt, keep listening. Otherwise the token was spent.
    private suspend fun handle(c: Socket): Boolean? {
        c.soTimeout = 2000
        fun reply(code: Int, reason: String) =
            runCatching { c.getOutputStream().write("HTTP/1.1 $code $reason\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray()) }
        if (!isLanAddress(c.inetAddress)) return null.also { reply(403, "Forbidden") }
        val req = runCatching { readRequest(c.getInputStream(), System.currentTimeMillis() + 5000) }.getOrNull() ?: return null.also { reply(400, "Bad Request") }
        if (req.method != "POST" || req.path != PAIR_PATH) return null.also { reply(404, "Not Found") }
        val pair = runCatching { json.decodeFromString(PairRequest.serializer(), req.body) }.getOrNull()
            ?: return null.also { reply(400, "Bad Request") }
        if (!token.consume(pair.token)) return null.also { reply(403, "Forbidden") }
        val ok = runCatching { signIn(pair) }.getOrDefault(false)
        reply(if (ok) 200 else 401, if (ok) "OK" else "Unauthorized")
        return ok
    }

    override fun close() {
        socket.close()
        runCatching { current?.close() }
    }
}
