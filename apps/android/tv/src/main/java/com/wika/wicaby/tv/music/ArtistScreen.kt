package com.wika.wicaby.tv.music

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.SafeNames
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.data.backdrop
import com.wika.wicaby.core.data.poster
import com.wika.wicaby.core.player.PlayQueue
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.ui.Backdrop
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Centered
import com.wika.wicaby.tv.ui.ErrorState
import com.wika.wicaby.tv.ui.Ic
import com.wika.wicaby.tv.ui.MediaRow
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.Spinner
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.rememberFocusMemory
import com.wika.wicaby.tv.ui.rememberLoad
import com.wika.wicaby.tv.ui.route
import kotlinx.coroutines.launch

/** Desktop's artist page split (music spec §4.3): own albums, singles & EPs, and the albums the artist appears on. */
internal class Discography(val albums: List<Item>, val singles: List<Item>, val appearsOn: List<Item>)

// shortcut: as desktop, a single/EP is an album of 1 to 3 tracks (ChildCount); upgrade with a release-type tag if servers expose one.
internal fun discography(artistId: String, all: List<Item>): Discography {
    val (own, appearsOn) = all.partition { a -> a.albumArtists.isEmpty() || a.albumArtists.any { it.id == artistId } }
    val (singles, albums) = own.partition { (it.childCount ?: 0) in 1..3 }
    return Discography(albums, singles, appearsOn)
}

private class Artist(val item: Item, val discography: Discography)

/**
 * An artist page (desktop and mobile's): the artist's art over their backdrop, Lire / Aléatoire (every track, by album)
 * and rows of albums, singles & EPs and "appears on"; OK on an album opens its page. Focus starts on Lire.
 */
@Composable
fun ArtistScreen(api: Api, id: String, name: String) {
    val context = LocalContext.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val memory = rememberFocusMemory()
    val loaded by rememberLoad("music-artist-$id") {
        // As desktop: ArtistIds on both servers (album artist or credited on a track).
        val albums = api.items("ArtistIds" to id, "IncludeItemTypes" to "MusicAlbum", "Recursive" to true, "SortBy" to "ProductionYear,SortName", "SortOrder" to "Descending")
        Artist(api.item(id), discography(id, albums.items.filter { SafeNames.isValidId(it.id) }))
    }
    val artist = loaded.value
    val playFocus = remember { FocusRequester() }
    LaunchedEffect(artist != null) { if (artist != null) runCatching { playFocus.requestFocus() } }

    fun play(shuffle: Boolean) = scope.launch {
        val item = artist?.item ?: return@launch
        val tracks = runCatching { api.tracksOf(PlayQueue.tracks(api, item)) }.getOrNull().orEmpty()
        if (tracks.isEmpty()) return@launch
        Music.play(context, api, tracks, if (shuffle) tracks.indices.random() else 0)
        if (shuffle) Music.session?.toggleShuffle()
    }

    Box(Modifier.fillMaxSize().background(C.bg).testTag("music-artist")) {
        Backdrop(artist?.item?.let { remember(it.id) { api.backdrop(it) } }, dim = 0.55f)
        when {
            artist == null && loaded.error != null -> Centered { ErrorState { com.wika.wicaby.tv.ui.Cache.changed() } }
            artist == null -> Centered { Spinner() }
            else -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(top = 48.dp, bottom = 56.dp)) {
                val item = artist.item
                val art = remember(item.id) { Servers.forItem(item, api).poster(item, 480) }
                Row(Modifier.padding(horizontal = 64.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(200.dp).clip(CircleShape).background(C.elevated2), contentAlignment = Alignment.Center) {
                        if (art != null) AsyncImage(art, item.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                        else Icon(Ic.Person, null, tint = C.label3, modifier = Modifier.size(64.dp))
                    }
                    Column(Modifier.padding(start = 40.dp)) {
                        Text(item.name.ifEmpty { name }, style = Type.largeTitle, color = C.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Row(Modifier.padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Pill(stringResource(R.string.play), icon = Ic.Play, primary = true, modifier = Modifier.focusRequester(playFocus).testTag("music-artist-play"), onClick = { play(false) })
                            Pill(stringResource(R.string.music_shuffle), icon = Ic.Shuffle, onClick = { play(true) })
                        }
                    }
                }
                Spacer(Modifier.height(16.dp))
                listOf(
                    "albums" to (R.string.music_albums to artist.discography.albums),
                    "singles" to (R.string.music_singles to artist.discography.singles),
                    "appears" to (R.string.music_appears_on to artist.discography.appearsOn),
                ).forEach { (key, row) ->
                    val (label, items) = row
                    if (items.isNotEmpty()) {
                        MediaRow(
                            stringResource(label), items, api, memory, "artist-$key", wide = false, onFocusItem = {}, square = true,
                            onClick = { nav.push(it.route()) }, modifier = Modifier.testTag("music-artist-$key"),
                        )
                    }
                }
            }
        }
    }
}
