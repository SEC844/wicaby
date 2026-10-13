package com.wika.wicaby.core.torrents

import androidx.annotation.StringRes
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import okhttp3.FormBody
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.defaultPort
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

// The message is resolved on read, in the UI language; server-sent text is kept as is.
class QbitException private constructor(
    @StringRes private val res: Int,
    private val args: Array<out Any>,
    private val raw: String?,
    val kind: Kind,
    val code: Int,
) : IOException() {
    constructor(@StringRes res: Int, kind: Kind, code: Int = 0, vararg args: Any) : this(res, args, null, kind, code)
    constructor(message: String, kind: Kind, code: Int = 0) : this(0, emptyArray(), message, kind, code)

    override val message: String get() = raw ?: Core.str(res, *args)

    enum class Kind { BadUrl, Auth, Banned, Network, Server }
}

// Options for torrents/add. `paused` is sent as both "paused" (4.x) and "stopped" (5.x).
data class AddOptions(val category: String? = null, val savePath: String? = null, val paused: Boolean = false)

// "192.168.1.5:8080", "nas/qbit" or "https://…/qbittorrent/" -> base URL ending with "/".
fun normalizeQbitUrl(input: String): HttpUrl? {
    val t = input.trim().trimEnd('/')
    if (t.isEmpty()) return null
    val withScheme = if (t.contains("://")) t else "http://$t"
    val url = withScheme.toHttpUrlOrNull() ?: return null
    if (url.scheme != "http" && url.scheme != "https") return null
    return url.newBuilder().query(null).fragment(null).encodedPath(url.encodedPath.trimEnd('/') + "/").build()
}

// qBittorrent 5.0 (Web API 2.11) renamed torrents/pause|resume to stop|start.
fun usesStopStart(appVersion: String?, webApiVersion: String? = null): Boolean? {
    fun parts(v: String?) = v?.trim()?.removePrefix("v")?.split('.', '-', ' ')?.mapNotNull { it.toIntOrNull() }?.takeIf { it.isNotEmpty() }
    parts(appVersion)?.let { return it[0] >= 5 }
    parts(webApiVersion)?.let { v -> val minor = v.getOrElse(1) { 0 }; return v[0] > 2 || (v[0] == 2 && minor >= 11) }
    return null
}

