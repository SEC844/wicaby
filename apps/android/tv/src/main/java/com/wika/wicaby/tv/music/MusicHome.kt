package com.wika.wicaby.tv.music

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.music.musicGenres
import com.wika.wicaby.tv.LocalApi
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.Route
import com.wika.wicaby.tv.play
import com.wika.wicaby.tv.playMusic
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.LibraryGrid
import com.wika.wicaby.tv.ui.MUSIC_ALBUMS
import com.wika.wicaby.tv.ui.MUSIC_ARTISTS
import com.wika.wicaby.tv.ui.MUSIC_SONGS
import com.wika.wicaby.tv.ui.MediaRow
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.rememberFocusMemory
import com.wika.wicaby.tv.ui.rememberLoad
import com.wika.wicaby.tv.ui.route
import kotlinx.coroutines.launch

// One row of the music home: its key (cache, focus memory, tests), its title and what it loads.
private class MusicRow(val key: String, val label: Int, val load: suspend () -> List<Item>)

private const val ROW = 24

/**
 * A music library's tab (music spec §4.7, MU-09): rows rather than tabs, the TV idiom. Albums récents, Écoutés
 * récemment, Playlists, Artistes, Genres; a row the server leaves empty is not shown. The header's pills open the
 * whole library as a grid (albums, artists or songs).
 */
@Composable
fun MusicHome(api: Api, parentId: String, title: String, top: Dp, onScrolled: (Boolean) -> Unit = {}) {
    val nav = LocalNav.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val memory = rememberFocusMemory()
    val sid = Servers.extraOf(api.server.id)?.server?.id
    val rows = listOf(
        MusicRow("recent-albums", R.string.music_row_recent_albums) {
            api.items("ParentId" to parentId, "IncludeItemTypes" to "MusicAlbum", "Recursive" to true, "SortBy" to "DateCreated", "SortOrder" to "Descending", "Limit" to ROW).items
        },
        MusicRow("recently-played", R.string.music_row_recently_played) {
            api.items(
                "ParentId" to parentId, "IncludeItemTypes" to "Audio", "Recursive" to true, "Filters" to "IsPlayed",
                "SortBy" to "DatePlayed", "SortOrder" to "Descending", "Limit" to ROW,
            ).items
        },
        // Playlists live outside the music library: the user's audio ones (a playlist keeps one media type).
        MusicRow("playlists", R.string.music_row_playlists) {
            api.items("IncludeItemTypes" to "Playlist", "Recursive" to true, "SortBy" to "SortName", "Limit" to 100).items.filter { it.mediaType == "Audio" }.take(ROW)
        },
        MusicRow("artists", R.string.music_row_artists) {
            api.albumArtists("ParentId" to parentId, "SortBy" to "SortName", "Limit" to ROW).items
        },
        MusicRow("genres", R.string.music_row_genres) { api.musicGenres(parentId).items.take(ROW) },
    )
    val scroll = rememberScrollState()
    LaunchedEffect(scroll) { snapshotFlow { scroll.value > 60 }.collect(onScrolled) }

    fun open(item: Item) {
        when {
            // A track plays on through its album, an artist or a genre all their tracks (PlayQueue.tracks).
            item.isAudio -> play(context, item)
            item.type == "MusicArtist" || item.type == "MusicGenre" || item.type == "Genre" -> scope.launch { playMusic(context, api, item) }
            else -> nav.push(item.route())
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(scroll).padding(top = top, bottom = 56.dp).testTag("music-home")) {
        Row(Modifier.fillMaxWidth().padding(start = 48.dp, end = 48.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = Type.largeTitle, color = C.label, modifier = Modifier.weight(1f))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                listOf(MUSIC_ALBUMS to R.string.music_albums, MUSIC_ARTISTS to R.string.music_artists, MUSIC_SONGS to R.string.music_songs).forEach { (m, label) ->
                    Pill(stringResource(label), onClick = { nav.push(Route.MusicLibrary(parentId, title, m, sid)) })
                }
            }
        }
        rows.forEach { r ->
            val items = rememberLoad("music-$parentId-${r.key}") { r.load() }.value.value
            if (!items.isNullOrEmpty()) {
                MediaRow(
                    stringResource(r.label), items, api, memory, r.key, wide = false, onFocusItem = {}, onClick = ::open, square = true,
                    modifier = Modifier.testTag("music-row-${r.key}"),
                )
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}

/** Route.MusicLibrary: the music library's whole grid, on albums, artists or songs. */
@Composable
fun MusicLibraryScreen(id: String, name: String, mode: Int) {
    val api = LocalApi.current ?: return
    Box(Modifier.fillMaxSize().background(C.bg)) {
        LibraryGrid(api, id, name, "music", top = 48.dp, defaultFocus = true, initialMode = mode)
    }
}
