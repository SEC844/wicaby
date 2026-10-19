@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package com.wika.wicaby.mobile.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.navigation.NavController
import coil3.compose.AsyncImage
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.caps
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.data.Person
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.data.backdrop
import com.wika.wicaby.core.data.posterArt
import com.wika.wicaby.core.data.runtimeText
import com.wika.wicaby.core.data.thumb
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.download.DlState
import com.wika.wicaby.mobile.download.DownloadEntry
import com.wika.wicaby.mobile.download.Downloads
import com.wika.wicaby.core.comics.Comics
import com.wika.wicaby.mobile.reader.ReaderActivity
import kotlinx.coroutines.launch
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.ui.res.pluralStringResource
import com.wika.wicaby.core.data.MediaSource
import com.wika.wicaby.core.data.MediaStream
import com.wika.wicaby.core.data.Versions
import com.wika.wicaby.core.data.VideoRange
import com.wika.wicaby.core.player.Trailers
import com.wika.wicaby.core.player.ExternalPlayer
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.previousEpisodes
import androidx.compose.foundation.combinedClickable
import com.wika.wicaby.mobile.cast.CastButton
import com.wika.wicaby.mobile.cast.MiniController
import com.wika.wicaby.mobile.player.PlayerActivity

@Composable
private fun badges(item: Item, source: MediaSource?): List<String> {
    val stereo = stringResource(R.string.stereo)
    val streams = source?.mediaStreams.orEmpty()
    val video = streams.firstOrNull { it.type == "Video" }
    val audio = streams.firstOrNull { it.type == "Audio" && it.isDefault } ?: streams.firstOrNull { it.type == "Audio" }
    // "Dolby Vision · HDR10", "HDR10+", "HLG"… (none for SDR), then the Dolby Vision profile.
    val range = VideoRange.of(video)
    val versions = item.mediaSources.size.takeIf { it > 1 }?.let { n -> pluralStringResource(com.wika.wicaby.core.R.plurals.versions_count, n, n) }
    val profile = range.dvProfile?.let { stringResource(com.wika.wicaby.core.R.string.dv_profile, it) }
    return listOfNotNull(
        versions,
        video?.width?.let { w -> when { w >= 3800 -> "4K"; w >= 1900 -> "1080p"; w >= 1260 -> "720p"; else -> "SD" } },
        range.badge,
        profile,
        video?.codec?.uppercase(),
        audio?.channels?.let { c -> when { c >= 8 -> "7.1"; c >= 6 -> "5.1"; c == 2 -> stereo; else -> null } },
        audio?.codec?.let { c -> when (c.lowercase()) { "truehd" -> "Dolby TrueHD"; "eac3" -> "Dolby Digital+"; "ac3" -> "Dolby Digital"; "dts", "dca" -> "DTS"; else -> null } },
    )
}

// Asks for the notification permission (progress notification) the first time, then downloads.
@Composable
fun rememberDownloader(api: Api): (Item) -> Unit {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    return remember(api) {
        { item ->
            if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            Downloads.enqueue(context, api, item)
        }
    }
}

