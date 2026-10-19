package com.wika.wicaby.mobile.ui.photos

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.GlassIconButton
import com.wika.wicaby.core.photos.TimelineState
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.Alignment
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import coil3.compose.AsyncImage
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.photos.Photo
import com.wika.wicaby.core.photos.PhotoSource
import com.wika.wicaby.core.photos.photoAlbums
import com.wika.wicaby.core.photos.timelineQuery
import com.wika.wicaby.core.photos.Immich
import com.wika.wicaby.core.photos.ImmichException
import com.wika.wicaby.core.photos.ImmichTimeline
import com.wika.wicaby.core.photos.immichPhoto
import com.wika.wicaby.core.photos.setPhotoFavorite
import androidx.compose.foundation.shape.CircleShape
import com.wika.wicaby.mobile.ui.Cache
import com.wika.wicaby.mobile.ui.Centered
import com.wika.wicaby.mobile.ui.Chip
import com.wika.wicaby.mobile.ui.ErrorState
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.GridRoute
import com.wika.wicaby.mobile.ui.Radius
import com.wika.wicaby.mobile.ui.Spinner
import com.wika.wicaby.mobile.ui.TopBar
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.dpPx
import com.wika.wicaby.mobile.ui.rememberLoad
import kotlinx.coroutines.launch

// Photos spec §4.3 (PH-05): a photo library ("photos", or "homevideos" by decision O3) or one of its albums.
// Tabs: Timeline, Albums (the library's PhotoAlbum folders), Favourites. An album shows its own timeline.
val PHOTO_COLLECTIONS = setOf("photos", "homevideos", PHOTO_ALBUM, IMMICH, IMMICH_ALBUM, IMMICH_PERSON)
const val PHOTO_ALBUM = "photoalbum"
// An Immich source (photos spec PH-13), its own library: the source (parentId = its id), one of its albums or people.
const val IMMICH = "immich"
const val IMMICH_ALBUM = "immich-album"
const val IMMICH_PERSON = "immich-person"

