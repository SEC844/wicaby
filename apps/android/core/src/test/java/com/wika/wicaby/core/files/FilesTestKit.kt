package com.wika.wicaby.core.files

import java.io.File
import java.security.KeyFactory
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext

// Shared by the file-source tests: an in-memory backend, temp stores and the mock's TEST ONLY TLS pairs.
internal object FilesTestKit {
    fun resource(path: String): ByteArray = checkNotNull(javaClass.getResourceAsStream(path)) { "missing $path" }.readBytes()

    fun cert(n: Int): X509Certificate =
        CertificateFactory.getInstance("X.509").generateCertificate(resource("/webdav-tls/cert$n.pem").inputStream()) as X509Certificate

    // A server-side SSLContext serving pair [n] (MockWebServer.useHttps).
    fun serverTls(n: Int): SSLContext {
        val pem = resource("/webdav-tls/key$n.pem").decodeToString()
        val der = java.util.Base64.getMimeDecoder().decode(pem.substringAfter("-----BEGIN PRIVATE KEY-----").substringBefore("-----END PRIVATE KEY-----"))
        val key = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(der))
        val ks = KeyStore.getInstance("PKCS12").apply { load(null, null); setKeyEntry("k", key, CharArray(0), arrayOf(cert(n))) }
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(ks, CharArray(0)) }
        return SSLContext.getInstance("TLS").apply { init(kmf.keyManagers, null, null) }
    }

    fun tempDir(): File = kotlin.io.path.createTempDirectory("wicaby-files-test").toFile()

    // A folder tree in memory: rel -> entries; reads count, uri is "mem://<rel>".
    class MemoryBackend(private val tree: Map<String, List<FileEntry>>, private val files: Map<String, ByteArray> = emptyMap()) : FileBackend {
        var lists = 0
        var offline = false

        override suspend fun list(rel: String): List<FileEntry> {
            if (offline) throw FileError(FileError.Kind.OFFLINE)
            lists++
            return tree[rel] ?: throw FileError(FileError.Kind.NOT_FOUND)
        }

        override fun uri(rel: String, entry: FileEntry?) = "mem://$rel"

        override suspend fun read(rel: String, entry: FileEntry?, maxBytes: Int): ByteArray = (files[rel] ?: throw FileError(FileError.Kind.NOT_FOUND)).let { it.copyOf(minOf(it.size, maxBytes)) }
    }

    fun file(name: String, size: Long = 1_000, mtimeMs: Long = 1_700_000_000_000) = FileEntry(name, false, size, mtimeMs)

    fun dir(name: String) = FileEntry(name, true, 0, 1_700_000_000_000)

    fun source(url: String = "https://dav.example/media", protocol: String = FileSource.WEBDAV, tls: TlsPolicy? = null) =
        FileSource("0123456789abcdef0123456789abcdef", "Media", protocol, url, tls)
}
