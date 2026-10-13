package com.wika.wicaby.mobile.music

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.player.PlayerHolder
import com.wika.wicaby.mobile.ui.Centered
import com.wika.wicaby.mobile.ui.ErrorState
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.PillButton
import com.wika.wicaby.mobile.ui.Spinner
import com.wika.wicaby.mobile.ui.TopBar
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.rememberLoad
import kotlinx.coroutines.launch

/**
 * An album, playlist, genre or artist page (§4.6): art, Lire / Lecture aléatoire / Mix, then the songs (disc headers
 * when an album has several discs) or, for an artist, their albums then their songs.
 */
@Composable
fun MusicItemScreen(api: Api, route: MusicRoute, nav: NavController) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val artist = route.type == "MusicArtist"
    var nonce by remember { mutableIntStateOf(0) }
    val item = rememberLoad("item-music-${route.id}", nonce) { api.item(route.id) }.value ?: Item(route.id, route.name, route.type)
    val tracks = rememberLoad("music-tracks-${route.id}", nonce) { tracksOf(api, route.id, route.type, route.name) }
    // Emby's AlbumArtistIds is unverified on 4.8+ (spec §3.2): ArtistIds with ArtistType=AlbumArtist there.
    val albums = if (artist) rememberLoad("music-artist-albums-${route.id}", nonce) {
        val by = if (api.server.isEmby) arrayOf("ArtistIds" to route.id, "ArtistType" to "AlbumArtist") else arrayOf<Pair<String, Any?>>("AlbumArtistIds" to route.id)
        api.items(*by, "IncludeItemTypes" to "MusicAlbum", "Recursive" to true, "SortBy" to "ProductionYear,SortName", "SortOrder" to "Descending").items
    }.value.orEmpty() else emptyList()
    var menu by remember { mutableStateOf<Item?>(null) }
    val open: (MusicRoute) -> Unit = { nav.navigate(it.copy(serverId = route.serverId)) }
    val playing = PlayerHolder.music?.current?.id
    val list = tracks.value

    Column(Modifier.fillMaxSize()) {
        TopBar(route.name, onBack = { nav.popBackStack() })
        when {
            list == null && tracks.error != null -> Centered { ErrorState({ nonce++ }) }
            list == null -> Centered { Spinner() }
            else -> LazyVerticalGrid(GridCells.Adaptive(150.dp), Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                full("head") {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Art(api, item, 220.dp, round = artist)
                        Text(item.name.ifEmpty { route.name }, style = Type.title2, color = G.label, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 14.dp))
                        val by = listOfNotNull(item.albumArtist?.takeIf { route.type == "MusicAlbum" }, item.productionYear?.toString()).joinToString(" · ")
                        if (by.isNotEmpty()) Text(by, style = Type.callout, color = G.label2, textAlign = TextAlign.Center)
                        if (list.isNotEmpty()) Text(
                            pluralStringResource(R.plurals.music_songs_count, list.size, list.size) + " · " + clock(list.sumOf { it.durationMs() }),
                            style = Type.footnote, color = G.label3, modifier = Modifier.padding(top = 2.dp),
                        )
                        Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            PillButton(stringResource(R.string.music_play), { PlayerHolder.startMusic(context, api, list) }, icon = Ic.Play, primary = true, compact = true)
                            PillButton(stringResource(R.string.music_shuffle), { PlayerHolder.startMusic(context, api, list, shuffle = true) }, icon = Ic.Shuffle, compact = true)
                            PillButton(stringResource(R.string.music_mix), { scope.launch { playMix(context, api, route.id) } }, icon = Ic.Mix, compact = true)
                        }
                    }
                }
                if (albums.isNotEmpty()) {
                    full("albums-title") { SectionHead(stringResource(R.string.music_tab_albums)) }
                    items(albums, key = { "a-" + it.id }) { a ->
                        Column(Modifier.padding(horizontal = 10.dp)) { AlbumCard(api, a) { open(MusicRoute(a.id, a.type, a.name)) } }
                    }
                    full("songs-title") { SectionHead(stringResource(R.string.music_tab_songs)) }
                }
                val discs = route.type == "MusicAlbum" && list.mapNotNull { it.parentIndexNumber }.distinct().size > 1
                list.forEachIndexed { i, t ->
                    if (discs && (i == 0 || list[i - 1].parentIndexNumber != t.parentIndexNumber)) {
                        full("disc-${t.parentIndexNumber}-$i") { SectionHead(stringResource(R.string.music_disc, t.parentIndexNumber ?: 1)) }
                    }
                    full("t-$i-${t.id}") {
                        TrackRow(
                            api, t, onClick = { PlayerHolder.startMusic(context, api, list, i) }, playing = t.id == playing, onMenu = { menu = t },
                            number = if (route.type == "MusicAlbum") t.indexNumber ?: (i + 1) else null,
                        )
                    }
                }
            }
        }
    }
    menu?.let { TrackMenu(api, it, onDismiss = { menu = null }, open = open) }
}

private fun LazyGridScope.full(key: String, content: @Composable () -> Unit) = item(key, span = { GridItemSpan(maxLineSpan) }) { content() }

@Composable
private fun SectionHead(text: String) {
    Text(text, style = Type.title3, color = G.label, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 6.dp).semantics { heading() })
}
