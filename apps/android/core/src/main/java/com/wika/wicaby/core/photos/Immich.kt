package com.wika.wicaby.core.photos

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Vault
import com.wika.wicaby.core.data.isServerUrl
import com.wika.wicaby.core.net.ServerTransport
import com.wika.wicaby.core.net.origin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException

// Immich as a second photo source (photos spec §3.2, PH-13), its own library on mobile and TV. Requests are written
// by hand from the published HTTP API reference: no Immich code or SDK (spec §0). The API key is sealed by the
// Keystore Vault and only travels in the x-api-key header, added by ImmichKeyInterceptor for the configured
// server's own origin: Coil and Media3 (Core.http) load pictures and clips with plain URLs.
// shortcut: one Immich source per device; the desktop takes several. Add a list if anyone runs two servers.

const val IMMICH_HEADER = "x-api-key"
const val IMMICH_MIN_MAJOR = 2

data class ImmichSource(val id: String, val url: String, val key: String) {
    val serverId get() = "immich:$id"
    val name: String get() = url.toHttpUrlOrNull()?.let { if (it.port == HttpUrl.defaultPort(it.scheme)) it.host else "${it.host}:${it.port}" } ?: url
    override fun toString() = "ImmichSource(id=$id, url=$url)"
}

// An Immich answer the UI maps to a caption: 403 = a missing permission, 401 = a refused key.
class ImmichException(val status: Int) : IOException("immich:$status")

// "photos.local:2283", "https://nas/immich/" or ".../api" -> "http(s)://host[:port][/prefix]", or null.
fun normalizeImmichUrl(input: String): String? {
    var t = input.trim().trimEnd('/').removeSuffix("/api").trimEnd('/')
    if (t.isEmpty()) return null
    if (!t.contains("://")) t = "http://$t"
    val u = t.toHttpUrlOrNull() ?: return null
    if (u.username.isNotEmpty() || u.password.isNotEmpty() || u.query != null || u.fragment != null) return null
    val port = if (u.port == HttpUrl.defaultPort(u.scheme)) "" else ":${u.port}"
    return "${u.scheme}://${u.host.let { if (':' in it) "[$it]" else it }}$port${u.encodedPath.trimEnd('/')}"
}

private val Context.immichStore by preferencesDataStore("wicaby_immich")

object Immich {
    // The configured source, read once at start (Core.init) and on every change.
    @Volatile
    var source: ImmichSource? = null

    private val idKey = stringPreferencesKey("id")
    private val urlKey = stringPreferencesKey("url")
    private val keyKey = stringPreferencesKey("key")

    fun init(context: Context) {
        Core.scope.launch { source = load(context) }
    }

    private suspend fun load(context: Context): ImmichSource? = context.immichStore.data.map { p ->
        val url = p[urlKey] ?: return@map null
        // A key the Keystore no longer opens drops the source.
        ImmichSource(p[idKey] ?: return@map null, url, p[keyKey]?.let(Vault::decrypt) ?: return@map null)
    }.first()

    suspend fun save(context: Context, url: String, key: String): ImmichSource {
        val s = ImmichSource(source?.takeIf { it.url == url }?.id ?: java.util.UUID.randomUUID().toString().replace("-", "").take(12), url, key)
        context.immichStore.edit {
            it[idKey] = s.id
            it[urlKey] = s.url
            it[keyKey] = Vault.encrypt(s.key)
        }
        source = s
        return s
    }

    // Its cached pictures go too (spec §6.1: personal images leave with their source).
    suspend fun remove(context: Context) {
        context.immichStore.edit { it.clear() }
        source = null
        withContext(Dispatchers.IO) { runCatching { Core.prefs.clearImages() } }
    }

    fun owns(a: PhotoAsset) = a.serverId.startsWith("immich:")

    fun client(): ImmichClient = ImmichClient(source?.url ?: throw ImmichException(404))
}

// Network interceptor (every hop, redirects included, after TransportInterceptor): a hop that left the origin its
// call started on loses x-api-key; a hop to the configured Immich server's API that carries none gets the key.
class ImmichKeyInterceptor(private val transport: () -> ServerTransport, private val source: () -> ImmichSource?) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val start = chain.call().request().url
        val t = transport()
        val b = req.newBuilder()
        if (!isServerUrl(req.url, origin(start), t)) b.removeHeader(IMMICH_HEADER)
        else if (req.header(IMMICH_HEADER) == null) {
            val s = source()
            val base = s?.url?.toHttpUrlOrNull()
            if (s != null && base != null && isServerUrl(req.url, origin(base), t) && req.url.encodedPath.contains("${base.encodedPath.trimEnd('/')}/api/")) b.header(IMMICH_HEADER, s.key)
        }
        return chain.proceed(b.build())
    }
}

