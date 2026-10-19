package com.wika.wicaby.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import coil3.compose.AsyncImage
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.music.addNew
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LibrariesScreen(api: Api, nav: NavController) {
    var nonce by remember { mutableIntStateOf(0) }
    // Both counters only grow: a music source change reloads, the list staying on screen meanwhile.
    val views = rememberLoad("views", nonce + com.wika.wicaby.core.music.MusicSource.version) { allViews(api).filter { it.collectionType in BROWSABLE } }
    val photoSources by com.wika.wicaby.core.files.FileSources.photos.collectAsState()
    // As Home: the indicator stays while a pulled reload runs.
    var pulled by remember { mutableStateOf(false) }
    LaunchedEffect(views.loading) { if (!views.loading) pulled = false }
    PullToRefreshBox(isRefreshing = pulled && views.loading, onRefresh = { pulled = true; nonce++ }, modifier = Modifier.fillMaxSize()) {
        val list = views.value
        when {
            list == null && views.error != null -> Centered { ErrorState({ nonce++ }) }
            list == null -> Centered { Spinner() }
            else -> LazyVerticalGrid(
                columns = GridCells.Adaptive(300.dp),
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 24.dp),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                item("title", span = { GridItemSpan(maxLineSpan) }) { LargeTitle(stringResource(R.string.tab_libraries)) }
                if (list.isEmpty()) item("empty", span = { GridItemSpan(maxLineSpan) }) { Text(stringResource(R.string.no_libraries), style = Type.body, color = G.label2) }
                // IPTV (core/iptv) right after Live TV; without a server tuner, Live TV opens its setup page.
                val live = list.indexOfLast { it.collectionType == "livetv" }
                val split = if (live < 0) list.size else live + 1
                val library: @Composable (Item) -> Unit = { v -> LibraryCard(Servers.forItem(v, api), v, viewLabel(v, list)) { nav.navigate(GridRoute(v.name, parentId = v.id, collectionType = v.collectionType, serverId = Servers.extraOf(v.serverId)?.server?.id)) } }
                items(list.take(split), key = { Servers.libraryRef(it) }) { library(it) }
                if (live < 0) item("livetv-setup") {
                    val title = stringResource(com.wika.wicaby.core.R.string.livesetup_title)
                    LibraryCard(api, Item(id = "livetv-setup", name = title), title) { nav.navigate(GridRoute(title, collectionType = LIVE_SETUP)) }
                }
                item("iptv") {
                    val title = stringResource(com.wika.wicaby.core.R.string.iptv_title)
                    LibraryCard(api, Item(id = "iptv", name = title), title) { nav.navigate(GridRoute(title, collectionType = IPTV)) }
                }
                items(list.drop(split), key = { Servers.libraryRef(it) }) { library(it) }
                // Immich photo source (photos spec PH-13): its own library, next to the server's.
                com.wika.wicaby.core.photos.Immich.source?.let { s ->
                    item("immich") {
                        LibraryCard(api, Item(id = s.id, name = s.name), "Immich · ${s.name}") {
                            nav.navigate(GridRoute(s.name, parentId = s.id, collectionType = com.wika.wicaby.mobile.ui.photos.IMMICH))
                        }
                    }
                }
                // Photo sources (a folder or a share used as a photo library): each its own library, like Immich.
                items(photoSources, key = { "photos-${it.id}" }) { s ->
                    LibraryCard(api, Item(id = s.id, name = s.name), s.name) {
                        nav.navigate(GridRoute(s.name, parentId = com.wika.wicaby.core.files.pure.Ids.ROOT, collectionType = "photos", serverId = s.id))
                    }
                }
                // File sources (FS-10): folders, WebDAV and SMB shares, browsed without a server.
                item("files", span = { GridItemSpan(maxLineSpan) }) { FilesSection(nav) }
            }
        }
    }
}

@Composable
fun LargeTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, style = Type.largeTitle, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = modifier.statusBarsPadding().padding(top = 18.dp, bottom = 10.dp))
}

@Composable
private fun LibraryCard(api: Api, view: Item, label: String, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    val px = dpPx(400.dp)
    val url = remember(view.id) { view.imageTags["Primary"]?.let { api.image(view.id, "Primary", it, maxWidth = px) } }
    Box(
        Modifier.fillMaxWidth().aspectRatio(16f / 8f).pressScale(source).clip(RoundedCornerShape(Radius.lg)).background(G.elevated2)
            .clickable(source, null, role = Role.Button, onClick = onClick),
    ) {
        if (url != null) AsyncImage(url, view.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.45f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.7f))))
        Text(label, style = Type.title2, color = Color.White, modifier = Modifier.align(Alignment.BottomStart).padding(16.dp))
    }
}

// ---------------------------------------------------------------------------
// Grid of a library, folder, collection or person, with sort and filters.

private enum class Sort(val label: Int, val by: String, val descending: Boolean) {
    Name(R.string.sort_name, "SortName", false),
    Added(R.string.sort_added, "DateCreated,SortName", true),
    Year(R.string.sort_year, "ProductionYear,SortName", true),
    Rating(R.string.sort_rating, "CommunityRating,SortName", true),
}

