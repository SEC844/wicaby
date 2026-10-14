package com.wika.wicaby.core.files

import android.content.Intent
import android.net.Uri
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Vault
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.Call
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.ConcurrentHashMap

// The file sources of this device (spec §2, §3.2): the stored list, one FilesApi per source, and the routing call
// factory that sends a WebDAV source's requests (player, images) through that source's own client.
object FileSources {
    private val store: SourceStore by lazy { SourceStore(File(Core.app.filesDir, "files"), Vault::encrypt, Vault::decrypt) }
    private val apis = ConcurrentHashMap<String, FilesApi>()
    private val _list = MutableStateFlow<List<FileSource>>(emptyList())
    // The file sources (Files); the photo sources live in [photos], their own photo libraries.
    val list: StateFlow<List<FileSource>> = _list
    private val _photos = MutableStateFlow<List<FileSource>>(emptyList())
    val photos: StateFlow<List<FileSource>> = _photos
    @Volatile
    private var every: List<FileSource> = emptyList()
    private val _showOnHome = MutableStateFlow(false)
    // Réglages > Accueil > "Show file sources on Home" (D10, off by default): their Continue items join Home's row.
    val showOnHome: StateFlow<Boolean> = _showOnHome

    @Volatile
    private var deviceId = ""

    // Core.init: the stored list, and Api.of() answering a file source's id with its FilesApi.
    fun init() {
        reload()
        Api.forKind = { server, device, _, _ -> if (server.isFiles) { deviceId = device; api(server.id) } else null }
    }

    private fun reload() {
        every = store.list()
        _list.value = every.filterNot { it.photos }
        _photos.value = every.filter { it.photos }
        _showOnHome.value = store.showOnHome
    }

    fun source(id: String?): FileSource? = every.firstOrNull { it.id == id }

    fun api(id: String?): FilesApi? {
        val s = source(id) ?: return null
        apis[s.id]?.takeIf { it.source == s }?.let { return it }
        val backend = backend(s, store.credentials(s.id))
        val index = if (s.photos) PhotoIndex(backend, store.photoIndexFile(s.id)) else null
        return FilesApi(s, backend, FileProgress(store.progressFile(s.id)), deviceId, photos = index).also { apis.put(s.id, it)?.let(::release) }
    }

    private fun release(a: FilesApi) {
        a.backend.close()
        a.photos?.close()
    }

    fun all(): List<FilesApi> = _list.value.mapNotNull { api(it.id) }

    fun photoApis(): List<FilesApi> = _photos.value.mapNotNull { api(it.id) }

    // Home's Continue row: only with the setting on (caps homeOptIn).
    fun forHome(): List<Api> = if (_showOnHome.value) all() else emptyList()

    fun needsSignIn(s: FileSource) = store.needsSignIn(s)

    fun backend(s: FileSource, creds: FileCredentials?): FileBackend = when (s.protocol) {
        FileSource.LOCAL -> LocalSaf(Core.app, s)
        FileSource.WEBDAV -> WebDav(s, davClient(Core.http, s, creds))
        else -> Gateway(s, creds, Core.http)
    }

    // The Add sheet's Test (§6.1): the number of entries at the root, or a FileError (an untrusted or changed
    // certificate carries the leaf certificate the server presents, for the pin prompt).
    suspend fun test(s: FileSource, creds: FileCredentials?): Int {
        val b = backend(s, creds)
        try {
            return b.list("").size
        } catch (e: FileError) {
            if (e.kind != FileError.Kind.CERT_UNTRUSTED && e.kind != FileError.Kind.CERT_CHANGED) throw e
            if (s.url.toHttpUrlOrNull() == null) throw e
            throw FileError(e.kind, e.message.orEmpty(), presented(s), e)
        } finally {
            b.close()
        }
    }

    fun add(s: FileSource, creds: FileCredentials?) {
        store.add(s, creds)
        reload()
    }

    fun update(s: FileSource) {
        store.update(s)
        reload()
    }

    // §7.3: the leaf certificate a WebDAV source presents now (null when it cannot be read), for the pin prompt and
    // the "certificate changed" screen.
    suspend fun presented(s: FileSource): TlsPin.CertInfo? {
        val u = s.url.toHttpUrlOrNull() ?: return null
        return kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { TlsPin.probe(u.host, u.port) }
    }

    // "Trust the new one" (§7.3), after the user chose it: the pin moves to [cert], for this source only.
    fun trustNew(s: FileSource, cert: TlsPin.CertInfo) =
        update(s.copy(tls = TlsPolicy(TlsPolicy.PIN, cert.sha256, cert.subject, cert.notAfter.toString())))

    // "Sign in again" (§7.1) and new passwords go through here (SignInDraft tests them first).
    fun setCredentials(id: String, creds: FileCredentials?) {
        store.setCredentials(id, creds)
        apis.remove(id)?.let(::release)
        reload()
    }

    fun setShowOnHome(v: Boolean) {
        store.setShowOnHome(v)
        reload()
    }

    // Its progress goes with it (the caller confirmed), and a picked folder gives its permission back (§7.5).
    fun remove(id: String) {
        val s = source(id) ?: return
        apis.remove(id)?.let(::release)
        store.remove(id)
        if (s.isLocal) runCatching { Core.app.contentResolver.releasePersistableUriPermission(Uri.parse(s.url), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        reload()
    }

    // Media3 and Coil: a URL under a WebDAV source goes through that source's client (its password, its pin);
    // everything else through Core.http, as before.
    val calls: Call.Factory = Call.Factory { req -> route(req.url, apis.values.mapNotNull { a -> (a.backend as? WebDav)?.let { it.base to it.client } }, Core.http).newCall(req) }

    fun route(url: HttpUrl, sources: List<Pair<HttpUrl, OkHttpClient>>, fallback: OkHttpClient): OkHttpClient =
        sources.firstOrNull { underBase(it.first, url) }?.second ?: fallback

    // A request for [url] built the way Media3 would (tests).
    internal fun request(url: String) = Request.Builder().url(url).build()
}