class ImmichAlbum(val id: String, val name: String, val coverId: String?, val count: Int, val shared: Boolean)
class ImmichPerson(val id: String, val name: String)

// error: url, network, server (not an Immich answer), version (older than 2.0), auth (key refused), scope (no
// asset.read). missing: the optional permissions the key lacks, each one hiding its feature.
data class ImmichProbe(val ok: Boolean, val error: String? = null, val version: String? = null, val missing: List<String> = emptyList())

// The JSON calls. key: sent explicitly (Test, before anything is saved); otherwise the interceptor adds it.
class ImmichClient(val baseUrl: String, private val key: String? = null, http: OkHttpClient = Core.http) {
    private val http = http.newBuilder().followRedirects(false).followSslRedirects(false).build()
    private val base = baseUrl.toHttpUrlOrNull() ?: throw ImmichException(400)
    private val lenient = Json { ignoreUnknownKeys = true }

    fun url(path: String, vararg query: Pair<String, String?>): String {
        val b = base.newBuilder().addEncodedPathSegments("api/${path.trimStart('/')}")
        for ((k, v) in query) if (v != null) b.addQueryParameter(k, v)
        return b.build().toString()
    }

    private suspend fun send(method: String, path: String, query: Map<String, String?> = emptyMap(), body: JsonElement? = null): JsonElement? = withContext(Dispatchers.IO) {
        val rb = Request.Builder().url(url(path, *query.toList().toTypedArray())).header("Accept", "application/json")
        if (key != null) rb.header(IMMICH_HEADER, key)
        rb.method(method, body?.let { it.toString().toRequestBody("application/json".toMediaType()) })
        http.newCall(rb.build()).execute().use { r ->
            if (!r.isSuccessful) throw ImmichException(r.code)
            val text = r.body.string()
            if (text.isBlank()) null else lenient.parseToJsonElement(text)
        }
    }

    suspend fun get(path: String, query: Map<String, String?> = emptyMap()): JsonElement = send("GET", path, query) ?: JsonArray(emptyList())
    suspend fun post(path: String, body: JsonObject): JsonElement = send("POST", path, body = body) ?: JsonObject(emptyMap())

    private fun JsonElement?.str() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonElement?.num() = (this as? JsonPrimitive)?.doubleOrNull

    // Nothing is stored: the version (2.0 or later), the key, then which optional permissions it lacks.
    suspend fun test(): ImmichProbe {
        val version = try {
            val v = withContext(Dispatchers.IO) {
                http.newCall(Request.Builder().url(url("/server/version")).build()).execute().use { r -> if (r.isSuccessful) lenient.parseToJsonElement(r.body.string()) as? JsonObject else null }
            } ?: return ImmichProbe(false, "server")
            val major = (v["major"] as? JsonPrimitive)?.intOrNull ?: return ImmichProbe(false, "server")
            "$major.${(v["minor"] as? JsonPrimitive)?.intOrNull ?: 0}.${(v["patch"] as? JsonPrimitive)?.intOrNull ?: 0}".also {
                if (major < IMMICH_MIN_MAJOR) return ImmichProbe(false, "version", it)
            }
        } catch (e: IOException) {
            return ImmichProbe(false, "network")
        } catch (e: Exception) {
            return ImmichProbe(false, "server")
        }
        return try {
            val buckets = get("/timeline/buckets", mapOf("visibility" to "timeline")) as? JsonArray
            val missing = ArrayList<String>()
            // asset.view: one thumbnail of the newest month, when there is one.
            (buckets?.firstOrNull() as? JsonObject)?.get("timeBucket").str()?.let { tb ->
                val id = ((runCatching { get("/timeline/bucket", mapOf("visibility" to "timeline", "timeBucket" to tb)) }.getOrNull() as? JsonObject)?.get("id") as? JsonArray)?.firstOrNull().str()
                if (id != null) withContext(Dispatchers.IO) {
                    val rb = Request.Builder().url(url("/assets/$id/thumbnail", "size" to "thumbnail"))
                    if (key != null) rb.header(IMMICH_HEADER, key)
                    http.newCall(rb.build()).execute().use { if (it.code == 403) missing += "asset.view" }
                }
            }
            for ((path, scope) in listOf("/albums" to "album.read", "/people" to "person.read", "/map/markers" to "map.read", "/memories" to "memory.read")) {
                try {
                    get(path)
                } catch (e: ImmichException) {
                    if (e.status == 403) missing += scope
                }
            }
            ImmichProbe(true, version = version, missing = missing)
        } catch (e: ImmichException) {
            ImmichProbe(false, if (e.status == 401) "auth" else if (e.status == 403) "scope" else "server", version, if (e.status == 403) listOf("asset.read") else emptyList())
        } catch (e: IOException) {
            ImmichProbe(false, "network", version)
        }
    }

