package com.wika.wicaby.mobile.music

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ListKind
import com.wika.wicaby.core.data.lists
import com.wika.wicaby.core.music.albums
import com.wika.wicaby.core.music.musicArtists
import com.wika.wicaby.core.music.musicGenres
import com.wika.wicaby.core.music.songs
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.player.PlayerHolder
import com.wika.wicaby.mobile.ui.Centered
import com.wika.wicaby.mobile.ui.Chip
import com.wika.wicaby.mobile.ui.ErrorState
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.GridRoute
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.Spinner
import com.wika.wicaby.mobile.ui.TopBar
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.rememberLoad
import kotlinx.coroutines.launch

enum class MusicTab(val label: Int) {
    Albums(R.string.music_tab_albums),
    Artists(R.string.music_tab_artists),
    Songs(R.string.music_tab_songs),
    Genres(R.string.music_tab_genres),
    Playlists(R.string.music_tab_playlists),
}

/** A music library (§4.6): Albums · Artistes · Titres · Genres · Playlists, and a shuffle of the whole library. */
@Composable
fun MusicScreen(api: Api, route: GridRoute, nav: NavController) {
    val lib = route.parentId ?: return
    var tab by rememberSaveable { mutableStateOf(MusicTab.Albums) }
    var albumArtistsOnly by rememberSaveable { mutableStateOf(true) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val open: (Item) -> Unit = { nav.navigate(MusicRoute(it.id, it.type, it.name, route.serverId)) }
    Column(Modifier.fillMaxSize()) {
        TopBar(route.title, onBack = { nav.popBackStack() })
        LazyRow(contentPadding = PaddingValues(horizontal = 20.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item("shuffle") {
                Chip(stringResource(R.string.music_shuffle), selected = false, icon = Ic.Shuffle) {
                    scope.launch {
                        val all = runCatching { api.items("ParentId" to lib, "IncludeItemTypes" to "Audio", "Recursive" to true, "SortBy" to "Random", "Limit" to 300, "Fields" to api.trackFields).items }.getOrNull()
                        if (!all.isNullOrEmpty()) PlayerHolder.startMusic(context, api, all, 0)
                    }
                }
            }
            items(MusicTab.entries, key = { it.name }) { t -> Chip(stringResource(t.label), selected = t == tab) { tab = t } }
        }
        Box(Modifier.fillMaxSize()) {
            when (tab) {
                MusicTab.Albums -> AlbumGrid(api, "albums-$lib", { start -> api.albums(lib, start) }, open)
                MusicTab.Artists -> Column {
                    Row(Modifier.padding(horizontal = 20.dp, vertical = 4.dp)) {
                        Chip(stringResource(R.string.music_album_artists_only), selected = albumArtistsOnly, icon = if (albumArtistsOnly) Ic.Check else null) { albumArtistsOnly = !albumArtistsOnly }
                    }
                    NameList(api, rememberLoad("music-artists-$lib-$albumArtistsOnly") { api.musicArtists(lib, albumArtistsOnly).items }.value, round = true, onClick = open)
                }
                MusicTab.Songs -> SongList(api, lib) { nav.navigate(it.copy(serverId = route.serverId)) }
                MusicTab.Genres -> NameList(api, rememberLoad("music-genres-$lib") { api.musicGenres(lib).items.map { it.copy(type = "MusicGenre") } }.value, round = false, onClick = open)
                MusicTab.Playlists -> NameList(api, rememberLoad("music-playlists") { api.lists(ListKind.Playlist).filter { it.mediaType == "Audio" } }.value, round = false, onClick = open)
            }
        }
    }
}

@Composable
fun AlbumGrid(api: Api, key: String, load: suspend (Int) -> com.wika.wicaby.core.data.ItemsResult, onClick: (Item) -> Unit) {
    val pages = remember(key) { Pages(load) }
    val grid = rememberLazyGridState()
    val scope = rememberCoroutineScope()
    LaunchedEffect(pages) { pages.more() }
    LaunchedEffect(grid, pages) { snapshotFlow { grid.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }.collect { if (it > pages.items.size - 20) pages.more() } }
    when {
        pages.failed -> Centered { ErrorState({ scope.launch { pages.more() } }) }
        pages.total < 0 -> Centered { Spinner() }
        pages.total == 0 -> Centered { Text(stringResource(R.string.music_empty), style = Type.body, color = G.label2) }
        else -> LazyVerticalGrid(
            columns = GridCells.Adaptive(150.dp), state = grid, modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 24.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            items(pages.items, key = { it.id }) { album -> AlbumCard(api, album) { onClick(album) } }
        }
    }
}

@Composable
fun AlbumCard(api: Api, album: Item, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick)) {
        Box(Modifier.fillMaxWidth().aspectRatio(1f)) { ArtFill(api, album) }
        Text(album.name, style = Type.callout, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
        val sub = album.albumArtist ?: album.productionYear?.toString()
        if (sub != null) Text(sub, style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// Square art filling its box (album cards, the player).
@Composable
fun ArtFill(api: Api, item: Item) {
    androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxSize()) { Art(api, item, maxWidth) }
}

@Composable
private fun NameList(api: Api, list: List<Item>?, round: Boolean, onClick: (Item) -> Unit) {
    when {
        list == null -> Centered { Spinner() }
        list.isEmpty() -> Centered { Text(stringResource(R.string.music_empty), style = Type.body, color = G.label2) }
        else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            items(list, key = { it.id }) { item ->
                Row(
                    Modifier.fillMaxWidth().height(64.dp).clickable(role = Role.Button) { onClick(item) }.padding(horizontal = 20.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Art(api, item, 48.dp, round = round)
                    Text(item.name, style = Type.headline, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SongList(api: Api, lib: String, open: (MusicRoute) -> Unit) {
    val pages = remember(lib) { Pages { start -> api.songs(lib, start) } }
    val list = rememberLazyListState()
    val context = LocalContext.current
    var menu by remember { mutableStateOf<Item?>(null) }
    LaunchedEffect(pages) { pages.more() }
    LaunchedEffect(list, pages) { snapshotFlow { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }.collect { if (it > pages.items.size - 30) pages.more() } }
    when {
        pages.total < 0 -> Centered { Spinner() }
        pages.total == 0 -> Centered { Text(stringResource(R.string.music_empty), style = Type.body, color = G.label2) }
        // Windowed: the loaded songs from the tapped one play as the queue.
        else -> LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = 24.dp)) {
            itemsIndexed(pages.items, key = { _, it -> it.id }) { i, song ->
                TrackRow(api, song, onClick = { PlayerHolder.startMusic(context, api, pages.items.toList(), i) }, onMenu = { menu = song })
            }
        }
    }
    menu?.let { TrackMenu(api, it, onDismiss = { menu = null }, open = open) }
}
