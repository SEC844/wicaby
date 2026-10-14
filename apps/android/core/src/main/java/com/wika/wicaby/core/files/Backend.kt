package com.wika.wicaby.core.files

import kotlinx.serialization.json.Json
import java.io.IOException

// The stores (sources.json, credentials.json, progress-<id>.json) and the gateway's JSON: plain camelCase, the desktop's
// shapes, not the PascalCase of core's server json.
internal val filesJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

// One entry of a folder listing. [uri]: the backend's own address for it when it cannot be rebuilt from the path
// (a SAF document); WebDAV and SMB rebuild it from the base and the path.
data class FileEntry(val name: String, val dir: Boolean, val size: Long, val mtimeMs: Long, val uri: String? = null)

// What every backend answers (spec §3.1): direct children, the playable address of a file, and a small read (NFO).
interface FileBackend {
    suspend fun list(rel: String): List<FileEntry>

    // A URI Media3 and Coil can open: https:// (through FileSources.calls), content://, or the loopback gateway.
    fun uri(rel: String, entry: FileEntry?): String

    suspend fun read(rel: String, entry: FileEntry?, maxBytes: Int): ByteArray

    // The file as a stream for [use] (photo thumbnails), asked from byte 0 up to [maxBytes] (the caller caps the reading
    // too). The real backends stream; this default (in-memory test backends) does not.
    suspend fun <T> open(rel: String, entry: FileEntry?, maxBytes: Int, use: (java.io.InputStream) -> T): T = use(read(rel, entry, maxBytes).inputStream())

    fun close() {}
}

// §8: the user-facing cases, each with its own message (files_error_*).
class FileError(val kind: Kind, message: String = kind.name, val cert: TlsPin.CertInfo? = null, cause: Throwable? = null) : IOException(message, cause) {
    enum class Kind { AUTH, NOT_FOUND, CERT_UNTRUSTED, CERT_CHANGED, DIGEST_ONLY, SMB1, OFFLINE, UNAVAILABLE, TOO_LARGE, OTHER }
}

// At most 4 requests at once per source (§7.6).
internal class Gate(n: Int = 4) {
    private val sem = kotlinx.coroutines.sync.Semaphore(n)
    suspend fun <T> run(block: suspend () -> T): T {
        sem.acquire()
        try {
            return block()
        } finally {
            sem.release()
        }
    }
}