    suspend fun timeline(filter: ImmichTimeline.Filter, onPage: (List<PhotoAsset>, Int) -> Unit = { _, _ -> }): ImmichTimeline.Result =
        ImmichTimeline.load({ p, q -> get(p, q) }, { p, b -> post(p, b) }, serverId(), filter, geo = false, onPage = onPage)

    private fun serverId() = Immich.source?.takeIf { it.url == baseUrl }?.serverId ?: "immich:"

    suspend fun albums(): List<ImmichAlbum> = (get("/albums") as? JsonArray).orEmpty().mapNotNull { e ->
        val o = e as? JsonObject ?: return@mapNotNull null
        ImmichAlbum(
            o["id"].str() ?: return@mapNotNull null, o["albumName"].str().orEmpty(), o["albumThumbnailAssetId"].str(), o["assetCount"].num()?.toInt() ?: 0,
            // v3 says isShared, v2 shared.
            ((o["isShared"] ?: o["shared"]) as? JsonPrimitive)?.booleanOrNull == true,
        )
    }.sortedBy { it.name.lowercase() }

    // Named, visible people only (no naming or merging from Wicaby, spec F5).
    suspend fun people(): List<ImmichPerson> = ((get("/people", mapOf("withHidden" to "false")) as? JsonObject)?.get("people") as? JsonArray).orEmpty().mapNotNull { e ->
        val o = e as? JsonObject ?: return@mapNotNull null
        val name = o["name"].str()?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        if ((o["isHidden"] as? JsonPrimitive)?.booleanOrNull == true) null else ImmichPerson(o["id"].str() ?: return@mapNotNull null, name)
    }

    // Immich's "on this day": (years ago, assets), nearest first. today: "YYYY-MM-DD".
    suspend fun memories(today: String): List<Pair<Int, List<PhotoAsset>>> {
        val year = today.take(4).toInt()
        return (get("/memories", mapOf("for" to today)) as? JsonArray).orEmpty().mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val y = ((o["data"] as? JsonObject)?.get("year") as? JsonPrimitive)?.intOrNull ?: return@mapNotNull null
            val assets = (o["assets"] as? JsonArray).orEmpty().mapNotNull { a -> (a as? JsonObject)?.let { ImmichTimeline.searchAsset(it, serverId()) } }
            if (o["type"].str() != "on_this_day" || y >= year || assets.isEmpty()) null else (year - y) to assets
        }.sortedBy { it.first }
    }

    // The viewer's info panel: the asset's EXIF in the Item fields Exif.kt reads. Aperture is an f-number here.
    suspend fun detail(id: String): Item {
        val o = get("/assets/$id") as? JsonObject ?: throw ImmichException(500)
        val e = o["exifInfo"] as? JsonObject
        val exposure = e?.get("exposureTime").str()
        val frac = exposure?.let { Regex("""^(\d+)/(\d+)$""").find(it) }
        return Item(
            id = id, name = o["originalFileName"].str().orEmpty(), type = if (o["type"].str() == "VIDEO") "Video" else "Photo",
            cameraMake = e?.get("make").str(), cameraModel = e?.get("model").str(),
            exposureTime = frac?.let { it.groupValues[1].toDouble() / it.groupValues[2].toDouble() } ?: exposure?.toDoubleOrNull(),
            aperture = e?.get("fNumber").num(), focalLength = e?.get("focalLength").num(), isoSpeedRating = e?.get("iso").num()?.toInt(),
            width = e?.get("exifImageWidth").num()?.toInt(), height = e?.get("exifImageHeight").num()?.toInt(),
            latitude = e?.get("latitude").num(), longitude = e?.get("longitude").num(),
        )
    }

    suspend fun setFavorite(id: String, on: Boolean) {
        send("PUT", "/assets", body = buildJsonObject {
            putJsonArray("ids") { add(JsonPrimitive(id)) }
            put("isFavorite", on)
        })
    }

    // Pictures and clips: plain URLs, the interceptor adds the key. size: thumbnail (about 250 px), preview (about
    // 1440 px) or fullsize.
    fun thumb(id: String, size: String) = url("/assets/$id/thumbnail", "size" to size)
    fun video(id: String) = url("/assets/$id/video/playback")
    fun face(id: String) = url("/people/$id/thumbnail")
}
