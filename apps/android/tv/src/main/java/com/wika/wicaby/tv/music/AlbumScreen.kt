package com.wika.wicaby.tv.music

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
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
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.clock
import com.wika.wicaby.core.data.poster
import com.wika.wicaby.core.music.instantMix
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Centered
import com.wika.wicaby.tv.ui.ErrorState
import com.wika.wicaby.tv.ui.Ic
import com.wika.wicaby.tv.ui.LocalAccent
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.Spinner
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.rememberLoad
import com.wika.wicaby.tv.ui.tvFocus
import kotlinx.coroutines.launch

private class Album(val item: Item, val tracks: List<Item>)

/**
 * An album or audio playlist page (music spec §4.7, MU-09): art and title on the left, Lire / Aléatoire / Mix and the
 * tracks on the right. OK on a track plays the whole list from it in the music session; now playing opens over this
 * page, and Back from it lands here with the music still playing.
 */
@Composable
fun AlbumScreen(api: Api, id: String, name: String) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val loaded by rememberLoad("music-album-$id") {
        val item = api.item(id)
        // A playlist keeps its own order; an album goes by disc and track number.
        val order = if (item.type == "Playlist") emptyArray<Pair<String, Any?>>() else arrayOf<Pair<String, Any?>>("SortBy" to "ParentIndexNumber,IndexNumber,SortName")
        Album(item, api.items("ParentId" to id, "IncludeItemTypes" to "Audio", "Recursive" to true, *order, "Limit" to 1000).items.filter { SafeNames.isValidId(it.id) })
    }
    val album = loaded.value
    val playFocus = remember { FocusRequester() }
    LaunchedEffect(album != null) { if (album != null) runCatching { playFocus.requestFocus() } }
    val noMix = stringResource(R.string.music_mix_none)

    fun start(tracks: List<Item>, i: Int, shuffle: Boolean = false) {
        if (tracks.isEmpty()) return
        Music.play(context, api, tracks, i)
        if (shuffle) Music.session?.toggleShuffle()
    }

    Box(Modifier.fillMaxSize().background(C.bg).testTag("music-album")) {
        when {
            album == null && loaded.error != null -> Centered { ErrorState { com.wika.wicaby.tv.ui.Cache.changed() } }
            album == null -> Centered { Spinner() }
            else -> Row(Modifier.fillMaxSize().padding(start = 64.dp, end = 64.dp, top = 48.dp)) {
                val item = album.item
                val art = remember(item.id) { Servers.forItem(item, api).poster(item, 640) }
                Column(Modifier.width(320.dp)) {
                    Box(Modifier.size(320.dp).clip(RoundedCornerShape(Radius.lg)).background(C.elevated2), contentAlignment = Alignment.Center) {
                        if (art != null) AsyncImage(art, item.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                        else Icon(Ic.Play, null, tint = C.label3, modifier = Modifier.size(64.dp))
                    }
                    Text(item.name.ifEmpty { name }, style = Type.title2, color = C.label, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 20.dp))
                    (item.albumArtist ?: item.artistLine.takeIf { it.isNotEmpty() })?.let {
                        Text(it, style = Type.callout, color = C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                    }
                    val total = album.tracks.sumOf { it.runTimeTicks ?: 0 } / TICKS_PER_MS
                    val meta = listOfNotNull(
                        item.productionYear?.toString(),
                        pluralStringResource(R.plurals.items_count, album.tracks.size, album.tracks.size),
                        clock(total).takeIf { total > 0 },
                    ).joinToString(" · ")
                    Text(meta, style = Type.footnote, color = C.label3, modifier = Modifier.padding(top = 4.dp))
                }
                Spacer(Modifier.width(48.dp))
                Column(Modifier.weight(1f)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Pill(stringResource(R.string.play), icon = Ic.Play, primary = true, modifier = Modifier.focusRequester(playFocus).testTag("music-album-play"), onClick = { start(album.tracks, 0) })
                        Pill(stringResource(R.string.music_shuffle), icon = Ic.Shuffle, onClick = { start(album.tracks, album.tracks.indices.randomOrNull() ?: 0, shuffle = true) })
                        Pill(stringResource(R.string.music_mix), icon = Ic.Mix, onClick = {
                            scope.launch {
                                val mix = runCatching { api.instantMix(item.id).items }.getOrNull()?.filter { SafeNames.isValidId(it.id) }.orEmpty()
                                if (mix.isEmpty()) Toast.makeText(context, noMix, Toast.LENGTH_SHORT).show() else start(mix, 0)
                            }
                        })
                    }
                    LazyColumn(Modifier.fillMaxWidth().padding(top = 16.dp).testTag("music-tracks"), contentPadding = PaddingValues(top = 8.dp, bottom = 48.dp)) {
                        itemsIndexed(album.tracks, key = { i, it -> "$i:${it.id}" }) { i, t ->
                            TrackRow(t, i, playlist = item.type == "Playlist", albumArtist = item.albumArtist) { start(album.tracks, i) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TrackRow(t: Item, i: Int, playlist: Boolean, albumArtist: String?, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val playing = Music.session?.takeIf { Music.active }?.queue?.id == t.id
    val fg = if (focused) Color.Black else C.label
    val fg2 = if (focused) Color.Black.copy(alpha = 0.6f) else C.label3
    Row(
        Modifier.fillMaxWidth().testTag("music-track-$i")
            .tvFocus(RoundedCornerShape(Radius.sm), focusedScale = 1.02f, onFocusChange = { focused = it }, onClick = onClick)
            .background(if (focused) Color.White else Color.Transparent)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(36.dp)) {
            if (playing) Box(Modifier.size(8.dp).clip(RoundedCornerShape(50)).background(LocalAccent.current))
            else Text(((if (playlist) null else t.indexNumber) ?: (i + 1)).toString(), style = Type.mono, color = fg2)
        }
        Column(Modifier.weight(1f)) {
            Text(t.name, style = Type.headline, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            // The artist only where it differs from the album's (a compilation, a featured artist, a playlist).
            t.artistLine.takeIf { it.isNotEmpty() && it != albumArtist }?.let { Text(it, style = Type.callout, color = fg2, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        t.runTimeTicks?.let { Text(clock(it / TICKS_PER_MS), style = Type.mono, color = fg2, modifier = Modifier.padding(start = 16.dp)) }
    }
}
