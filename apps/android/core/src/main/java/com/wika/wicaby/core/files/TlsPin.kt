package com.wika.wicaby.core.files

import java.net.InetSocketAddress
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

// File sources §7.3: a self-signed WebDAV server is trusted only by the SHA-256 of its leaf certificate, for that one
// source, after the user saw it. The check runs inside the TLS handshake, so a changed certificate fails before any
// request (and the password) is written. There is no "accept every certificate" switch.
object TlsPin {
    data class CertInfo(val subject: String, val issuer: String, val notBefore: Long, val notAfter: Long, val sha256: String) {
        // "AB:CD:…" as the prompt shows it.
        val fingerprint get() = sha256.uppercase().chunked(2).joinToString(":")
    }

    fun sha256(cert: X509Certificate): String = MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }

    fun info(cert: X509Certificate) = CertInfo(cert.subjectX500Principal.name, cert.issuerX500Principal.name, cert.notBefore.time, cert.notAfter.time, sha256(cert))

    class PinTrustManager(private val pin: String) : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException("client certificates are not used")

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val leaf = chain?.firstOrNull() ?: throw CertificateException("no certificate")
            if (!sha256(leaf).equals(pin, ignoreCase = true)) throw CertificateException("FILES-PIN-MISMATCH")
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    fun context(tm: X509TrustManager): SSLContext = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }

    // The leaf certificate [host]:[port] presents, read from a handshake alone (no HTTP request is sent), for the
    // "Trust this certificate for this source only" prompt. null when nothing answers.
    fun probe(host: String, port: Int, timeoutMs: Int = 5_000): CertInfo? {
        var leaf: X509Certificate? = null
        val capture = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = throw CertificateException()
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                leaf = chain?.firstOrNull()
                // Refused here too: the handshake never completes, so nothing can be sent on it.
                throw CertificateException("probe only")
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        return runCatching {
            java.net.Socket().use { raw ->
                raw.connect(InetSocketAddress(host, port), timeoutMs)
                raw.soTimeout = timeoutMs
                // Layered with the host name, so the server picks the certificate it would serve (SNI).
                (context(capture).socketFactory.createSocket(raw, host, port, true) as SSLSocket).use { runCatching { it.startHandshake() } }
            }
            leaf?.let(::info)
        }.getOrNull()
    }
}
