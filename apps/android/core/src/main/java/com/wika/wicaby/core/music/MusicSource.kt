package com.wika.wicaby.core.music

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Servers

/**
 * "Source de la musique": the server whose music and playlists libraries the Music section shows, per profile
 * (the primary server and user). "" (Auto) keeps every server's; a source that is offline, removed or without a
 * music library changes nothing, so Music never empties. Twin of desktop shared/music-source.ts (same vectors).
 */
object MusicSource {
    // Read by the view loaders' cache keys: a change reloads them.
    var version by mutableIntStateOf(0)
        private set

    fun <T> filter(views: List<T>, source: String, serverId: (T) -> String?, type: (T) -> String?): List<T> {
        if (source.isEmpty() || views.none { serverId(it) == source && type(it) == "music" }) return views
        return views.filter { serverId(it) == source || (type(it) != "music" && type(it) != "playlists") }
    }

    // The picker: Auto, then each signed-in media server ("Name · Kind"); one without music changes nothing.
    fun choices(auto: String): List<Pair<String, String>> = listOf("" to auto) +
        Servers.all.filter { it.server.kind != "files" && it.server.kind != "iptv" }.map { it.server.id to "${it.server.name} · ${it.server.kind.replaceFirstChar { c -> c.uppercase() }}" }

    fun apply(views: List<Item>): List<Item> = filter(views, current(), { it.serverId }, { it.collectionType })

    private fun key(): String? = Core.api?.let { "source_${it.server.id}/${it.userId}" }

    private fun sp() = Core.app.getSharedPreferences("wicaby_music", Context.MODE_PRIVATE)

    // Unit tests have no Application: Auto.
    fun current(): String = key()?.let { k -> runCatching { sp().getString(k, "") }.getOrNull() }.orEmpty()

    fun set(serverId: String) {
        val k = key() ?: return
        sp().edit().putString(k, serverId).apply()
        version++
    }
}