@Composable
fun PhotosScreen(api: Api, route: GridRoute, nav: NavController) {
    val parent = route.parentId ?: return
    if (route.collectionType in setOf(IMMICH, IMMICH_ALBUM, IMMICH_PERSON)) return ImmichPhotos(api, route, nav)
    val album = route.collectionType == PHOTO_ALBUM
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var density by rememberSaveable { mutableIntStateOf(1) }
    Column(Modifier.fillMaxSize()) {
        TopBar(route.title, onBack = { nav.popBackStack() })
        if (!album) LazyRow(contentPadding = PaddingValues(horizontal = 20.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val tabs = listOf(CoreR.string.photos_tab_timeline, CoreR.string.photos_tab_albums, CoreR.string.photos_tab_favorites)
            tabs.forEachIndexed { i, label -> item(i) { Chip(stringResource(label), selected = i == tab) { tab = i } } }
        }
        when (tab) {
            1 -> Albums(api, parent) { a -> nav.navigate(GridRoute(a.name, parentId = a.id, collectionType = PHOTO_ALBUM, serverId = route.serverId)) }
            else -> {
                val favorites = tab == 2
                Timeline(api, timelineKey(api, parent, favorites), timelineKey(api, parent, !favorites), density, { density = it }) { t, force ->
                    t.load(PhotoSource(api.timelineQuery(parent, favorites)), force)
                }
            }
        }
    }
}

private fun timelineKey(api: Api, parent: String, favorites: Boolean) = "photos-${api.server.id}-$parent-$favorites"

// Tabs of an Immich source: Timeline, Albums, Favourites, People; an album or a person shows its own timeline.
// Its memories join the home row ("Ce jour-là"); a missing permission names itself where its tab would be.
@Composable
private fun ImmichPhotos(api: Api, route: GridRoute, nav: NavController) {
    val id = route.parentId ?: return
    val root = route.collectionType == IMMICH
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var density by rememberSaveable { mutableIntStateOf(1) }
    Column(Modifier.fillMaxSize()) {
        TopBar(route.title, onBack = { nav.popBackStack() })
        if (root) LazyRow(contentPadding = PaddingValues(horizontal = 20.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val tabs = listOf(CoreR.string.photos_tab_timeline, CoreR.string.photos_tab_albums, CoreR.string.photos_tab_favorites, CoreR.string.photos_tab_people)
            tabs.forEachIndexed { i, label -> item(i) { Chip(stringResource(label), selected = i == tab) { tab = i } } }
        }
        val filter = when (route.collectionType) {
            IMMICH_ALBUM -> ImmichTimeline.Filter(albumId = id)
            IMMICH_PERSON -> ImmichTimeline.Filter(personId = id)
            else -> ImmichTimeline.Filter(favorites = tab == 2)
        }
        when {
            root && tab == 1 -> ImmichGrid("album", { Immich.client().albums().map { ImmichCard(it.id, it.name, it.coverId?.let { c -> Immich.client().thumb(c, "preview") }, it.count, it.shared, false) } }) { c ->
                nav.navigate(GridRoute(c.name, parentId = c.id, collectionType = IMMICH_ALBUM))
            }
            root && tab == 3 -> ImmichGrid("person", { Immich.client().people().map { ImmichCard(it.id, it.name, Immich.client().face(it.id), null, false, true) } }) { c ->
                nav.navigate(GridRoute(c.name, parentId = c.id, collectionType = IMMICH_PERSON))
            }
            else -> {
                val key = "immich-${Immich.source?.id}-$filter"
                val other = if (root) "immich-${Immich.source?.id}-${filter.copy(favorites = !filter.favorites)}" else null
                Timeline(api, key, other, density, { density = it }) { t, force ->
                    t.load(force) { onPage -> Immich.client().timeline(filter) { a, n -> onPage(a.map(::immichPhoto), n) }.assets.map(::immichPhoto) }
                }
            }
        }
    }
}

private class ImmichCard(val id: String, val name: String, val cover: String?, val count: Int?, val shared: Boolean, val round: Boolean)

// Albums or people of the Immich source, read-only. A 403 shows which permission the key lacks.
@Composable
private fun ImmichGrid(kind: String, load: suspend () -> List<ImmichCard>, onOpen: (ImmichCard) -> Unit) {
    var nonce by remember { mutableIntStateOf(0) }
    val cards = rememberLoad("immich-$kind-${Immich.source?.id}", nonce) { load() }
    val list = cards.value
    val err = cards.error as? ImmichException
    when {
        list == null && err != null && (err.status == 403 || err.status == 401) -> Centered {
            Text(
                if (err.status == 401) stringResource(CoreR.string.photos_sources_key_refused) else stringResource(CoreR.string.photos_sources_scope_missing, if (kind == "album") "album.read" else "person.read"),
                style = Type.body, color = G.label2, modifier = Modifier.padding(32.dp).testTag("immich-scope"),
            )
        }
        list == null && cards.error != null -> Centered { ErrorState({ nonce++ }) }
        list == null -> Centered { Spinner() }
        list.isEmpty() -> Centered { Text(stringResource(if (kind == "album") CoreR.string.photos_empty else CoreR.string.photos_people_empty), style = Type.body, color = G.label2) }
        else -> LazyVerticalGrid(
            columns = GridCells.Adaptive(if (kind == "album") 150.dp else 110.dp),
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 24.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            items(list, key = { it.id }) { c ->
                Column(Modifier.clickable(role = Role.Button) { onOpen(c) }, horizontalAlignment = if (c.round) Alignment.CenterHorizontally else Alignment.Start) {
                    AsyncImage(
                        c.cover, c.name, contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxWidth().aspectRatio(1f).clip(if (c.round) CircleShape else RoundedCornerShape(Radius.sm)).background(G.fill1),
                    )
                    Text(c.name, style = Type.headline, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
                    c.count?.let {
                        val n = pluralStringResource(CoreR.plurals.photos_count, it, it)
                        Text(if (c.shared) "$n · ${stringResource(CoreR.string.photos_album_shared)}" else n, style = Type.footnote, color = G.label3)
                    }
                }
            }
        }
    }
}

// key: the session cache entry; other: the sibling view a favourite change invalidates (timeline <-> favourites).
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Timeline(api: Api, key: String, other: String?, density: Int, onDensity: (Int) -> Unit, load: suspend (TimelineState, Boolean) -> Unit) {
    val t = remember(key) { Cache.map.getOrPut(key) { TimelineState() } as TimelineState }
    var nonce by remember { mutableIntStateOf(0) }
    var open by rememberSaveable { mutableStateOf<Int?>(null) }
    // Spec §4.3: a long press starts a selection (v1: Favourite and Slideshow from here); taps then toggle.
    var selected by remember(key) { mutableStateOf(emptySet<String>()) }
    var slideFrom by remember { mutableStateOf<Int?>(null) }
    val scope = rememberCoroutineScope()
    // A load cut short (the tab left mid-paging) resumes here: only a complete timeline is reused (TimelineState).
    var pulled by remember { mutableStateOf(false) }
    LaunchedEffect(t, nonce) { load(t, nonce > 0); pulled = false }
    fun setFavorite(i: Int, on: Boolean) {
        t.photos = t.photos.toMutableList().also { l -> l[i] = l[i].copy(asset = l[i].asset.copy(favorite = on)) }
        // The other tab reloads with the change.
        other?.let { Cache.map.remove(it) }
    }
    BackHandler(selected.isNotEmpty()) { selected = emptySet() }
    PullToRefreshBox(isRefreshing = pulled, onRefresh = { pulled = true; nonce++ }, modifier = Modifier.fillMaxSize()) {
        when {
            t.failed -> Centered { ErrorState({ nonce++ }) }
            t.total < 0 -> Centered { Spinner() }
            t.total == 0 && t.photos.isEmpty() -> Centered { Text(stringResource(CoreR.string.photos_empty), style = Type.body, color = G.label2) }
            else -> PhotoGrid(
                api, t.photos, density, onDensity,
                onOpen = { i -> if (selected.isEmpty()) open = i else t.photos[i].asset.id.let { selected = if (it in selected) selected - it else selected + it } },
                modifier = Modifier.fillMaxSize(),
                selected = selected,
                onLongPress = { i -> selected = selected + t.photos[i].asset.id },
            )
        }
        if (selected.isNotEmpty()) {
            val idx = t.photos.indices.filter { t.photos[it].asset.id in selected }
            val allFav = idx.all { t.photos[it].asset.favorite }
            SelectionBar(
                selected.size, allFav, Modifier.align(Alignment.BottomCenter),
                onFavorite = {
                    scope.launch {
                        for (i in idx) runCatching { api.setPhotoFavorite(t.photos[i].asset, !allFav) }.onSuccess { setFavorite(i, !allFav) }
                        selected = emptySet()
                    }
                },
                // "From here": the first selected asset in timeline order, then on through the timeline.
                onSlideshow = { slideFrom = idx.firstOrNull(); selected = emptySet() },
                onClear = { selected = emptySet() },
            )
        }
    }
    open?.let { start ->
        PhotoViewerDialog(api, t.photos, start, onClose = { open = null }, onFavorite = ::setFavorite)
    }
    slideFrom?.let { start ->
        Dialog({ slideFrom = null }, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
            Slideshow(api, t.photos, start) { slideFrom = null }
        }
    }
}

@Composable
private fun SelectionBar(count: Int, allFavorite: Boolean, modifier: Modifier, onFavorite: () -> Unit, onSlideshow: () -> Unit, onClear: () -> Unit) {
    Row(
        modifier.navigationBarsPadding().padding(12.dp).fillMaxWidth().background(G.elevated2, RoundedCornerShape(Radius.lg))
            .padding(horizontal = 12.dp, vertical = 8.dp).testTag("photo-selection"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        GlassIconButton(Ic.Close, stringResource(CoreR.string.photos_select_clear), onClear)
        Text(pluralStringResource(CoreR.plurals.photos_selected, count, count), style = Type.headline, color = G.label, maxLines = 1, modifier = Modifier.weight(1f))
        GlassIconButton(
            if (allFavorite) Ic.HeartFilled else Ic.Heart,
            stringResource(if (allFavorite) CoreR.string.photos_viewer_unfavorite else CoreR.string.photos_viewer_favorite), onFavorite,
        )
        GlassIconButton(Ic.Slideshow, stringResource(CoreR.string.photos_slideshow_from_here), onSlideshow)
    }
}

@Composable
private fun Albums(api: Api, parent: String, onOpen: (Item) -> Unit) {
    var nonce by remember { mutableIntStateOf(0) }
    val albums = rememberLoad("photo-albums-${api.server.id}-$parent", nonce) { api.photoAlbums(parent) }
    val list = albums.value
    when {
        list == null && albums.error != null -> Centered { ErrorState({ nonce++ }) }
        list == null -> Centered { Spinner() }
        list.isEmpty() -> Centered { Text(stringResource(CoreR.string.photos_empty), style = Type.body, color = G.label2) }
        else -> LazyVerticalGrid(
            columns = GridCells.Adaptive(150.dp),
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 24.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            items(list, key = { it.id }) { a ->
                val px = dpPx(200.dp)
                Column(Modifier.clickable(role = Role.Button) { onOpen(a) }) {
                    AsyncImage(
                        a.imageTags["Primary"]?.let { api.image(a.id, "Primary", it, maxWidth = px) }, a.name, contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(Radius.sm)).background(G.fill1),
                    )
                    Text(a.name, style = Type.headline, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
                    a.childCount?.let { Text(pluralStringResource(CoreR.plurals.photos_count, it, it), style = Type.footnote, color = G.label3) }
                }
            }
        }
    }
}

// A single Photo opened from elsewhere (search, home rows): the viewer over that one item.
@Composable
fun PhotoScreen(api: Api, id: String, nav: NavController) {
    val item by produceState<Item?>(null, id) { value = runCatching { api.item(id) }.getOrNull() }
    val it = item ?: return Box(Modifier.fillMaxSize().background(G.bg)) { Centered { Spinner() } }
    PhotoViewer(api, listOf(Photo(com.wika.wicaby.core.photos.toAsset(it), it)), 0, onClose = { nav.popBackStack() })
}
