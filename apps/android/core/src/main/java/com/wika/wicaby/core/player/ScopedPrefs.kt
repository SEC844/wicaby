package com.wika.wicaby.core.player

import android.content.Context
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.util.concurrent.ConcurrentHashMap

// X-05: speed and aspect remembered at the scope set in Réglages > "Mémoriser les réglages".
// The same rules and JSON as the desktop's scoped-prefs.ts (golden vectors in
// CK/fixtures/track/track-fixtures.json): { prop: { global?, library?: {key: entry}, title?: {key: entry} } },
// entry = { v, at }. Only the configured scope is read, then the global value.
object ScopedPrefs {
    enum class Scope { Off, Global, Library, Title }

    // title: "serverId:SeriesId ?: Id"; library: "serverId:library view id". global: Live TV and downloads.
    data class Ctx(val title: String? = null, val library: String? = null, val global: Boolean = false)

    const val SPEED = "speed"
    const val ASPECT = "aspect"
    private const val CAP = 300

    // Pushed by the app's settings (TV); mobile keeps the defaults.
    @Volatile
    var scopes: Map<String, Scope> = mapOf(SPEED to Scope.Global, ASPECT to Scope.Title)

    // ---- Pure (unit-tested on the JVM).

    private fun slot(scope: Scope, ctx: Ctx): Pair<String, String>? = when {
        scope == Scope.Off -> null
        scope == Scope.Global || ctx.global -> "global" to ""
        scope == Scope.Title -> ctx.title?.let { "title" to it }
        else -> ctx.library?.let { "library" to it }
    }

    private fun entry(e: JsonElement?) = (e as? JsonObject)?.get("v")

    fun read(doc: JsonObject, prop: String, scope: Scope, ctx: Ctx): JsonElement? {
        if (scope == Scope.Off) return null
        val d = doc[prop] as? JsonObject
        val s = slot(scope, ctx)
        val own = if (s != null && s.first != "global") ((d?.get(s.first) as? JsonObject)?.get(s.second)) else null
        return entry(own) ?: entry(d?.get("global"))
    }

    fun write(doc: JsonObject, prop: String, scope: Scope, ctx: Ctx, value: JsonElement, now: Long): JsonObject {
        val (map, key) = slot(scope, ctx) ?: return doc
        val d = (doc[prop] as? JsonObject).orEmpty().toMutableMap()
        val e = buildJsonObject { put("v", value); put("at", JsonPrimitive(now)) }
        if (map == "global") d["global"] = e
        else {
            // The oldest entries go first past CAP.
            val all = ((d[map] as? JsonObject).orEmpty() + (key to e)).entries
                .sortedByDescending { ((it.value as? JsonObject)?.get("at") as? JsonPrimitive)?.longOrNull ?: 0L }
                .take(CAP)
            d[map] = JsonObject(all.associate { it.key to it.value })
        }
        return JsonObject(doc + (prop to JsonObject(d)))
    }

    // ---- Store and context.

    private val sp by lazy { Core.app.getSharedPreferences("wicaby_player_scopes", Context.MODE_PRIVATE) }
    private var doc: JsonObject? = null

    private fun load(): JsonObject = doc ?: runCatching { sp.getString("doc", null)?.let { json.parseToJsonElement(it).jsonObject } }.getOrNull().orEmpty().let(::JsonObject).also { doc = it }

    @Synchronized
    fun recall(prop: String, ctx: Ctx?): JsonElement? = ctx?.let { read(load(), prop, scopes[prop] ?: Scope.Off, it) }

    @Synchronized
    fun remember(prop: String, ctx: Ctx?, value: JsonElement) {
        if (ctx == null) return
        update { write(it, prop, scopes[prop] ?: Scope.Off, ctx, value, System.currentTimeMillis()) }
    }

    /** The stored document, for rules with their own keys (AvSync). */
    @Synchronized
    fun doc(): JsonObject = load()

    @Synchronized
    fun update(f: (JsonObject) -> JsonObject) {
        val next = f(load())
        doc = next
        runCatching { sp.edit().putString("doc", next.toString()).apply() }
    }

    @Synchronized
    fun clear() {
        doc = JsonObject(emptyMap())
        runCatching { sp.edit().clear().apply() }
    }

    // "title key" -> library view id ("" = none found), for the Per library scope; this process only.
    private val libraries = ConcurrentHashMap<String, String>()

    /** The keys of [item]; looks its library up once per title when a setting is per library. */
    suspend fun ctx(api: Api, item: Item, global: Boolean): Ctx {
        if (global) return Ctx(global = true)
        val title = "${api.server.id}:${item.seriesId ?: item.id}"
        if (Scope.Library !in scopes.values) return Ctx(title)
        val lib = libraries[title] ?: runCatching {
            json.parseToJsonElement(api.raw("GET", "/Items/${item.id}/Ancestors", null, "UserId" to api.userId)).jsonArray
                .firstOrNull { it.jsonObject["Type"]?.jsonPrimitive?.content == "CollectionFolder" }
                ?.jsonObject?.get("Id")?.jsonPrimitive?.content.orEmpty()
        }.getOrNull()?.also { libraries[title] = it } // a failed lookup is retried next time
        return Ctx(title, lib?.ifEmpty { null }?.let { "${api.server.id}:$it" })
    }
}
