package com.wika.wicaby.core.ratings

import android.content.Context
import android.content.res.Resources
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Vault
import com.wika.wicaby.core.data.json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.text.NumberFormat

/** value: IMDb 0-10, Letterboxd 0-5, every other source 0-100. */
data class ExternalRating(val source: String, val value: Double)

/**
 * External ratings (IMDb, Rotten Tomatoes, Metacritic, Letterboxd, TMDb) from MDBList, the twin of desktop's
 * shared/ratings.ts + main/features/ratings.ts. Off until the user sets their MDBList key; then each movie or
 * series page sends its IMDb or TMDb id to mdblist.com. Answers ("not found" too) are kept per route for 7 days in
 * [cache] ("<at>\n<source>=<value>;…", written back through [save]); a failure throws and is not kept.
 */
class Ratings(
    private val http: () -> OkHttpClient,
    private val base: String,
    private val key: () -> String?,
    private val cache: MutableMap<String, String> = mutableMapOf(),
    private val save: (Map<String, String>) -> Unit = {},
    private val now: () -> Long = System::currentTimeMillis,
) {
    suspend fun get(item: Item): List<ExternalRating> {
        val k = key()?.takeIf { it.isNotEmpty() } ?: return emptyList()
        val p = path(item) ?: return emptyList()
        val t = now()
        synchronized(cache) { cache[p] }?.let { hit ->
            if (t - (hit.substringBefore('\n').toLongOrNull() ?: 0) < TTL_MS) return decode(hit.substringAfter('\n', ""))
        }
        val req = Request.Builder().url("$base/$p?apikey=$k").header("Accept", "application/json").build()
        // Throws on a network error, a bad key or the rate limit: not cached here, nor by the UI's load cache.
        val ratings = withContext(Dispatchers.IO) {
            http().newCall(req).execute().use { r ->
                when {
                    r.isSuccessful -> parse(r.body.string())
                    // Unknown title: kept like an answer.
                    r.code == 404 -> emptyList()
                    else -> throw IOException("MDBList HTTP ${r.code}")
                }
            }
        }
        val snapshot = synchronized(cache) {
            cache.entries.removeAll { t - (it.value.substringBefore('\n').toLongOrNull() ?: 0) >= TTL_MS }
            cache[p] = "$t\n" + ratings.joinToString(";") { "${it.source}=${it.value}" }
            cache.toMap()
        }
        save(snapshot)
        return ratings
    }

    fun clear() {
        synchronized(cache) { cache.clear() }
        save(emptyMap())
    }

    private fun decode(s: String) = s.split(';').mapNotNull { e ->
        val v = e.substringAfter('=', "").toDoubleOrNull() ?: return@mapNotNull null
        ExternalRating(e.substringBefore('='), v)
    }

    companion object {
        const val MDBLIST = "https://api.mdblist.com"
        /** Where the free key is (Réglages). */
        const val KEY_URL = "https://mdblist.com/preferences/"
        const val TTL_MS = 7L * 24 * 3600 * 1000
        /** Display order. popcorn: Rotten Tomatoes' audience score. */
        val SOURCES = listOf("imdb", "tomatoes", "popcorn", "metacritic", "letterboxd", "tmdb")
        private val KEY_RE = Regex("^[A-Za-z0-9]{8,64}$")

        fun isKey(s: String) = KEY_RE.matches(s.trim())

        /** "imdb/movie/tt0111161" or "tmdb/show/1396": imdb first; null for other types or without a usable id. */
        fun path(item: Item): String? {
            val kind = when (item.type) { "Movie" -> "movie"; "Series" -> "show"; else -> return null }
            fun id(k: String) = item.providerIds.entries.firstOrNull { it.key.equals(k, ignoreCase = true) }?.value?.trim()
            id("imdb")?.takeIf { Regex("^tt\\d{5,10}$").matches(it) }?.let { return "imdb/$kind/$it" }
            return id("tmdb")?.takeIf { Regex("^\\d{1,10}$").matches(it) }?.let { "tmdb/$kind/$it" }
        }

        /** MDBList's answer → the known sources with a value, in display order (null, 0, "" and "N/A" are missing). */
        fun parse(body: String): List<ExternalRating> {
            val list = runCatching { json.parseToJsonElement(body).jsonObject["ratings"]?.jsonArray }.getOrNull() ?: return emptyList()
            val bySource = list.mapNotNull { it as? JsonObject }.associateBy { runCatching { it["source"]?.jsonPrimitive?.contentOrNull }.getOrNull() }
            return SOURCES.mapNotNull { source ->
                val r = bySource[source] ?: return@mapNotNull null
                // TMDb's value is not always on 0-100: its normalized score is.
                fun num(k: String) = runCatching { r[k]?.jsonPrimitive?.contentOrNull?.toDoubleOrNull() }.getOrNull()
                val v = (if (source == "tmdb") num("score") ?: num("value") else num("value")) ?: return@mapNotNull null
                val max = when (source) { "imdb" -> 10.0; "letterboxd" -> 5.0; else -> 100.0 }
                if (v > 0 && v <= max) ExternalRating(source, v) else null
            }
        }

        /** "IMDb 7,8", "RT 91 %"… in the UI's language. */
        fun label(res: Resources, r: ExternalRating): String {
            val nf = NumberFormat.getInstance(res.configuration.locales[0]).apply { maximumFractionDigits = 1 }
            val id = when (r.source) {
                "imdb" -> R.string.rating_imdb
                "tomatoes" -> R.string.rating_tomatoes
                "popcorn" -> R.string.rating_popcorn
                "metacritic" -> R.string.rating_metacritic
                "letterboxd" -> R.string.rating_letterboxd
                else -> R.string.rating_tmdb
            }
            return res.getString(id, nf.format(r.value))
        }

        private val prefs by lazy { Core.app.getSharedPreferences("wicaby_ratings", Context.MODE_PRIVATE) }
        // The key, sealed by the Android Keystore (data/Prefs.kt Vault); opened once.
        @Volatile
        private var openKey: String? = null
        private val _configured by lazy { MutableStateFlow(prefs.contains("key")) }
        val configured: StateFlow<Boolean> get() = _configured

        /** "" turns ratings off. False when [key] does not look like an MDBList key. */
        fun setKey(key: String): Boolean {
            val k = key.trim()
            if (k.isNotEmpty() && !isKey(k)) return false
            prefs.edit().apply { if (k.isEmpty()) remove("key") else putString("key", Vault.encrypt(k)) }.apply()
            openKey = k
            _configured.value = k.isNotEmpty()
            default.clear()
            return true
        }

        /** The app's instance: Core.http, the sealed key, a SharedPreferences cache (read on first use). */
        val default: Ratings by lazy {
            val sp = Core.app.getSharedPreferences("wicaby_ratings_cache", Context.MODE_PRIVATE)
            Ratings(
                http = { Core.http },
                base = MDBLIST,
                key = { openKey ?: prefs.getString("key", null)?.let(Vault::decrypt).also { openKey = it } },
                cache = sp.all.mapNotNull { (k, v) -> (v as? String)?.let { k to it } }.toMap(HashMap()),
                save = { all -> sp.edit().clear().apply { all.forEach { (k, v) -> putString(k, v) } }.apply() },
            )
        }
    }
}