@Composable
fun DetailScreen(api: Api, id: String, nav: NavController) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var nonce by remember { mutableIntStateOf(0) }
    val loaded = rememberLoad("item-$id", nonce) { api.item(id) }
    val item = loaded.value
    val list = rememberLazyListState()
    val density = LocalDensity.current
    val downloads by Downloads.entries.collectAsState()
    val download = rememberDownloader(api)
    // Plex: the Download button only where the server allows it (allowSync, plex spec §1.3).
    val canDownload = rememberCanDownload(api, item?.takeIf { !it.isSeries }?.id)

    BoxWithConstraints(Modifier.fillMaxSize().background(G.bg)) {
        val wide = maxWidth >= 600.dp
        val headerH = if (wide) (maxWidth * 0.36f).coerceIn(300.dp, 460.dp) else maxWidth * 0.75f
        val headerPx = with(density) { headerH.toPx() }
        // 0 over the artwork, 1 once it has scrolled away: drives the toolbar without recomposing.
        val collapse by remember(headerPx) {
            derivedStateOf { if (list.firstVisibleItemIndex > 0) 1f else (list.firstVisibleItemScrollOffset / (headerPx * 0.75f)).coerceIn(0f, 1f) }
        }

        if (item == null) {
            Centered { if (loaded.error != null) ErrorState({ nonce++ }) else Spinner() }
        } else {
            val seasons = if (item.isSeries) rememberLoad("seasons-$id", nonce) { api.seasons(id) }.value.orEmpty() else emptyList()
            val nextUp = if (item.isSeries) rememberLoad("nextup-$id", nonce) { api.nextUp(id, 1) }.value?.firstOrNull() else null
            var seasonIndex by rememberSaveable { mutableIntStateOf(-1) }
            if (seasonIndex < 0 && seasons.isNotEmpty()) seasonIndex = seasons.indexOfFirst { it.id == nextUp?.seasonId }.coerceAtLeast(0)
            val season = seasons.getOrNull(seasonIndex)
            val episodes = season?.let { s -> rememberLoad("episodes-$id-${s.id}", nonce) { api.episodes(id, s.id) }.value }.orEmpty()
            // shortcut: allowSync read on the season's first episode (it follows the user's sharing settings); a refused one
            // still gets the explanation from Downloads.enqueue. Read every episode if a server ever mixes them.
            val episodesDownload = rememberCanDownload(api, episodes.firstOrNull()?.id)
            val similar = rememberLoad("similar-$id") { api.similar(id) }.value.orEmpty()
            var favorite by remember(item) { mutableStateOf(item.userData?.isFavorite == true) }
            var watched by remember(item) { mutableStateOf(item.userData?.played == true) }
            val target = if (item.isSeries) nextUp ?: episodes.firstOrNull() else item
            val resumeMs = target?.resumeMs ?: 0
            // Books open the comic reader; the saved page replaces the resume time.
            val book = Comics.isBook(item)
            val bookPage = if (book) Comics.resumePage(item) else null
            // Versions: the remembered one; audio/subtitles follow it.
            var sourceId by remember(item) { mutableStateOf(Versions.selected(item)?.id) }
            val source = item.mediaSources.firstOrNull { it.id == sourceId } ?: item.mediaSources.firstOrNull()
            val backdropPx = dpPx(maxWidth).coerceAtMost(1920)
            // Making-of, deleted scenes…: none for books, and none when the server lacks the route.
            val extras = if (book) emptyList() else rememberLoad("extras-$id") { api.specialFeatures(id) }.value.orEmpty()
            val external = remember(api) { ExternalPlayer.available(context, api) }
            // The id survives process death while VLC/MX is open: the result may then arrive before
            // [target] is loaded again, so the item is refetched (as PlayerActivity.openExternal does).
            var externalId by rememberSaveable { mutableStateOf<String?>(null) }
            val externalLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
                val launched = externalId ?: return@rememberLauncherForActivityResult
                val known = target?.takeIf { it.id == launched }
                Core.scope.launch {
                    val played = known ?: runCatching { api.item(launched) }.getOrNull() ?: return@launch
                    if (ExternalPlayer.report(api, played, r.data)) {
                        Cache.invalidateHome()
                        nonce++
                    }
                }
            }
            var marking by remember { mutableStateOf(false) }
            val markFailed = stringResource(R.string.mark_failed)
            // "Saison vue", "Marquer les précédents comme vus": one call per episode, then the page reloads.
            fun mark(on: Boolean, episodesToMark: suspend () -> List<Item>) {
                if (marking) return
                marking = true
                scope.launch {
                    runCatching { api.markPlayed(episodesToMark(), on) }
                        .onFailure { android.widget.Toast.makeText(context, markFailed, android.widget.Toast.LENGTH_SHORT).show() }
                    Cache.invalidateHome()
                    nonce++
                    marking = false
                }
            }

            LazyColumn(state = list, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
                item("header") {
                    Box(Modifier.fillMaxWidth().height(headerH + 96.dp)) {
                        val url = remember(item.id, backdropPx) { api.backdrop(item, backdropPx) }
                        Box(
                            Modifier.fillMaxWidth().height(headerH).graphicsLayer {
                                // Parallax: the artwork scrolls at half speed.
                                if (list.firstVisibleItemIndex == 0) translationY = list.firstVisibleItemScrollOffset * 0.5f
                            },
                        ) {
                            if (url != null) AsyncImage(url, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.5f to Color.Transparent, 1f to G.bg)))
                            Box(Modifier.fillMaxWidth().height(100.dp).background(Brush.verticalGradient(listOf(G.bg.copy(alpha = 0.4f), G.bg.copy(alpha = 0f)))))
                        }
                        Row(Modifier.align(Alignment.BottomStart).padding(horizontal = 20.dp), verticalAlignment = Alignment.Bottom) {
                            val posterUrl = remember(item.id) { api.posterArt(item, POSTER_PX) }
                            if (posterUrl != null) {
                                Box(
                                    Modifier.width(if (wide) 140.dp else 108.dp).aspectRatio(2f / 3f)
                                        .sharedPoster(item.id)
                                        .shadow(16.dp, RoundedCornerShape(Radius.md))
                                        .clip(RoundedCornerShape(Radius.md))
                                        .background(G.elevated2),
                                ) { AsyncImage(posterUrl, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
                                Spacer(Modifier.width(16.dp))
                            }
                            Column(Modifier.weight(1f).padding(bottom = 4.dp)) {
                                if (item.isEpisode) Text(item.seriesName.orEmpty(), style = Type.callout, color = G.label2, maxLines = 1)
                                Text(
                                    if (item.isEpisode) episodeLine(item).orEmpty() else item.name,
                                    style = Type.title1, color = G.label, maxLines = 3, overflow = TextOverflow.Ellipsis,
                                )
                                Text(metaLine(item), style = Type.footnote, color = G.label2, maxLines = 2, modifier = Modifier.padding(top = 6.dp))
                            }
                        }
                    }
                }
                item("actions") {
                    Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 20.dp).widthIn(max = 560.dp)) {
                        val label = when {
                            book -> if (bookPage != null) stringResource(R.string.reader_resume_page, bookPage + 1) else stringResource(R.string.reader_read)
                            target == null -> stringResource(R.string.play)
                            resumeMs > 0 -> {
                                val left = runtimeText(((target.runTimeTicks ?: 0) - resumeMs * TICKS_PER_MS).coerceAtLeast(0))
                                if (left != null) stringResource(R.string.resume_time_left, left) else stringResource(R.string.resume)
                            }
                            item.isSeries && target.indexNumber != null ->
                                stringResource(R.string.play_episode, target.parentIndexNumber ?: 1, target.indexNumber ?: 0)
                            else -> stringResource(R.string.play)
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            PillButton(label, { if (book) ReaderActivity.start(context, item.id, server = Servers.extraOf(api.server.id)?.server?.id) else target?.let { play(context, it) } }, icon = Ic.Play, primary = true, modifier = Modifier.weight(1f))
                            // VLC, MX Player…: the position it hands back becomes the resume point.
                            if (external && !book && target != null) {
                                PillButton(
                                    null, {
                                        externalId = target.id
                                        runCatching { externalLauncher.launch(ExternalPlayer.intent(context, api, target)) }
                                    }, icon = Ic.External,
                                    contentDescription = stringResource(com.wika.wicaby.core.R.string.external_player_open),
                                )
                            }
                        }
                        Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                            if ((if (book) bookPage != null else resumeMs > 0) && target != null) ActionIcon(Ic.Restart, stringResource(R.string.from_start), { if (book) ReaderActivity.start(context, item.id, fromStart = true, server = Servers.extraOf(api.server.id)?.server?.id) else play(context, target, fromStart = true) })
                            if (Trailers.has(item)) TrailerAction(api, item)
                            // A file source sends nothing off the device (caps castSend): no cast, no download, and no heart
                            // without favorites (§2.2).
                            val caps = api.server.caps
                            if (!book && target != null && caps.castSend) {
                                // From the page: the resume point and the version and tracks picked above (§2.4).
                                CastButton(api, target, send = { rt, t ->
                                    val msid = Versions.selected(target)?.id
                                    val pick = Versions.pick(target.id, msid)
                                    rt.play(t, listOf(target.id), positionTicks = resumeMs * TICKS_PER_MS, msid = msid, audio = pick?.audio, sub = pick?.subtitle)
                                    true
                                }) { casting, onClick -> ActionIcon(Ic.Cast, stringResource(com.wika.wicaby.core.R.string.cast_button), onClick, active = casting) }
                            }
                            if (!item.isSeries && caps.castSend && canDownload) DownloadAction(downloads.firstOrNull { it.isOf(api.server.id, item.id) }) { download(item) }
                            if (caps.favorites) ActionIcon(if (favorite) Ic.HeartFilled else Ic.Heart, stringResource(R.string.favorite), active = favorite, onClick = {
                                // Optimistic: reacts at once, and a quick double tap sends both values in order.
                                val v = !favorite
                                favorite = v
                                scope.launch { runCatching { api.setFavorite(item.id, v) }.onFailure { favorite = !v } }
                            })
                            ActionIcon(if (watched) Ic.CircleCheck else Ic.Check, stringResource(R.string.watched), active = watched, onClick = {
                                val v = !watched
                                watched = v
                                scope.launch {
                                    runCatching { api.setPlayed(item.id, v) }.onSuccess { Cache.invalidateHome() }.onFailure { watched = !v }
                                }
                            })
                        }
                    }
                }
                if (!item.isSeries && !book && source != null) {
                    item("tracks") { TrackSelectors(item, source, onVersion = { sourceId = it; Versions.select(item.id, it) }) }
                }
                item("overview") {
                    Column(Modifier.padding(horizontal = 20.dp).padding(top = 18.dp).widthIn(max = 720.dp)) {
                        item.taglines.firstOrNull()?.let { Text(it, style = Type.headline, color = G.label, modifier = Modifier.padding(bottom = 6.dp)) }
                        item.overview?.takeIf { it.isNotBlank() }?.let { Overview(it) }
                        val tags = badges(item, source)
                        if (tags.isNotEmpty()) {
                            FlowRow(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                tags.forEach {
                                    Text(it, style = Type.caption, color = G.label2, modifier = Modifier.clip(RoundedCornerShape(Radius.xs)).background(G.fill2).padding(horizontal = 7.dp, vertical = 3.dp))
                                }
                            }
                        }
                    }
                }
                if (item.isSeries && seasons.isNotEmpty()) {
                    item("seasons") {
                        LazyRow(contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 26.dp, bottom = 8.dp)) {
                            itemsIndexed(seasons, key = { _, s -> s.id }) { i, s ->
                                Chip(s.name.ifBlank { stringResource(R.string.season_n, s.indexNumber ?: (i + 1)) }, selected = i == seasonIndex) { seasonIndex = i }
                            }
                            if (episodes.isNotEmpty()) {
                                item("season-played") {
                                    val seasonPlayed = episodes.all { it.userData?.played == true }
                                    Chip(
                                        stringResource(if (seasonPlayed) R.string.mark_season_unplayed else R.string.mark_season_played),
                                        selected = false, icon = if (seasonPlayed) Ic.CircleCheck else Ic.Check,
                                    ) { mark(!seasonPlayed) { episodes } }
                                }
                            }
                        }
                    }
                    items(episodes, key = { it.id }, contentType = { "episode" }) { ep ->
                        EpisodeRow(
                            ep, api, downloads.firstOrNull { it.isOf(api.server.id, ep.id) }, onPlay = { play(context, ep) }, onDownload = { download(ep) }.takeIf { episodesDownload },
                            onMark = { on -> mark(on) { listOf(ep) } },
                            // The whole series, so earlier seasons count too.
                            onMarkPrevious = { mark(true) { previousEpisodes(api.episodes(id), ep) } },
                        )
                    }
                }
                val cast = item.people.filter { it.type == "Actor" || it.type == null }.take(20)
                if (cast.isNotEmpty()) {
                    item("cast") {
                        Column(Modifier.padding(top = 26.dp)) {
                            SectionTitle(stringResource(R.string.cast))
                            LazyRow(contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                                items(cast, key = { it.id + it.role }) { p -> CastCard(api, p) { nav.navigate(GridRoute(p.name, personId = p.id)) } }
                            }
                        }
                    }
                }
                if (extras.isNotEmpty()) {
                    // Played like a trailer: from the start, nothing reported.
                    item("extras") { MediaRow(stringResource(com.wika.wicaby.core.R.string.bonus), extras, api, wide = true, onClick = { PlayerActivity.start(context, it.id, fromStart = true, trailer = true, server = Servers.extraOf(api.server.id)?.server?.id) }) }
                }
                if (similar.isNotEmpty() && !item.isEpisode) {
                    item("similar") { MediaRow(stringResource(R.string.similar), similar, api, wide = false, onClick = { nav.open(it) }) }
                }
            }
        }

        // Collapsing toolbar: transparent over the artwork, solid with the title once it is gone.
        Row(
            Modifier.fillMaxWidth().drawBehind { drawRect(G.bg.copy(alpha = collapse)) }.statusBarsPadding().height(52.dp).padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            GlassIconButton(Ic.Back, stringResource(R.string.back), { nav.popBackStack() }, glass = 1f - collapse)
            Text(
                item?.name.orEmpty(), style = Type.headline, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(start = 10.dp, end = 40.dp).graphicsLayer { alpha = ((collapse - 0.6f) / 0.4f).coerceIn(0f, 1f) },
                textAlign = TextAlign.Center,
            )
        }
        MiniController(api, Modifier.align(Alignment.BottomCenter).navigationBarsPadding())
    }
}