private enum class Filter(val label: Int, val query: String?) {
    All(R.string.filter_all, null),
    Unplayed(R.string.filter_unplayed, "IsUnplayed"),
    Favorites(R.string.filter_favorites, "IsFavorite"),
}

private class Paged {
    val items = mutableStateListOf<Item>()
    var total by mutableIntStateOf(-1)
    var loading = false
    var failed by mutableStateOf(false)
    // The server's offset: items can be fewer once repeats are dropped (addNew).
    var offset = 0
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GridScreen(api: Api, route: GridRoute, nav: NavController) {
    var sort by rememberSaveable { mutableStateOf(Sort.Name) }
    var flip by rememberSaveable { mutableStateOf(false) }
    var filter by rememberSaveable { mutableStateOf(Filter.All) }
    var nonce by remember { mutableIntStateOf(0) }
    val key = "grid-${route.parentId}-${route.personId}-$sort-$flip-$filter"
    val paged = remember(key, nonce) { Paged() }
    val scope = rememberCoroutineScope()
    val types = when (route.collectionType) {
        "movies" -> "Movie"
        "tvshows" -> "Series"
        "boxsets" -> "BoxSet"
        else -> if (route.personId != null) "Movie,Series" else null
    }

    suspend fun more() {
        if (paged.loading || (paged.total >= 0 && paged.offset >= paged.total)) return
        paged.loading = true
        try {
            val r = api.items(
                "ParentId" to route.parentId, "PersonIds" to route.personId, "IncludeItemTypes" to types, "Recursive" to (types != null),
                "SortBy" to sort.by, "SortOrder" to if (sort.descending != flip) "Descending" else "Ascending",
                "Filters" to filter.query, "StartIndex" to paged.offset, "Limit" to 100,
            )
            paged.offset += r.items.size
            paged.items.addNew(r.items)
            paged.total = r.totalRecordCount
            paged.failed = false
        } catch (e: Exception) {
            paged.failed = paged.items.isEmpty()
        } finally {
            paged.loading = false
        }
    }

    LaunchedEffect(paged) { more() }
    val grid = rememberLazyGridState()
    LaunchedEffect(grid, paged) {
        snapshotFlow { grid.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }.collect { if (it > paged.items.size - 30) more() }
    }

    Column(Modifier.fillMaxSize()) {
        TopBar(route.title, onBack = { nav.popBackStack() })
        LazyRow(contentPadding = PaddingValues(horizontal = 20.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item("sort") {
                var open by remember { mutableStateOf(false) }
                Box {
                    Chip(stringResource(sort.label), selected = true, icon = Ic.Sort) { open = true }
                    DropdownMenu(open, { open = false }, containerColor = G.elevated2, shape = RoundedCornerShape(Radius.md)) {
                        Sort.entries.forEach { s ->
                            DropdownMenuItem(
                                text = { Text(stringResource(s.label), style = Type.body, color = G.label) },
                                trailingIcon = { if (s == sort) Icon(Ic.Check, null, tint = LocalAccent.current, modifier = Modifier.size(18.dp)) },
                                onClick = {
                                    // Picking the current sort again reverses it.
                                    if (s == sort) flip = !flip else { sort = s; flip = false }
                                    open = false
                                },
                            )
                        }
                    }
                }
            }
            items(Filter.entries, key = { it.name }) { f -> Chip(stringResource(f.label), selected = f == filter) { filter = f } }
        }
        Box(Modifier.fillMaxSize()) {
            when {
                paged.failed -> Centered { ErrorState({ scope.launch { more() } }) }
                paged.total < 0 -> Centered { Spinner() }
                paged.total == 0 -> Centered { Text(stringResource(R.string.nothing_here), style = Type.body, color = G.label2) }
            }
            LazyVerticalGrid(
                columns = GridCells.Adaptive(108.dp),
                state = grid,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 24.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                if (paged.total > 0) {
                    item("count", span = { GridItemSpan(maxLineSpan) }) { Text(pluralStringResource(R.plurals.items_count, paged.total, formatNumber(paged.total)), style = Type.footnote, color = G.label3) }
                }
                items(paged.items, key = { it.id }, contentType = { "poster" }) { item ->
                    PosterCard(item, api, onClick = { nav.open(item) }, width = null)
                }
            }
        }
    }
}

@Composable
fun TopBar(title: String, onBack: () -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().statusBarsPadding().height(56.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        GlassIconButton(Ic.Back, stringResource(R.string.back), onBack, glass = 0f)
        Spacer(Modifier.width(6.dp))
        Text(title, style = Type.title2, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
    }
}

// Filter chip: selection is a neutral fill, not an accent pill.
@Composable
fun Chip(text: String, selected: Boolean, icon: androidx.compose.ui.graphics.vector.ImageVector? = null, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    Row(
        Modifier.pressScale(source).clip(CircleShape).background(if (selected) G.fill4 else G.fill1)
            .clickable(source, null, role = Role.Button, onClick = onClick).padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (icon != null) Icon(icon, null, tint = G.label, modifier = Modifier.size(16.dp))
        Text(text, style = Type.callout, color = if (selected) G.label else G.label2)
    }
}

// GridRoute collection types of the Live TV setup page and of IPTV (not server views).
const val LIVE_SETUP = "wicaby:livetv-setup"
const val IPTV = "wicaby:iptv"
