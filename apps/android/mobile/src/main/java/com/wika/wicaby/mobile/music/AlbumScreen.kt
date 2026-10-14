package com.wika.wicaby.mobile.music

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridScope
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items as rowItems
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import coil3.SingletonImageLoader
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.posterArt
import com.wika.wicaby.core.music.MusicArt
import com.wika.wicaby.core.music.MusicUi
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
import com.wika.wicaby.mobile.ui.dpPx
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
    val album = route.type == "MusicAlbum"
    // Feishin-inspired (music spec C4, C7): more albums by the album's artist; similar artists on an artist page.
    val byArtist = item.albumArtists.firstOrNull()?.takeIf { album }
    val moreFrom = if (byArtist != null) rememberLoad("music-more-from-${route.id}", nonce) {
        val by = if (api.server.isEmby) arrayOf("ArtistIds" to byArtist.id, "ArtistType" to "AlbumArtist") else arrayOf<Pair<String, Any?>>("AlbumArtistIds" to byArtist.id)
        api.items(*by, "IncludeItemTypes" to "MusicAlbum", "Recursive" to true, "SortBy" to "ProductionYear,SortName", "SortOrder" to "Descending", "Limit" to 25).items.filter { it.id != route.id }
    }.value.orEmpty() else emptyList()
    val similar = if (artist) rememberLoad("music-similar-${route.id}", nonce) { api.similar(route.id) }.value.orEmpty() else emptyList()
    // The header takes the cover's dominant colour behind the art only (never text or controls), as desktop's hero.
    val headerPx = dpPx(220.dp)
    val headerArt = remember(item, headerPx) { api.posterArt(item, headerPx) }
    val tint by produceState<Color?>(null, headerArt) {
        value = headerArt?.let { MusicArt.colour(SingletonImageLoader.get(context), context, it) }?.let { Color(0xFF000000 or it.toLong()) }
    }
    // Long-press multi-select (C3): then a tap toggles a row, and the bar plays the selection next or last.
    val selected = remember(route.id) { mutableStateListOf<String>() }
    val toggle: (Item) -> Unit = { t -> if (!selected.remove(t.id)) selected.add(t.id) }

    Column(Modifier.fillMaxSize()) {
        TopBar(route.name, onBack = { nav.popBackStack() })
        when {
            list == null && tracks.error != null -> Centered { ErrorState({ nonce++ }) }
            list == null -> Centered { Spinner() }
            else -> LazyVerticalGrid(GridCells.Adaptive(150.dp), Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(bottom = 24.dp)) {
                full("head") {
                    val wash = tint?.let { Modifier.background(Brush.verticalGradient(listOf(lerp(G.bg, it, 0.35f), G.bg))) } ?: Modifier
                    Column(Modifier.fillMaxWidth().then(wash).padding(horizontal = 20.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Art(api, item, 220.dp, round = artist)
                        if (album && list.isNotEmpty()) {
                            val kind = MusicUi.releaseType(list.size, list.sumOf { it.durationMs() }, item.albumArtist)
                            Text(stringResource(RELEASE.getValue(kind)), style = Type.footnote, color = G.label3, modifier = Modifier.padding(top = 14.dp))
                        }
                        Text(item.name.ifEmpty { route.name }, style = Type.title2, color = G.label, textAlign = TextAlign.Center, modifier = Modifier.padding(top = if (album && list.isNotEmpty()) 2.dp else 14.dp))
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
                            api, t, onClick = { if (selected.isEmpty()) PlayerHolder.startMusic(context, api, list, i) else toggle(t) }, playing = t.id == playing, onMenu = { menu = t },
                            number = if (route.type == "MusicAlbum") t.indexNumber ?: (i + 1) else null,
                            onLongClick = { toggle(t) }, selected = t.id in selected,
                        )
                    }
                }
                if (moreFrom.isNotEmpty() && byArtist != null) {
                    full("more-from-title") { SectionHead(stringResource(R.string.music_more_from, byArtist.name)) }
                    full("more-from") {
                        LazyRow(contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            rowItems(moreFrom, key = { it.id }) { a -> Column(Modifier.width(140.dp)) { AlbumCard(api, a) { open(MusicRoute(a.id, a.type, a.name)) } } }
                        }
                    }
                }
                if (similar.isNotEmpty()) {
                    full("similar-title") { SectionHead(stringResource(R.string.music_similar_artists)) }
                    full("similar") {
                        LazyRow(contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            rowItems(similar, key = { it.id }) { a ->
                                Column(Modifier.width(96.dp).clickable(role = Role.Button) { open(MusicRoute(a.id, a.type, a.name)) }, horizontalAlignment = Alignment.CenterHorizontally) {
                                    Art(api, a, 96.dp, round = true)
                                    Text(a.name, style = Type.footnote, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
                                }
                            }
                        }
                    }
                }
            }
        }
        if (selected.isNotEmpty() && list != null) {
            val chosen = list.filter { it.id in selected }
            Row(
                Modifier.fillMaxWidth().background(G.elevated2).padding(horizontal = 16.dp, vertical = 10.dp).testTag("music-selection-bar"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(pluralStringResource(R.plurals.music_selected, chosen.size, chosen.size), style = Type.callout, color = G.label, modifier = Modifier.weight(1f))
                PillButton(stringResource(R.string.music_play_next), { enqueue(context, api, chosen, next = true); selected.clear() }, icon = Ic.Play, compact = true)
                PillButton(stringResource(R.string.music_add_to_queue), { enqueue(context, api, chosen, next = false); selected.clear() }, icon = Ic.Queue, compact = true)
                IconBtn(Ic.Close, stringResource(R.string.music_clear_selection), { selected.clear() })
            }
        }
    }
    menu?.let { TrackMenu(api, it, onDismiss = { menu = null }, open = open) }
}

private val RELEASE = mapOf(
    MusicUi.Release.ALBUM to R.string.music_release_album,
    MusicUi.Release.EP to R.string.music_release_ep,
    MusicUi.Release.SINGLE to R.string.music_release_single,
    MusicUi.Release.COMPILATION to R.string.music_release_compilation,
)

private fun LazyGridScope.full(key: String, content: @Composable () -> Unit) = item(key, span = { GridItemSpan(maxLineSpan) }) { content() }

@Composable
private fun SectionHead(text: String) {
    Text(text, style = Type.title3, color = G.label, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 6.dp).semantics { heading() })
}