@Composable
private fun Overview(text: String) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.animateContentSize().clickable(interactionSource = null, indication = null) { expanded = !expanded }) {
        Text(text, style = Type.body, color = G.label2, maxLines = if (expanded) Int.MAX_VALUE else 4, overflow = TextOverflow.Ellipsis)
        if (text.length > 220) Text(stringResource(if (expanded) R.string.less else R.string.more), style = Type.callout, color = G.label, modifier = Modifier.padding(top = 4.dp))
    }
}

@Composable
private fun DownloadAction(entry: DownloadEntry?, onDownload: () -> Unit) {
    when (entry?.state) {
        DlState.Done -> ActionIcon(Ic.CircleCheck, stringResource(R.string.downloaded), {}, active = true)
        DlState.Running, DlState.Queued -> ActionIcon(Ic.Download, stringResource(R.string.download), {}, active = true, progress = entry.fraction)
        else -> ActionIcon(Ic.Download, stringResource(R.string.download), onDownload)
    }
}

@Composable
private fun EpisodeRow(ep: Item, api: Api, dl: DownloadEntry?, onPlay: () -> Unit, onDownload: (() -> Unit)?, onMark: (Boolean) -> Unit, onMarkPrevious: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    val px = dpPx(150.dp)
    val url = remember(ep.id) { api.thumb(ep, px) }
    // Long press: watched toggle and "Marquer les précédents comme vus".
    var menu by remember { mutableStateOf(false) }
    val played = ep.userData?.played == true
    Box {
        DropdownMenu(menu, { menu = false }, containerColor = G.elevated2, shape = RoundedCornerShape(Radius.md)) {
            DropdownMenuItem(text = { Text(stringResource(if (played) R.string.mark_unplayed else R.string.mark_played), style = Type.body, color = G.label) }, onClick = { menu = false; onMark(!played) })
            DropdownMenuItem(text = { Text(stringResource(R.string.mark_previous_played), style = Type.body, color = G.label) }, onClick = { menu = false; onMarkPrevious() })
        }
        Column(Modifier.fillMaxWidth().combinedClickable(source, null, role = Role.Button, onLongClick = { menu = true }, onClick = onPlay).padding(horizontal = 20.dp, vertical = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.width(150.dp).aspectRatio(16f / 9f).pressScale(source).clip(RoundedCornerShape(Radius.sm)).background(G.elevated2)) {
                    if (url != null) AsyncImage(url, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    ep.progress?.let { ProgressLine(it, Modifier.align(Alignment.BottomCenter).padding(horizontal = 8.dp, vertical = 7.dp)) }
                    if (ep.userData?.played == true) {
                        Box(Modifier.align(Alignment.TopEnd).padding(6.dp).size(20.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.55f)), contentAlignment = Alignment.Center) {
                            Icon(Ic.Check, stringResource(R.string.watched), tint = Color.White, modifier = Modifier.size(13.dp))
                        }
                    }
                }
                Column(Modifier.weight(1f).padding(start = 14.dp)) {
                    Text(ep.indexNumber?.let { stringResource(R.string.episode_numbered, it, ep.name) } ?: ep.name, style = Type.callout, color = G.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    runtimeText(ep.runTimeTicks)?.let { Text(it, style = Type.footnote, color = G.label2, modifier = Modifier.padding(top = 2.dp)) }
                }
                val icon = if (dl?.state == DlState.Done) Ic.CircleCheck else Ic.Download
                if (onDownload != null || dl != null) Box(Modifier.size(44.dp).clip(CircleShape).clickable(enabled = onDownload != null && (dl == null || dl.state == DlState.Failed), onClick = { onDownload?.invoke() }), contentAlignment = Alignment.Center) {
                    if (dl != null && dl.state != DlState.Done && dl.state != DlState.Failed) {
                        androidx.compose.material3.CircularProgressIndicator(
                            progress = { dl.fraction }, modifier = Modifier.size(28.dp), color = LocalAccent.current, trackColor = G.fill3, strokeWidth = 2.dp,
                        )
                    } else {
                        Icon(icon, stringResource(R.string.download), tint = if (dl?.state == DlState.Done) G.label else G.label2, modifier = Modifier.size(22.dp))
                    }
                }
            }
            ep.overview?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = Type.footnote, color = G.label2, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
            }
        }
    }
}

