package com.wika.wicaby.core.files

import com.wika.wicaby.core.files.pure.Ids
import com.wika.wicaby.core.files.pure.Propfind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

// SMB (spec §5.3, decision D7): the share is served by the Go gateway in the mesh library on 127.0.0.1, one random
// token per open share: GET <base>/ls/<rel> lists a folder as JSON, GET|HEAD <base>/f/<rel> serves a file with Range.
// Kotlin only ever speaks plain loopback HTTP; the password crosses once, into the gateway (OpenFiles).
class Gateway(
    source: FileSource,
    private val creds: FileCredentials?,
    private val http: OkHttpClient,
    private val opener: Opener = MeshOpener,
) : FileBackend {
    fun interface Opener {
        // The gateway's base URL (http://127.0.0.1:<port>/<token>), or a FileError.
        fun open(host: String, port: Int, share: String, user: String, pass: String, domain: String): String

        fun close(base: String) {}
    }

    @Serializable
    private data class Ls(val name: String, val dir: Boolean = false, val size: Long = 0, val mtime: Long = 0)

    private val target = SmbUrl.parse(source.url) ?: throw FileError(FileError.Kind.NOT_FOUND, "not an smb:// URL")
    private val gate = Gate()

    @Volatile
    private var base: String? = null

    @Synchronized
    private fun base(): String = base ?: opener.open(target.host, target.port, target.share, creds?.user.orEmpty(), creds?.pass.orEmpty(), creds?.domain.orEmpty())
        .trimEnd('/').also { base = it }

    // The path inside the share: the source's own sub folder, then [rel].
    private fun full(rel: String) = listOf(target.sub, rel).filter { it.isNotEmpty() }.joinToString("/")

    private fun path(rel: String) = full(rel).split('/').filter { it.isNotEmpty() }.joinToString("/") { Propfind.encode(it) }

    override fun uri(rel: String, entry: FileEntry?): String = "${base()}/f/${path(rel)}"

    override suspend fun list(rel: String): List<FileEntry> = gate.run {
        withContext(Dispatchers.IO) {
            get("${base()}/ls/${path(rel)}") { body ->
                filesJson.decodeFromString<List<Ls>>(body.decodeToString())
                    .filter { Ids.segmentOk(it.name) }
                    .map { FileEntry(it.name, it.dir, it.size, it.mtime * 1000) }
            }
        }
    }

    override suspend fun read(rel: String, entry: FileEntry?, maxBytes: Int): ByteArray = gate.run {
        withContext(Dispatchers.IO) {
            get(uri(rel, entry), "bytes=0-${maxBytes - 1}") { it.copyOf(minOf(it.size, maxBytes)) }
        }
    }

    private fun <T> get(url: String, range: String? = null, read: (ByteArray) -> T): T {
        val req = Request.Builder().url(url).apply { range?.let { header("Range", it) } }.build()
        val call = http.newCall(req)
        call.timeout().timeout(WebDav.LIST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        val res = try {
            call.execute()
        } catch (e: IOException) {
            throw FileError(FileError.Kind.OFFLINE, cause = e)
        }
        return res.use { r ->
            when (r.code) {
                in 200..299 -> read(r.body.bytes())
                // The gateway names the SMB failure in its body: auth, notfound, smb1, offline.
                else -> throw gatewayError(r.code, r.body.string())
            }
        }
    }

    override fun close() {
        base?.let { runCatching { opener.close(it) } }
        base = null
    }

    companion object {
        fun gatewayError(code: Int, body: String): FileError = when {
            body.startsWith("auth") -> FileError(FileError.Kind.AUTH)
            body.startsWith("smb1") -> FileError(FileError.Kind.SMB1)
            body.startsWith("offline") -> FileError(FileError.Kind.OFFLINE)
            body.startsWith("notfound") || code == 404 -> FileError(FileError.Kind.NOT_FOUND)
            else -> FileError(FileError.Kind.OTHER, "HTTP $code")
        }
    }
}

// smb://HOST/share[/sub/folder], as Urls.parse writes it (segments percent-encoded, port 445 only).
data class SmbUrl(val host: String, val port: Int, val share: String, val sub: String) {
    companion object {
        fun parse(url: String): SmbUrl? {
            val m = Regex("^smb://([^/@:]+|\\[[0-9A-Fa-f:.]+\\])/(.+)$").find(url) ?: return null
            val segs = m.groupValues[2].split('/').filter { it.isNotEmpty() }.map { Propfind.decode(it) ?: return null }
            val share = segs.firstOrNull() ?: return null
            val sub = segs.drop(1).joinToString("/")
            if (!Ids.segmentOk(share) || !Ids.guard(sub)) return null
            return SmbUrl(m.groupValues[1].removePrefix("[").removeSuffix("]"), 445, share, sub)
        }
    }
}

// The gomobile binding (packages/mesh/mobile OpenFiles/CloseFiles), looked up by name: a mesh AAR built before the
// gateway existed still links, and SMB then says it is not included in this build instead of crashing.
object MeshOpener : Gateway.Opener {
    private val cls by lazy { runCatching { Class.forName("com.wika.wicaby.mesh.mobile.Mobile") }.getOrNull() }

    override fun open(host: String, port: Int, share: String, user: String, pass: String, domain: String): String {
        if (android.os.Build.VERSION.SDK_INT < 26) throw FileError(FileError.Kind.UNAVAILABLE)
        val m = runCatching {
            cls!!.getMethod("openFiles", String::class.java, Long::class.javaPrimitiveType, String::class.java, String::class.java, String::class.java, String::class.java)
        }.getOrNull() ?: throw FileError(FileError.Kind.UNAVAILABLE)
        return try {
            m.invoke(null, host, port.toLong(), share, user, pass, domain) as String
        } catch (e: java.lang.reflect.InvocationTargetException) {
            throw Gateway.gatewayError(0, e.cause?.message.orEmpty())
        } catch (e: LinkageError) {
            throw FileError(FileError.Kind.UNAVAILABLE, cause = e)
        }
    }

    override fun close(base: String) {
        runCatching { cls?.getMethod("closeFiles", String::class.java)?.invoke(null, base) }
    }
}
