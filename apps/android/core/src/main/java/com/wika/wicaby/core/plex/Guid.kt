package com.wika.wicaby.core.plex

import kotlinx.serialization.json.JsonElement

// Plex GUIDs → Emby ProviderIds (plex-spec §4, triage §4.5), the twin of desktop shared/plex/guid.ts. New agents
// send Guid[] ({id: "imdb://tt…"}), legacy ones a scalar guid ("com.plexapp.agents.imdb://tt…?lang=en",
// "…thetvdb://123/1/2", HAMA "…hama://anidb-123"). Guid[] wins over the scalar; plex://, local:// carry no id.
object PlexGuid {
    private val PROVIDERS = mapOf("imdb" to "Imdb", "tmdb" to "Tmdb", "themoviedb" to "Tmdb", "tvdb" to "Tvdb", "thetvdb" to "Tvdb", "anidb" to "AniDB")
    private val TRAILING_DIGITS = Regex("\\d+$")
    private val HAMA = Regex("^([a-z]+\\d*)-(.+)$", RegexOption.IGNORE_CASE)
    private val IMDB = Regex("^tt\\d+$")
    private val DIGITS = Regex("^\\d+$")

    // HAMA prefixes "anidb2-", "tvdb3-" name the same provider.
    private fun providerOf(name: String) = PROVIDERS[name.lowercase().replace(TRAILING_DIGITS, "")]

    private fun parseOne(scheme: String, value: String): Pair<String, String>? {
        val s = scheme.lowercase().removePrefix("com.plexapp.agents.").removePrefix("tv.plex.agents.")
        val v = pctDecode(value.split('?')[0]).trim()
        if (v.isEmpty()) return null
        if (s == "hama" || s == "xbmcnfo" || s == "xbmcnfotv") {
            HAMA.find(v)?.let { m ->
                val p = providerOf(m.groupValues[1]) ?: return null
                return p to m.groupValues[2].split('/')[0]
            }
            if (IMDB.matches(v)) return "Imdb" to v
            if (s == "xbmcnfotv" && DIGITS.matches(v)) return "Tvdb" to v
            return null
        }
        val p = providerOf(s) ?: return null
        // Legacy TV agents append "/season/episode" to the show id: not this item's own id.
        if ('/' in v) return null
        if (p == "Imdb" && !IMDB.matches(v)) return null
        return p to v
    }

    private fun split(guid: String): Pair<String, String>? {
        val i = guid.indexOf("://")
        return if (i > 0) guid.substring(0, i) to guid.substring(i + 3) else null
    }

    fun providerIds(meta: JsonElement?): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        meta["guid"].str()?.takeIf { it.isNotEmpty() }?.let(::split)?.let { parseOne(it.first, it.second) }?.let { out[it.first] = it.second }
        for (g in meta["Guid"].list()) {
            g["id"].str()?.takeIf { it.isNotEmpty() }?.let(::split)?.let { parseOne(it.first, it.second) }?.let { out[it.first] = it.second }
        }
        return out
    }
}
