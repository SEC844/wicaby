package com.wika.wicaby.mobile.music

import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ListKind
import com.wika.wicaby.core.data.Playlists
import com.wika.wicaby.core.data.addToList
import com.wika.wicaby.core.data.createList
import com.wika.wicaby.core.data.lists
import com.wika.wicaby.core.music.instantMix
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.player.PlayerHolder
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.Radius
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.rememberLoad
import kotlinx.coroutines.launch

/** Plays [items] next or at the end of the music queue; with no music playing, they start one. */
fun enqueue(context: android.content.Context, api: Api, items: List<Item>, next: Boolean) {
    val s = PlayerHolder.music
    when {
        items.isEmpty() -> Unit
        s == null -> PlayerHolder.startMusic(context, api, items)
        next -> s.playNext(items)
        else -> s.addToQueue(items)
    }
}

/** "Mix" (§3.3): the server's instant mix of a track, album, artist, genre or playlist, played as the queue. */
suspend fun playMix(context: android.content.Context, api: Api, id: String) {
    val mix = runCatching { api.instantMix(id).items }.getOrNull()
    if (!mix.isNullOrEmpty()) PlayerHolder.startMusic(context, api, mix)
}

/** The long-press menu of a song (bottom sheet). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrackMenu(api: Api, item: Item, onDismiss: () -> Unit, open: ((MusicRoute) -> Unit)? = null) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pick by remember { mutableStateOf(false) }
    if (pick) return PlaylistPicker(api, item, onDismiss)
    ModalBottomSheet(onDismiss, containerColor = G.elevated, contentColor = G.label, shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl)) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 12.dp)) {
            Text(item.name, style = Type.headline, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
            MenuRow(Ic.Play, stringResource(R.string.music_play_next)) { enqueue(context, api, listOf(item), next = true); onDismiss() }
            MenuRow(Ic.Queue, stringResource(R.string.music_add_to_queue)) { enqueue(context, api, listOf(item), next = false); onDismiss() }
            MenuRow(Ic.Plus, stringResource(R.string.music_add_to_playlist)) { pick = true }
            MenuRow(Ic.Mix, stringResource(R.string.music_mix_from_track)) { scope.launch { playMix(context, api, item.id) }; onDismiss() }
            val artist = (item.albumArtists + item.artistItems).firstOrNull { it.id != null }
            if (open != null && artist != null) MenuRow(Ic.User, stringResource(R.string.music_go_to_artist)) { onDismiss(); open(MusicRoute(artist.id!!, "MusicArtist", artist.name)) }
            val album = item.albumId
            if (open != null && album != null) MenuRow(Ic.Music, stringResource(R.string.music_go_to_album)) { onDismiss(); open(MusicRoute(album, "MusicAlbum", item.album.orEmpty())) }
        }
    }
}

@Composable
private fun MenuRow(icon: ImageVector, text: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(52.dp).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 24.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Icon(icon, null, tint = G.label2, modifier = Modifier.size(22.dp))
        Text(text, style = Type.body, color = G.label)
    }
}

/** "Ajouter à une playlist…": the audio playlists, or a new one. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlaylistPicker(api: Api, item: Item, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val all = rememberLoad("music-playlists") { api.lists(ListKind.Playlist).filter { it.mediaType == "Audio" } }.value
    var naming by remember { mutableStateOf(false) }
    val added = stringResource(R.string.music_added)
    fun done(block: suspend () -> Unit) {
        scope.launch {
            if (runCatching { block() }.isSuccess) Toast.makeText(context, added, Toast.LENGTH_SHORT).show()
            com.wika.wicaby.mobile.ui.Cache.map.remove("music-playlists")
            onDismiss()
        }
    }
    if (naming) return NameDialog(onDismiss) { name -> done { api.createList(ListKind.Playlist, name, item) } }
    ModalBottomSheet(onDismiss, containerColor = G.elevated, contentColor = G.label, shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl)) {
        Column(Modifier.navigationBarsPadding().verticalScroll(rememberScrollState()).padding(bottom = 12.dp)) {
            MenuRow(Ic.Plus, stringResource(R.string.music_new_playlist)) { naming = true }
            Playlists.targetsFor(ListKind.Playlist, item, all.orEmpty()).forEach { list -> MenuRow(Ic.List, list.name) { done { api.addToList(ListKind.Playlist, list.id, item) } } }
        }
    }
}

/** A playlist name (new playlist, "Enregistrer comme playlist"). */
@Composable
fun NameDialog(onDismiss: () -> Unit, onDone: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = G.elevated2,
        title = { Text(stringResource(R.string.music_playlist_name), style = Type.title3, color = G.label) },
        text = { OutlinedTextField(name, { name = it }, singleLine = true, label = { Text(stringResource(R.string.music_playlist_name)) }) },
        confirmButton = { TextButton(onClick = { onDone(name.trim()) }, enabled = name.isNotBlank()) { Text(stringResource(R.string.music_create)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}
