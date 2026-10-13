package com.wika.wicaby.core.files

import com.wika.wicaby.core.files.pure.Propfind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Credentials
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException

// Is [url] under [base] (same scheme, host and port, and inside its path)? The one rule for which requests get a
// source's password and which of them FileSources.calls routes to that source's client.
fun underBase(base: HttpUrl, url: HttpUrl): Boolean {
    if (base.scheme != url.scheme || base.host != url.host || base.port != url.port) return false
    val prefix = base.encodedPath.trimEnd('/')
    return prefix.isEmpty() || url.encodedPath == prefix || url.encodedPath.startsWith("$prefix/")
}

// Basic auth for the source's own origin and base path only (§5.2). Application level: it runs once per call, and
// OkHttp itself drops Authorization when a redirect leaves the host (RoutingTest locks both in).
class BasicAuth(private val base: HttpUrl, private val creds: FileCredentials) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        if (!underBase(base, req.url) || req.header("Authorization") != null) return chain.proceed(req)
        return chain.proceed(req.newBuilder().header("Authorization", Credentials.basic(creds.user, creds.pass, Charsets.UTF_8)).build())
    }
}

// One source's client: [shared] (Core.http: transport, per-hop credential rules) plus its password and, for a pinned
// source, a trust manager that accepts that one certificate. Never shared with other hosts (D8).
fun davClient(shared: OkHttpClient, source: FileSource, creds: FileCredentials?): OkHttpClient {
    val b = shared.newBuilder().connectTimeout(5, TimeUnit.SECONDS)
    if (creds != null) b.addInterceptor(BasicAuth(source.url.toHttpUrl(), creds))
    val tls = source.tls
    if (tls?.mode == TlsPolicy.PIN && tls.sha256 != null) {
        val tm = TlsPin.PinTrustManager(tls.sha256)
        // The pin replaces the CA and host name checks for this source only (§7.3).
        b.sslSocketFactory(TlsPin.context(tm).socketFactory, tm).hostnameVerifier { _, _ -> true }
    }
    return b.build()
}

class WebDav(private val source: FileSource, val client: OkHttpClient) : FileBackend {
    private val root = source.url.trimEnd('/') + "/"
    // What FileSources.calls matches a request against to pick [client].
    val base: HttpUrl = root.toHttpUrl()
    private val gate = Gate()

    override fun uri(rel: String, entry: FileEntry?): String = Propfind.url(root, rel, entry?.dir == true)

    override suspend fun list(rel: String): List<FileEntry> = gate.run {
        withContext(Dispatchers.IO) {
            val body = """<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"""
            val req = Request.Builder().url(Propfind.url(root, rel, true)).header("Depth", "1")
                .method("PROPFIND", body.toRequestBody("application/xml; charset=utf-8".toMediaType())).build()
            call(req, LIST_TIMEOUT_MS) { r ->
                val src = r.body.source()
                if (src.request(Propfind.MAX_BYTES + 1L)) throw FileError(FileError.Kind.TOO_LARGE)
                val listing = Propfind.parse(src.buffer.readUtf8(), root, rel)
                listing.entries.map { FileEntry(it.name, it.dir, it.size, it.mtime) }
            }
        }
    }

    override suspend fun read(rel: String, entry: FileEntry?, maxBytes: Int): ByteArray = gate.run {
        withContext(Dispatchers.IO) {
            call(Request.Builder().url(uri(rel, entry)).header("Range", "bytes=0-${maxBytes - 1}").build(), LIST_TIMEOUT_MS) { r ->
                val src = r.body.source()
                src.request(maxBytes.toLong())
                src.buffer.readByteArray(minOf(src.buffer.size, maxBytes.toLong()))
            }
        }
    }

    private fun <T> call(req: Request, timeoutMs: Long, read: (Response) -> T): T {
        val call = client.newCall(req)
        call.timeout().timeout(timeoutMs, TimeUnit.MILLISECONDS)
        val res = try {
            call.execute()
        } catch (e: IOException) {
            throw classify(e, source)
        }
        return res.use { r ->
            if (!r.isSuccessful) throw status(r)
            read(r)
        }
    }

    companion object {
        const val LIST_TIMEOUT_MS = 15_000L

        // 401 that offers Digest and no Basic: a clear "Digest only" instead of "wrong password" (§8).
        fun status(r: Response): FileError {
            val schemes = r.headers("WWW-Authenticate").map { it.trim().substringBefore(' ').lowercase() }
            return when (r.code) {
                401 -> if (schemes.isNotEmpty() && "basic" !in schemes && "digest" in schemes) FileError(FileError.Kind.DIGEST_ONLY) else FileError(FileError.Kind.AUTH)
                403 -> FileError(FileError.Kind.AUTH)
                404, 410 -> FileError(FileError.Kind.NOT_FOUND)
                else -> FileError(FileError.Kind.OTHER, "HTTP ${r.code}")
            }
        }

        // OkHttp throws the first route's failure with the others suppressed (a refused ::1 before the TLS failure on
        // 127.0.0.1): a certificate problem anywhere in there wins.
        private fun tls(e: Throwable): Boolean = generateSequence(e) { it.cause }.any { t ->
            t is SSLException || t is java.security.cert.CertificateException || t.suppressed.any(::tls)
        }

        fun classify(e: IOException, source: FileSource): IOException = when {
            e is FileError -> e
            tls(e) ->
                if (source.tls?.mode == TlsPolicy.PIN) FileError(FileError.Kind.CERT_CHANGED, cause = e) else FileError(FileError.Kind.CERT_UNTRUSTED, cause = e)
            e is UnknownHostException || e is ConnectException || e is InterruptedIOException -> FileError(FileError.Kind.OFFLINE, cause = e)
            else -> e
        }
    }
}