@Composable
private fun CastCard(api: Api, p: Person, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    val px = dpPx(80.dp)
    val url = remember(p.id) { api.personImage(p, px * 2) }
    Column(Modifier.width(84.dp).pressScale(source).clickable(source, null, role = Role.Button, onClick = onClick), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(76.dp).clip(CircleShape).background(G.elevated2), contentAlignment = Alignment.Center) {
            if (url != null) AsyncImage(url, p.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            else Text(p.name.take(1), style = Type.title2, color = G.label2)
        }
        Text(p.name, style = Type.caption, color = G.label, maxLines = 2, textAlign = TextAlign.Center, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
        p.role?.let { Text(it, style = Type.caption, color = G.label3, maxLines = 1, textAlign = TextAlign.Center, overflow = TextOverflow.Ellipsis) }
    }
}

// Version, Audio, Sous-titres: the audio and subtitle lists are the selected version's; picks
// go to the player through core's Versions (and the version is remembered per item).
@Composable
private fun TrackSelectors(item: Item, source: MediaSource, onVersion: (String) -> Unit) {
    val versions = item.mediaSources
    val audio = source.mediaStreams.filter { it.type == "Audio" }
    val subs = source.mediaStreams.filter { it.type == "Subtitle" }
    if (versions.size < 2 && audio.size < 2 && subs.isEmpty()) return
    val pick = Versions.pick(item.id, source.id)
    var audioPick by remember(item.id, source.id) { mutableStateOf(pick?.audio) }
    var subPick by remember(item.id, source.id) { mutableStateOf(pick?.subtitle) }
    val versionLabels = remember(item) { Versions.labels(item) }
    val audioNames = audio.map { trackName(it) }
    val subNames = listOf(stringResource(R.string.subtitles_off)) + subs.map { trackName(it) }
    Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp).widthIn(max = 560.dp)) {
        Group {
            var first = true
            if (versions.size > 1) {
                first = false
                SelectorRow(stringResource(com.wika.wicaby.core.R.string.version), versionLabels, versions.indexOfFirst { it.id == source.id }.coerceAtLeast(0)) { onVersion(versions[it].id) }
            }
            if (audio.size > 1) {
                if (!first) GroupDivider()
                first = false
                val current = audioPick ?: Versions.defaultAudioStream(source)?.index
                SelectorRow(stringResource(R.string.audio), audioNames, audio.indexOfFirst { it.index == current }.coerceAtLeast(0)) {
                    audioPick = audio[it].index
                    Versions.setPick(item.id, source.id, audioPick, subPick)
                }
            }
            if (subs.isNotEmpty()) {
                if (!first) GroupDivider()
                val current = subPick ?: Versions.defaultSubtitleIndex(source)
                SelectorRow(stringResource(R.string.subtitles), subNames, (subs.indexOfFirst { it.index == current } + 1).coerceAtLeast(0)) {
                    subPick = if (it == 0) -1 else subs[it - 1].index
                    Versions.setPick(item.id, source.id, audioPick, subPick)
                }
            }
        }
    }
}