// qBittorrent Web API v2 client; mirrors the desktop src/main/torrents/qbittorrent.ts. Auth is a session cookie (SID, or QBT_SID_<port> on newer
// builds): every cookie from auth/login is replayed. Referer and Origin are set on every call
// (the WebUI's CSRF protection rejects requests without a matching one). A 403 means the
// session expired: log in again once and retry.
class QbitClient(
    baseUrl: String,
    private val username: String,
    private val password: String,
    http: OkHttpClient = Core.http,
) {
    val base: HttpUrl = normalizeQbitUrl(baseUrl) ?: throw QbitException(R.string.qbit_bad_url, QbitException.Kind.BadUrl)

    private val http: OkHttpClient = http.newBuilder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .callTimeout(20, TimeUnit.SECONDS)
        // qBittorrent's CSRF check compares Referer/Origin with the Host it receives. Through the mesh forwarder
        // (Core.transport rewrites the URL to 127.0.0.1) that Host is still the configured one (the forwarder
        // sets it), so the headers always name [base], never the loopback forwarder.
        .addNetworkInterceptor { chain ->
            val url = base
            val port = if (url.port == defaultPort(url.scheme)) "" else ":${url.port}"
            val origin = "${url.scheme}://${url.host}$port"
            chain.proceed(
                chain.request().newBuilder()
                    .header("Referer", "$origin${base.encodedPath}")
                    .header("Origin", origin)
                    .build(),
            )
        }
        .build()

    private val authLock = Mutex()

    @Volatile private var cookie: String? = null

    @Volatile private var authed = false

    @Volatile private var stopStart: Boolean? = null

    @Volatile var appVersion: String? = null
        private set

    // ---------------------------------------------------------------- auth

    suspend fun login() = authLock.withLock { loginLocked() }

    private suspend fun loginLocked() = withContext(Dispatchers.IO) {
        val body = FormBody.Builder().add("username", username).add("password", password).build()
        val req = Request.Builder().url(base.resolve("api/v2/auth/login")!!).post(body).build()
        val res = try {
            http.newCall(req).execute()
        } catch (e: IOException) {
            throw QbitException(R.string.qbit_unreachable, QbitException.Kind.Network)
        }
        res.use { r ->
            when {
                r.code == 403 -> throw QbitException(R.string.qbit_banned, QbitException.Kind.Banned, 403)
                r.code == 401 -> throw QbitException(R.string.qbit_wrong_credentials, QbitException.Kind.Auth, 401)
                r.code == 404 -> throw QbitException(R.string.qbit_not_webui, QbitException.Kind.Server, 404)
                !r.isSuccessful -> throw QbitException(R.string.qbit_http_error, QbitException.Kind.Server, r.code, r.code)
            }
            val text = r.body.string().trim()
            val cookies = r.headers("Set-Cookie").map { it.substringBefore(';').trim() }.filter { '=' in it }
            // "Fails." on bad credentials. "Ok." without a cookie: auth bypass (localhost/whitelist).
            if (text.startsWith("Fails", ignoreCase = true) || (text != "Ok." && cookies.isEmpty())) {
                throw QbitException(R.string.qbit_wrong_credentials, QbitException.Kind.Auth, r.code)
            }
            if (cookies.isNotEmpty()) cookie = cookies.joinToString("; ")
            authed = true
        }
    }

    suspend fun logout() {
        runCatching { call("auth/logout", FormBody.Builder().build(), retry = false) }
        cookie = null
        authed = false
    }

    // ---------------------------------------------------------------- transport

    private suspend fun call(path: String, body: RequestBody? = null, query: Map<String, String> = emptyMap(), retry: Boolean = true): String {
        if (!authed && username.isNotEmpty()) authLock.withLock { if (!authed) loginLocked() }
        val sent = cookie
        val (code, text) = send(path, body, query)
        if (code == 403 && retry) {
            // Expired or missing session: log in again (once, shared by concurrent callers).
            authLock.withLock { if (cookie == sent) loginLocked() }
            return call(path, body, query, retry = false)
        }
        when {
            code == 403 -> throw QbitException(R.string.qbit_session_refused, QbitException.Kind.Auth, 403)
            code == 404 -> throw QbitException(R.string.qbit_unsupported, QbitException.Kind.Server, 404)
            code == 409 && text.contains("queue", ignoreCase = true) -> throw QbitException(R.string.qbit_queue_disabled, QbitException.Kind.Server, 409)
            code == 409 -> throw QbitException(R.string.qbit_unknown_category, QbitException.Kind.Server, 409)
            code == 415 -> throw QbitException(R.string.qbit_bad_torrent_file, QbitException.Kind.Server, 415)
            code !in 200..299 -> throw text.trim().take(200).let { if (it.isBlank()) QbitException(R.string.qbit_http_error, QbitException.Kind.Server, code, code) else QbitException(it, QbitException.Kind.Server, code) }
        }
        return text
    }

    private suspend fun send(path: String, body: RequestBody?, query: Map<String, String>): Pair<Int, String> = withContext(Dispatchers.IO) {
        val url = base.resolve("api/v2/$path")!!.newBuilder().apply { query.forEach { (k, v) -> addQueryParameter(k, v) } }.build()
        val req = Request.Builder().url(url).apply {
            cookie?.let { header("Cookie", it) }
            if (body != null) post(body)
        }.build()
        try {
            http.newCall(req).execute().use { it.code to it.body.string() }
        } catch (e: IOException) {
            throw QbitException(R.string.qbit_unreachable, QbitException.Kind.Network)
        }
    }

    private fun form(vararg pairs: Pair<String, String>) = FormBody.Builder().apply { pairs.forEach { (k, v) -> add(k, v) } }.build()

    private fun hashes(h: Collection<String>) = if (h.isEmpty()) "all" else h.joinToString("|")

    // ---------------------------------------------------------------- app

    // "v4.6.7" or "v5.0.2".
    suspend fun version(): String = call("app/version").trim().also { v ->
        appVersion = v
        usesStopStart(v)?.let { stopStart = it }
    }

    suspend fun webApiVersion(): String = call("app/webapiVersion").trim()

    private suspend fun stopStart(): Boolean {
        stopStart?.let { return it }
        val v = runCatching { version() }.getOrNull()
        val s = usesStopStart(v) ?: usesStopStart(null, runCatching { webApiVersion() }.getOrNull()) ?: false
        stopStart = s
        return s
    }

    // ---------------------------------------------------------------- sync

    suspend fun mainData(rid: Long): JsonObject =
        qbitJson.parseToJsonElement(call("sync/maindata", query = mapOf("rid" to rid.toString()))) as? JsonObject
            ?: throw QbitException(R.string.qbit_bad_response, QbitException.Kind.Server)

    // Polls once and merges into [previous]. Start from MainData() (rid 0 = full update).
    suspend fun sync(previous: MainData): MainData = previous.merge(mainData(previous.rid))

    // ---------------------------------------------------------------- torrents

    suspend fun torrents(filter: String? = null, category: String? = null): List<Torrent> {
        val q = buildMap {
            filter?.let { put("filter", it) }
            category?.let { put("category", it) }
        }
        return qbitJson.decodeFromString(call("torrents/info", query = q))
    }

    // Magnet links and http(s) URLs to .torrent files; one per line is fine too.
    suspend fun addUrls(urls: List<String>, options: AddOptions = AddOptions()) {
        val list = urls.flatMap { it.lines() }.map { it.trim() }.filter { it.isNotEmpty() }
        require(list.isNotEmpty()) { "no url" }
        add(MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("urls", list.joinToString("\n")), options)
    }

    suspend fun addFile(fileName: String, bytes: ByteArray, options: AddOptions = AddOptions()) {
        val part = bytes.toRequestBody("application/x-bittorrent".toMediaType())
        add(MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("torrents", fileName.ifBlank { "file.torrent" }, part), options)
    }

    private suspend fun add(b: MultipartBody.Builder, o: AddOptions) {
        o.category?.takeIf { it.isNotEmpty() }?.let { b.addFormDataPart("category", it) }
        o.savePath?.takeIf { it.isNotEmpty() }?.let { b.addFormDataPart("savepath", it) }
        if (o.paused) {
            b.addFormDataPart("paused", "true")
            b.addFormDataPart("stopped", "true")
        }
        val text = call("torrents/add", b.build()).trim()
        if (text.startsWith("Fails", ignoreCase = true)) throw QbitException(R.string.qbit_torrent_refused, QbitException.Kind.Server)
    }

    // Empty = all torrents.
    suspend fun pause(hashes: Collection<String>) = toggle(hashes, pause = true)

    suspend fun resume(hashes: Collection<String>) = toggle(hashes, pause = false)

    private suspend fun toggle(hashes: Collection<String>, pause: Boolean) {
        val modern = stopStart()
        val body = form("hashes" to hashes(hashes))
        try {
            call(endpoint(modern, pause), body)
        } catch (e: QbitException) {
            // Version guess was wrong (custom build, proxy hiding app/version): try the other name.
            if (e.code != 404) throw e
            call(endpoint(!modern, pause), body)
            stopStart = !modern
        }
    }

    private fun endpoint(modern: Boolean, pause: Boolean) = when {
        modern && pause -> "torrents/stop"
        modern -> "torrents/start"
        pause -> "torrents/pause"
        else -> "torrents/resume"
    }

    suspend fun remove(hashes: Collection<String>, deleteFiles: Boolean) {
        call("torrents/delete", form("hashes" to hashes(hashes), "deleteFiles" to deleteFiles.toString()))
    }

    suspend fun recheck(hashes: Collection<String>) {
        call("torrents/recheck", form("hashes" to hashes(hashes)))
    }

    // ---------------------------------------------------------------- categories

    suspend fun categories(): Map<String, Category> {
        val o = qbitJson.parseToJsonElement(call("torrents/categories")) as? JsonObject ?: return emptyMap()
        return o.mapValues { (name, v) ->
            runCatching { qbitJson.decodeFromJsonElement<Category>(v) }.getOrDefault(Category()).let { if (it.name.isEmpty()) it.copy(name = name) else it }
        }
    }

    // "" removes the category.
    suspend fun setCategory(hashes: Collection<String>, category: String) {
        call("torrents/setCategory", form("hashes" to hashes(hashes), "category" to category))
    }

    suspend fun createCategory(name: String, savePath: String = "") {
        call("torrents/createCategory", form("category" to name, "savePath" to savePath))
    }

    // ---------------------------------------------------------------- transfer

    suspend fun transferInfo(): TransferInfo = qbitJson.decodeFromString(call("transfer/info"))

    suspend fun altSpeedEnabled(): Boolean = call("transfer/speedLimitsMode").trim() == "1"

    suspend fun toggleAltSpeed() {
        call("transfer/toggleSpeedLimitsMode", form())
    }
}
