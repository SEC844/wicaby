package com.wika.wicaby.mobile.music

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.SingletonImageLoader
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ItemsResult
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.posterArt
import com.wika.wicaby.core.music.MusicArt
import com.wika.wicaby.core.music.MusicSession
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.LocalAccent
import com.wika.wicaby.mobile.ui.Radius
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.dpPx
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable

// Music on the phone (music spec MU-08, §4.6): the shared pieces of the library, album and player screens.

/** An album, artist, playlist or genre page. */
@Serializable
data class MusicRoute(val id: String, val type: String, val name: String, val serverId: String? = null)

/** Item types that open a music page rather than a folder grid or a detail page. */
val MUSIC_PAGES = setOf("MusicAlbum", "MusicArtist", "MusicGenre")

fun Item.opensMusicPage() = type in MUSIC_PAGES || (type == "Playlist" && mediaType == "Audio")

/** The full-screen player over the app (mini player tap, notification, lock screen). */
object NowPlaying {
    var open by mutableStateOf(false)
}

/** 3:25, 1:02:03. */
fun clock(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

fun Item.durationMs() = (runTimeTicks ?: 0) / TICKS_PER_MS

/** The tracks a page plays, in its order (§3.1): album by disc and number, playlist as listed, artist and genre by album. */
suspend fun tracksOf(api: Api, id: String, type: String, name: String): List<Item> {
    val sorted = "Album,ParentIndexNumber,IndexNumber,SortName"
    val q: Array<Pair<String, Any?>> = when (type) {
        "Playlist" -> arrayOf("ParentId" to id)
        "MusicArtist" -> arrayOf("ArtistIds" to id, "SortBy" to sorted)
        // Emby's GenreIds is unverified on 4.8+ (spec §3.1): its genre name instead.
        "MusicGenre" -> arrayOf((if (api.server.isEmby) "Genres" to name else "GenreIds" to id), "SortBy" to sorted)
        else -> arrayOf("ParentId" to id, "SortBy" to "ParentIndexNumber,IndexNumber,SortName")
    }
    return api.items(*q, "IncludeItemTypes" to "Audio", "Recursive" to true, "Limit" to 500, "Fields" to api.trackFields).items
}

/** Adds the items of [page] not listed yet: offset paging repeats one when the server's order shifts between two
 *  pages (a title imported meanwhile), and a repeated key crashes a lazy list. */
fun MutableList<Item>.addNew(page: List<Item>) {
    val seen = mapTo(HashSet()) { it.id }
    addAll(page.filter { seen.add(it.id) })
}

/** A paged list (albums, songs): the next 100 when the end comes into view. */
class Pages(private val load: suspend (start: Int) -> ItemsResult) {
    val items = mutableStateListOf<Item>()
    var total by mutableIntStateOf(-1)
    var failed by mutableStateOf(false)
    private var loading = false
    // The server's offset: items can be fewer once repeats are dropped.
    private var offset = 0

    suspend fun more() {
        if (loading || (total >= 0 && offset >= total)) return
        loading = true
        try {
            val r = load(offset)
            offset += r.items.size
            items.addNew(r.items)
            total = if (r.items.isEmpty()) offset else r.totalRecordCount
            failed = false
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            failed = items.isEmpty()
        } finally {
            loading = false
        }
    }
}

// The music cover (music spec §4.A): own art, a borrowed one (an album's first track, an artist's first album), else the
// initials on a colour from the name. Keyed on the item, not its id: the album page's stand-in item (no image tags)
// is replaced by the loaded one, which must recompute the URL (the header race, MU-A1).
@Composable
fun Art(api: Api, item: Item, size: Dp, modifier: Modifier = Modifier, round: Boolean = false) {
    val px = dpPx(size)
    val art = remember(item, px) { api.posterArt(item, px) }
    var failed by remember(art) { mutableStateOf(false) }
    Box(modifier.size(size).clip(if (round) CircleShape else RoundedCornerShape(if (size < 64.dp) Radius.xs else Radius.md)).background(G.elevated2), contentAlignment = Alignment.Center) {
        if (art == null || failed) ArtPlaceholder(item.name, size)
        if (art != null && !failed) AsyncImage(art, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize().testTag("music-art"), onError = { failed = true })
    }
}

/** The full-screen player's art cap (MU-A5: raised from 380 dp, tablets and landscape). */
val NOW_PLAYING_ART = 520.dp

/** The next track's covers at the mini player's and the player's sizes, fetched ahead so both switch without a gap (MU-A5). */
@Composable
fun PrefetchNextArt(s: MusicSession) {
    val context = LocalContext.current
    val sizes = listOf(dpPx(44.dp), dpPx(minOf(LocalConfiguration.current.screenWidthDp.dp - 48.dp, NOW_PLAYING_ART)))
    val next = s.queue.nextId?.let { s.known[it] }
    LaunchedEffect(next?.id) {
        val n = next ?: return@LaunchedEffect
        val loader = SingletonImageLoader.get(context)
        for (px in sizes) s.api.posterArt(n, px)?.let { loader.enqueue(ImageRequest.Builder(context).data(it).build()) }
    }
}

/** Initials on a colour from the name (MU-A4, core MusicArt). */
@Composable
fun ArtPlaceholder(name: String, size: Dp) {
    Box(Modifier.fillMaxSize().background(Color(0xFF000000 or MusicArt.tileRgb(MusicArt.hue(name)).toLong())).testTag("music-art-placeholder"), contentAlignment = Alignment.Center) {
        Text(MusicArt.initials(name), color = Color.White.copy(alpha = 0.92f), fontSize = (size.value * 0.36f).sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

/** One song: number (album pages) or art, title, artists, duration; long press for the track menu. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TrackRow(
    api: Api, item: Item, onClick: () -> Unit, modifier: Modifier = Modifier, number: Int? = null, playing: Boolean = false,
    onMenu: (() -> Unit)? = null, trailing: (@Composable () -> Unit)? = null,
    // The album page's multi-select (music spec C3): a long press selects instead of opening the menu ("⋯" still does).
    onLongClick: (() -> Unit)? = onMenu, selected: Boolean = false,
) {
    Row(
        modifier.fillMaxWidth().height(56.dp)
            .background(if (selected) LocalAccent.current.copy(alpha = 0.18f) else Color.Transparent)
            .combinedClickable(role = Role.Button, onLongClick = onLongClick, onClick = onClick).padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (number != null) {
            Box(Modifier.width(28.dp), contentAlignment = Alignment.Center) {
                if (playing) Icon(Ic.Music, null, tint = LocalAccent.current, modifier = Modifier.size(16.dp))
                else Text(number.toString(), style = Type.mono, color = G.label3)
            }
        } else Art(api, item, 44.dp)
        Column(Modifier.weight(1f)) {
            Text(item.name, style = Type.headline, color = if (playing) LocalAccent.current else G.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val artists = item.artistLine
            if (artists.isNotEmpty()) Text(artists, style = Type.callout, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (item.runTimeTicks != null) Text(clock(item.durationMs()), style = Type.mono, color = G.label3)
        trailing?.invoke()
        if (onMenu != null) {
            Box(Modifier.size(32.dp).clip(CircleShape).combinedClickable(role = Role.Button, onClick = onMenu), contentAlignment = Alignment.Center) {
                Icon(Ic.More, stringResource(R.string.music_options), tint = G.label2, modifier = Modifier.size(20.dp))
            }
        }
    }
}
