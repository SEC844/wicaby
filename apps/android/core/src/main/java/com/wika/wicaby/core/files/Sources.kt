package com.wika.wicaby.core.files

import com.wika.wicaby.core.files.pure.Urls
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import java.io.File
import java.io.IOException
import java.security.SecureRandom

// File sources spec §2.1: a folder picked on this device (SAF), a WebDAV folder or an SMB share. [url] never holds a
// user name or a password: content://… (the persisted SAF tree), https://dav.example/media, smb://STORAGE/media/sub.
@Serializable
data class FileSource(
    val id: String,
    val name: String,
    val protocol: String,
    val url: String,
    val tls: TlsPolicy? = null,
    val hasCredentials: Boolean = false,
    val addedAt: Long = 0,
) {
    val isLocal get() = protocol == LOCAL
    val isWebDav get() = protocol == WEBDAV
    val isSmb get() = protocol == SMB

    // What the UI shows next to the name: "dav.example/media", "\\STORAGE\media"; never a user name (§7.2).
    val label: String get() = if (isLocal) "" else Urls.display(url)

    companion object {
        const val LOCAL = "local"
        const val WEBDAV = "webdav"
        const val SMB = "smb"

        // 32 lowercase hex, random: also the Server id the rest of the app keys this source by.
        fun newId(): String = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    }
}

// §7.3: verify (CA), pin (the leaf certificate's SHA-256, accepted by the user for this source only), or a plain
// http:// URL the user acknowledged.
@Serializable
data class TlsPolicy(val mode: String = VERIFY, val sha256: String? = null, val subject: String? = null, val notAfter: String? = null) {
    companion object {
        const val VERIFY = "verify"
        const val PIN = "pin"
        const val INSECURE_HTTP = "insecure-http"
    }
}

@Serializable
data class FileCredentials(val user: String, val pass: String, val domain: String? = null) {
    override fun toString() = "FileCredentials(user=<redacted>, pass=<redacted>)"
}

// The stored list (sources.json) and the credentials (credentials.json, each value sealed by [seal]: the Android
// Keystore key in the app, §7.1). A credential that no longer opens (Keystore reset) leaves its source in place,
// marked "sign in again" (needsSignIn); nothing is ever dropped silently.
class SourceStore(private val dir: File, private val seal: (String) -> String, private val open: (String) -> String?) {
    @Serializable
    private data class Stored(val sources: List<FileSource> = emptyList(), val showOnHome: Boolean = false)

    private val sourcesFile get() = File(dir, "sources.json")
    private val credsFile get() = File(dir, "credentials.json")
    private val credsCodec = MapSerializer(String.serializer(), String.serializer())

    @Synchronized
    private fun read(): Stored = runCatching { filesJson.decodeFromString(Stored.serializer(), sourcesFile.readText()) }.getOrDefault(Stored())

    @Synchronized
    private fun write(s: Stored) = writeAtomic(sourcesFile, filesJson.encodeToString(Stored.serializer(), s))

    private fun sealed(): Map<String, String> = runCatching { filesJson.decodeFromString(credsCodec, credsFile.readText()) }.getOrDefault(emptyMap())

    fun list(): List<FileSource> = read().sources

    val showOnHome: Boolean get() = read().showOnHome

    @Synchronized
    fun setShowOnHome(v: Boolean) = write(read().copy(showOnHome = v))

    @Synchronized
    fun add(source: FileSource, credentials: FileCredentials?) {
        setCredentials(source.id, credentials)
        write(read().let { s -> s.copy(sources = s.sources.filter { it.id != source.id } + source.copy(hasCredentials = credentials != null)) })
    }

    @Synchronized
    fun update(source: FileSource) = write(read().let { s -> s.copy(sources = s.sources.map { if (it.id == source.id) source else it }) })

    @Synchronized
    fun remove(id: String) {
        setCredentials(id, null)
        write(read().let { s -> s.copy(sources = s.sources.filter { it.id != id }) })
        progressFile(id).delete()
    }

    @Synchronized
    fun setCredentials(id: String, c: FileCredentials?) {
        val all = sealed().toMutableMap()
        if (c == null) all.remove(id) else all[id] = seal(filesJson.encodeToString(FileCredentials.serializer(), c))
        writeAtomic(credsFile, filesJson.encodeToString(credsCodec, all))
        if (c != null) write(read().let { s -> s.copy(sources = s.sources.map { if (it.id == id) it.copy(hasCredentials = true) else it }) })
    }

    // null: none stored. needsSignIn: stored but it no longer opens.
    fun credentials(id: String): FileCredentials? = sealed()[id]?.let(open)?.let { runCatching { filesJson.decodeFromString(FileCredentials.serializer(), it) }.getOrNull() }

    fun needsSignIn(source: FileSource): Boolean = source.hasCredentials && credentials(source.id) == null

    fun progressFile(id: String) = File(dir, "progress-$id.json")

    companion object {
        // A crash mid-write keeps the previous file (android.util.AtomicFile is not on the unit-test JVM).
        fun writeAtomic(f: File, text: String) {
            f.parentFile?.mkdirs()
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.writeText(text)
            if (!tmp.renameTo(f)) {
                f.delete()
                if (!tmp.renameTo(f)) throw IOException("cannot write ${f.name}")
            }
        }
    }
}
