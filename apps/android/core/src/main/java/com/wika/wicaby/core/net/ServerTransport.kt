package com.wika.wicaby.core.net

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException

// The seam for an embedded mesh VPN (Tailscale/NetBird via the vpn-helper gomobile AAR):
// a server that is only reachable on the mesh is reached through a local forwarder
// such as http://127.0.0.1:41234/<token>. Everything that talks to a server goes through
// Core.http (API, artwork, ExoPlayer via OkHttpDataSource, downloads), so swapping
// Core.transport is enough; the stored server address never changes.
interface ServerTransport {
    // Base URL to use instead of [origin] ("scheme://host:port"), or null to connect directly.
    // Called on OkHttp threads for every request: cache forwarders, it may block briefly.
    fun forward(origin: String): String?

    // A call to [origin] failed to connect or read (not cancelled): AddressSwitch picks an address again.
    fun failed(origin: String) {}

    companion object {
        val Direct = object : ServerTransport {
            override fun forward(origin: String): String? = null
        }
    }
}

// "http://h:8096/emby/x?y" on base "http://127.0.0.1:4000/tok" -> "http://127.0.0.1:4000/tok/emby/x?y".
fun rewrite(url: HttpUrl, base: String): HttpUrl {
    val b = base.trimEnd('/').toHttpUrl()
    val prefix = b.encodedPath.trimEnd('/')
    return url.newBuilder()
        .scheme(b.scheme)
        .host(b.host)
        .port(b.port)
        .encodedPath(prefix + url.encodedPath)
        .build()
}

fun origin(url: HttpUrl): String = "${url.scheme}://${url.host}:${url.port}"

// An application interceptor: redirects that point back at the real host are not rewritten
// (OkHttp forbids host changes in network interceptors); Emby and Jellyfin send relative ones.
class TransportInterceptor(private val transport: () -> ServerTransport) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val t = transport()
        val o = origin(req.url)
        // An address probe goes to the address it names, not to the one AddressSwitch uses for that server.
        val probe = req.tag(AsAddressed::class.java) != null
        val base = (if (probe && t is AddressSwitch) t.inner else t).forward(o)
        return try {
            chain.proceed(if (base == null) req else req.newBuilder().url(rewrite(req.url, base)).build())
        } catch (e: IOException) {
            if (!probe && !chain.call().isCanceled()) t.failed(o)
            throw e
        }
    }
}