// [unavailable] (the cast remote panel): disabled, and TalkBack reads that text as its state.
@Composable
internal fun SelectorRow(title: String, options: List<String>, selected: Int, unavailable: String? = null, onSelect: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.fillMaxWidth()
                .clickable(enabled = unavailable == null, role = Role.Button) { open = true }
                .then(if (unavailable != null) Modifier.semantics { stateDescription = unavailable } else Modifier)
                .padding(horizontal = 16.dp, vertical = 13.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, style = Type.body, color = G.label2)
            Spacer(Modifier.width(16.dp))
            Text(
                options.getOrElse(selected) { "" }, style = Type.body, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.End, modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(6.dp))
            Icon(Ic.ChevronDown, null, tint = G.label3, modifier = Modifier.size(18.dp))
        }
        DropdownMenu(open, { open = false }, containerColor = G.elevated2, shape = RoundedCornerShape(Radius.md)) {
            options.forEachIndexed { i, o ->
                DropdownMenuItem(
                    text = { Text(o, style = Type.body, color = G.label) },
                    trailingIcon = { if (i == selected) Icon(Ic.Check, null, tint = G.label, modifier = Modifier.size(18.dp)) },
                    onClick = {
                        open = false
                        onSelect(i)
                    },
                )
            }
        }
    }
}

@Composable
internal fun trackName(s: MediaStream): String = s.displayTitle ?: s.title ?: s.language ?: stringResource(R.string.track_unknown, s.index)

// "Bande-annonce": a local trailer plays in the player (reporting nothing), a remote one opens
// in the YouTube app or the browser.
@Composable
private fun TrailerAction(api: Api, item: Item) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val notFound = stringResource(com.wika.wicaby.core.R.string.trailer_not_found)
    ActionIcon(Ic.Film, stringResource(com.wika.wicaby.core.R.string.trailer), onClick = {
        scope.launch {
            if ((item.localTrailerCount ?: 0) > 0) {
                val local = runCatching { api.localTrailers(item.id) }.getOrNull()?.firstOrNull()
                if (local != null) return@launch PlayerActivity.start(context, local.id, fromStart = true, trailer = true, server = Servers.extraOf(api.server.id)?.server?.id)
            }
            val url = Trailers.remoteUrl(item)
            if (url == null || !Trailers.openRemote(context, url)) android.widget.Toast.makeText(context, notFound, android.widget.Toast.LENGTH_SHORT).show()
        }
    })
}
