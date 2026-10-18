package com.wika.wicaby.tv.ui

import android.content.Context
import com.wika.wicaby.core.data.backdrop
import com.wika.wicaby.core.data.posterArt
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.tv.LocalApi
import com.wika.wicaby.tv.R
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.runtimeText
import com.wika.wicaby.tv.play
import com.wika.wicaby.core.comics.Comics
import com.wika.wicaby.tv.reader.ReaderActivity
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.caps
import com.wika.wicaby.core.data.MediaSource
import com.wika.wicaby.core.data.MediaStream
import com.wika.wicaby.core.data.Versions
import com.wika.wicaby.core.player.Trailers
import com.wika.wicaby.core.player.ExternalPlayer
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Servers
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.wika.wicaby.meshui.QrCode
import com.wika.wicaby.tv.playTrailer

// The selected version's streams; "N versions" when there is a choice.
private fun badges(context: Context, item: Item, source: MediaSource?): List<String> {
    val streams = source?.mediaStreams.orEmpty()
    val versions = item.mediaSources.size.takeIf { it > 1 }?.let { n ->
        context.resources.getQuantityString(com.wika.wicaby.core.R.plurals.versions_count, n, n)
    }
    return listOfNotNull(versions) + streamBadges(context, streams)
}

private fun streamBadges(context: Context, streams: List<MediaStream>): List<String> {
    val range = com.wika.wicaby.core.data.VideoRange.of(streams.firstOrNull { it.type == "Video" })
    val video = streams.firstOrNull { it.type == "Video" }
    val audio = streams.firstOrNull { it.type == "Audio" && it.isDefault } ?: streams.firstOrNull { it.type == "Audio" }
    return listOfNotNull(
        video?.width?.let { w -> when { w >= 3800 -> "4K"; w >= 1900 -> "HD 1080p"; w >= 1260 -> "HD 720p"; else -> "SD" } },
        // "Dolby Vision · HDR10", "HDR10+", "HLG"… (none for SDR), then the DV profile.
        range.badge,
        range.dvProfile?.let { context.getString(com.wika.wicaby.core.R.string.dv_profile, it) },
        video?.codec?.uppercase(),
        audio?.channels?.let { c -> when { c >= 8 -> "7.1"; c >= 6 -> "5.1"; c == 2 -> context.getString(R.string.badge_stereo); else -> null } },
        audio?.codec?.let { c -> when (c.lowercase()) { "truehd" -> "Dolby TrueHD"; "eac3" -> "Dolby Digital+"; "ac3" -> "Dolby Digital"; "dts", "dca" -> "DTS"; else -> null } },
        if (streams.any { it.type == "Subtitle" }) context.getString(R.string.badge_subtitles) else null,
    )
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalComposeUiApi::class)
@Composable
fun DetailScreen(id: String) {
    val api = LocalApi.current ?: return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val memory = rememberFocusMemory()
    var reload by remember { mutableIntStateOf(0) }
    val loaded = rememberLoad("item-$id-$reload") { api.item(id) }.value
    val item = loaded.value

    Box(Modifier.fillMaxSize()) {
        // Books rarely have a backdrop: their cover (the server's, or the first page) fills the background.
        Backdrop(item?.let { remember(it.id) { api.backdrop(it) ?: if (Comics.isBook(it)) api.posterArt(it, 1080) else null } })
        if (item == null) {
            Centered { if (loaded.error != null) ErrorState { reload++ } else Spinner() }
            return@Box
        }

        val seasons = if (item.isSeries) rememberLoad("seasons-$id") { api.seasons(id) }.value.value.orEmpty() else emptyList()
        val nextUp = if (item.isSeries) rememberLoad("nextup-$id") { api.nextUp(id, 1) }.value.value?.firstOrNull() else null
        var seasonIndex by rememberSaveable { mutableIntStateOf(-1) }
        if (seasonIndex < 0 && seasons.isNotEmpty()) {
            seasonIndex = seasons.indexOfFirst { it.id == nextUp?.seasonId }.coerceAtLeast(0)
        }
        val season = seasons.getOrNull(seasonIndex)
        val episodes = season?.let { s -> rememberLoad("episodes-$id-${s.id}") { api.episodes(id, s.id) }.value.value }.orEmpty()

        var favorite by remember(item) { mutableStateOf(item.userData?.isFavorite == true) }
        var watched by remember(item) { mutableStateOf(item.userData?.played == true) }
        val target = if (item.isSeries) nextUp ?: episodes.firstOrNull() else item
        val resumeMs = target?.resumeMs ?: 0
        // Books open the comic reader; the saved page replaces the resume time.
        // Plex has no books (caps.comics, plex-spec §8): never the comic reader there.
        val book = api.server.kind != "plex" && Comics.isBook(item)
        val bookPage = if (book) Comics.resumePage(item) else null
        // Versions: the remembered one; audio/subtitles follow the selected version.
        var sourceId by remember(item) { mutableStateOf(Versions.selected(item)?.id) }
        val source = item.mediaSources.firstOrNull { it.id == sourceId } ?: item.mediaSources.firstOrNull()
        // Making-of, deleted scenes…: none for books, and none when the server lacks the route.
        val extras = if (book) emptyList() else rememberLoad("extras-$id") { api.specialFeatures(id) }.value.value.orEmpty()
        val external = remember(api) { ExternalPlayer.available(context, api) }

        val pageScroll = rememberScrollState()
        val heroMargin = with(LocalDensity.current) { 56.dp.toPx() }
        CompositionLocalProvider(LocalBringIntoViewSpec provides remember(pageScroll, heroMargin) { HeroSpec(pageScroll, heroMargin) }) {
            Column(Modifier.fillMaxSize().verticalScroll(pageScroll)) {
                Spacer(Modifier.height(if (item.isSeries) 110.dp else 150.dp))
                Column(Modifier.padding(start = 56.dp)) {
                    if (item.isEpisode) {
                        Text(episodeLine(item).orEmpty(), style = Type.title3, color = C.label, modifier = Modifier.padding(bottom = 6.dp))
                    }
                    Box(Modifier.width(600.dp)) { HeroText(api, item, overviewLines = 4) }
                    val tags = badges(context, item, source)
                    if (tags.isNotEmpty()) {
                        Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            tags.forEach {
                                Text(
                                    it, style = Type.caption, color = C.label2,
                                    modifier = Modifier.border(1.dp, C.label3, RoundedCornerShape(Radius.xs)).padding(horizontal = 7.dp, vertical = 3.dp),
                                )
                            }
                        }
                    }
                    Spacer(Modifier.height(24.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        val label = when {
                            book -> if (bookPage != null) stringResource(R.string.reader_resume_page, bookPage + 1) else stringResource(R.string.reader_read)
                            target == null -> stringResource(R.string.play)
                            resumeMs > 0 -> {
                                val left = runtimeText(((target.runTimeTicks ?: 0) - target.resumeMs * 10_000).coerceAtLeast(0))
                                if (left != null) stringResource(R.string.resume_time_left, left) else stringResource(R.string.resume)
                            }
                            item.isSeries && target.indexNumber != null ->
                                stringResource(R.string.play_episode, stringResource(R.string.episode_code, target.parentIndexNumber ?: 1, target.indexNumber ?: 0))
                            else -> stringResource(R.string.play)
                        }
                        Pill(label, onClick = { if (book) ReaderActivity.start(context, item.id, server = Servers.extraOf(api.server.id)?.server?.id) else target?.let { play(context, it, ask = false) } }, icon = Ic.Play, primary = true, modifier = Modifier.remembered(memory, "play", default = true))
                        if ((if (book) bookPage != null else resumeMs > 0) && target != null) {
                            Pill(stringResource(R.string.from_start), onClick = { if (book) ReaderActivity.start(context, item.id, fromStart = true, server = Servers.extraOf(api.server.id)?.server?.id) else play(context, target, fromStart = true) }, icon = Ic.Restart, modifier = Modifier.remembered(memory, "start"))
                        }
                        // TP-04, desktop's Item page: every episode in random order, as a play queue.
                        if (item.isSeries || item.type == "Season") {
                            Pill(
                                stringResource(com.wika.wicaby.core.R.string.shuffle), icon = Ic.Shuffle, modifier = Modifier.remembered(memory, "shuffle"),
                                onClick = { scope.launch { com.wika.wicaby.tv.shuffle(context, api, item.id) } },
                            )
                        }
                        if (Trailers.has(item)) TrailerPill(api, item, Modifier.remembered(memory, "trailer"))
                        if (external && !book && target != null) ExternalPill(api, target, Modifier.remembered(memory, "external"))
                        // No heart for a source without favorites (a file source, caps §2.2).
                        if (api.server.caps.favorites) Pill(
                            null, icon = if (favorite) Ic.Heart else Ic.HeartOutline, description = stringResource(R.string.favorite), modifier = Modifier.remembered(memory, "fav"),
                            onClick = { scope.launch { runCatching { api.setFavorite(item.id, !favorite) }.onSuccess { favorite = !favorite; Cache.changed() } } },
                        )
                        Pill(
                            // The icon carries the state, like the heart: a focused pill is white whatever `selected` says.
                            null, icon = if (watched) Ic.CheckCircle else Ic.Check, selected = watched, description = stringResource(R.string.watched),
                            modifier = Modifier.remembered(memory, "played"),
                            onClick = {
                                scope.launch {
                                    runCatching { api.setPlayed(item.id, !watched) }.onSuccess {
                                        watched = !watched
                                        Cache.changed()
                                        com.wika.wicaby.core.trakt.TraktService.shared.history(api, item, watched) // TP-09
                                    }
                                }
                            },
                        )
                        MorePill(api, item, Modifier.remembered(memory, "more"))
                    }
                    // TP-06: "Disponible sur 2 serveurs" and its server picker (several servers only).
                    CopiesPill(api, item, Modifier.padding(top = 14.dp).remembered(memory, "copies"))
                    if (!item.isSeries && !book && source != null) {
                        TrackSelectors(item, source, onVersion = { sourceId = it; Versions.select(item.id, it) }, memory = memory)
                    }
                }

                if (item.isSeries && seasons.isNotEmpty()) {
                    Spacer(Modifier.height(30.dp))
                    // Own spec: the page's HeroSpec measures the vertical scroll and would strand a horizontal row.
                    val margin = with(LocalDensity.current) { 56.dp.toPx() }
                    CompositionLocalProvider(LocalBringIntoViewSpec provides remember(margin) { EdgeSpec(margin) }) {
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = 56.dp, vertical = 6.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            modifier = Modifier.dpadEdges().focusRestorer(),
                        ) {
                            items(seasons.size, key = { seasons[it].id }) { i ->
                                val s = seasons[i]
                                Pill(
                                    s.name.ifBlank { stringResource(R.string.season_n, s.indexNumber ?: (i + 1)) },
                                    onClick = { seasonIndex = i }, primary = i == seasonIndex,
                                    onFocus = { if (it) seasonIndex = i },
                                    modifier = Modifier.remembered(memory, "season-${s.id}"),
                                )
                            }
                        }
                    }
                    CompositionLocalProvider(LocalBringIntoViewSpec provides remember(margin) { EdgeSpec(margin) }) {
                        LazyRow(
                            contentPadding = PaddingValues(start = 56.dp, end = 56.dp, top = 18.dp, bottom = 40.dp),
                            horizontalArrangement = Arrangement.spacedBy(22.dp),
                            modifier = Modifier.fillMaxWidth().dpadEdges().focusRestorer(),
                        ) {
                            items(episodes, key = { it.id }) { ep ->
                                ThumbCard(
                                    ep, api, onClick = { play(context, ep) }, inSeries = true,
                                    focusModifier = Modifier.remembered(memory, "ep-${ep.id}"),
                                )
                            }
                        }
                    }
                } else {
                    Spacer(Modifier.height(48.dp))
                }
                if (extras.isNotEmpty()) {
                    Text(stringResource(com.wika.wicaby.core.R.string.bonus), style = Type.title3, color = C.label, modifier = Modifier.padding(start = 56.dp))
                    val margin = with(LocalDensity.current) { 56.dp.toPx() }
                    CompositionLocalProvider(LocalBringIntoViewSpec provides remember(margin) { EdgeSpec(margin) }) {
                        LazyRow(
                            contentPadding = PaddingValues(start = 56.dp, end = 56.dp, top = 14.dp, bottom = 40.dp),
                            horizontalArrangement = Arrangement.spacedBy(22.dp),
                            modifier = Modifier.fillMaxWidth().dpadEdges().focusRestorer(),
                        ) {
                            // Played like a trailer: from the start, nothing reported, no Watch Next entry.
                            items(extras, key = { it.id }) { ex ->
                                ThumbCard(ex, api, onClick = { playTrailer(context, ex.id, Servers.extraOf(api.server.id)?.server?.id) }, inSeries = true, focusModifier = Modifier.remembered(memory, "extra-${ex.id}"))
                            }
                        }
                    }
                }
            }
        }
    }
}

// "Ouvrir dans un lecteur externe" (VLC, MX Player…): the position it hands back becomes the
// resume point. Shown only when such a player is installed.
@Composable
private fun ExternalPill(api: Api, item: Item, modifier: Modifier) {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        Core.scope.launch { if (ExternalPlayer.report(api, item, r.data)) Cache.changed() }
    }
    val label = stringResource(com.wika.wicaby.core.R.string.external_player_open)
    Pill(
        null, icon = Ic.External, modifier = modifier.semantics { contentDescription = label },
        onClick = { runCatching { launcher.launch(ExternalPlayer.intent(context, api, item)) } },
    )
}

// Version, Audio, Sous-titres under the actions: each opens a picker. The audio and subtitle
// lists are the selected version's; picks go to the player through core's Versions.
@Composable
private fun TrackSelectors(item: Item, source: MediaSource, onVersion: (String) -> Unit, memory: FocusMemory) {
    val overlay = LocalOverlay.current
    val versions = item.mediaSources
    val audio = source.mediaStreams.filter { it.type == "Audio" }
    val subs = source.mediaStreams.filter { it.type == "Subtitle" }
    if (versions.size < 2 && audio.size < 2 && subs.isEmpty()) return
    val pick = Versions.pick(item.id, source.id)
    var audioPick by remember(item.id, source.id) { mutableStateOf(pick?.audio) }
    var subPick by remember(item.id, source.id) { mutableStateOf(pick?.subtitle) }
    val versionLabels = remember(item) { Versions.labels(item) }

    val audioNames = audio.map { trackName(it) }
    val off = stringResource(R.string.subtitles_off)
    val subNames = listOf(off) + subs.map { trackName(it) }
    val versionTitle = stringResource(com.wika.wicaby.core.R.string.version)
    val audioTitle = stringResource(R.string.audio)
    val subTitle = stringResource(R.string.subtitles)
    Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (versions.size > 1) {
            val i = versions.indexOfFirst { it.id == source.id }.coerceAtLeast(0)
            SelectorPill(versionTitle, versionLabels.getOrElse(i) { "" }, Modifier.remembered(memory, "version")) {
                overlay.show { TvPicker(versionTitle, versionLabels, i, onSelect = { n -> onVersion(versions[n].id) }, onDismiss = overlay::close, width = 600.dp) }
            }
        }
        if (audio.size > 1) {
            val current = audioPick ?: Versions.defaultAudioStream(source)?.index
            val i = audio.indexOfFirst { it.index == current }.coerceAtLeast(0)
            SelectorPill(audioTitle, audioNames.getOrElse(i) { "" }, Modifier.remembered(memory, "audio")) {
                overlay.show {
                    TvPicker(audioTitle, audioNames, i, width = 520.dp, onSelect = { n ->
                        audioPick = audio[n].index
                        Versions.setPick(item.id, source.id, audioPick, subPick)
                    }, onDismiss = overlay::close)
                }
            }
        }
        if (subs.isNotEmpty()) {
            val current = subPick ?: Versions.defaultSubtitleIndex(source)
            val i = (subs.indexOfFirst { it.index == current } + 1).coerceAtLeast(0)
            SelectorPill(subTitle, subNames[i], Modifier.remembered(memory, "subs")) {
                overlay.show {
                    TvPicker(subTitle, subNames, i, width = 520.dp, onSelect = { n ->
                        subPick = if (n == 0) -1 else subs[n - 1].index
                        Versions.setPick(item.id, source.id, audioPick, subPick)
                    }, onDismiss = overlay::close)
                }
            }
        }
    }
}

// "Version  4K HDR · HEVC": a quiet two-tone pill, white when focused.
@Composable
private fun SelectorPill(title: String, value: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val bg by animateColorAsState(if (focused) Color.White else C.fill2, tween(160), label = "selector")
    Row(
        modifier
            .tvFocus(RoundedCornerShape(50), focusedScale = 1.06f, sheen = false, elevation = 10.dp, onFocusChange = { focused = it }, onClick = onClick)
            .background(bg)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, style = Type.callout, color = if (focused) Color.Black.copy(alpha = 0.6f) else C.label3, maxLines = 1)
        Text(value, style = Type.callout, color = if (focused) Color.Black else C.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 260.dp))
    }
}

// "Bande-annonce": a local trailer plays in Wicaby's player (reporting nothing); a remote one
// opens in YouTube or the browser, or, when the TV has neither, shows its link as a QR code.
@Composable
private fun TrailerPill(api: Api, item: Item, modifier: Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val overlay = LocalOverlay.current
    Pill(stringResource(com.wika.wicaby.core.R.string.trailer), icon = Ic.Movie, modifier = modifier, onClick = {
        scope.launch {
            if ((item.localTrailerCount ?: 0) > 0) {
                val local = runCatching { api.localTrailers(item.id) }.getOrNull()?.firstOrNull()
                if (local != null) return@launch playTrailer(context, local.id, Servers.extraOf(api.server.id)?.server?.id)
            }
            val url = Trailers.remoteUrl(item) ?: return@launch
            if (!Trailers.openRemote(context, url)) overlay.show { TrailerQr(url, overlay::close) }
        }
    })
}

@Composable
private fun TrailerQr(url: String, onDismiss: () -> Unit) {
    TvSheet(onDismiss, width = 440.dp) {
        Text(stringResource(com.wika.wicaby.core.R.string.trailer_qr_title), style = Type.title2, color = C.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        Text(
            stringResource(com.wika.wicaby.core.R.string.trailer_qr_body), style = Type.callout, color = C.label2, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 18.dp),
        )
        QrCode(url, Modifier.size(160.dp).align(Alignment.CenterHorizontally))
        Text(url, style = Type.caption, color = C.label3, textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 16.dp))
        val first = remember { FocusRequester() }
        LaunchedEffect(Unit) {
            delay(60)
            runCatching { first.requestFocus() }
        }
        SheetButton(stringResource(com.wika.wicaby.core.R.string.close), onClick = onDismiss, modifier = Modifier.focusRequester(first))
    }
}

@Composable
private fun trackName(s: MediaStream): String = s.displayTitle ?: s.title ?: s.language ?: stringResource(R.string.track_unknown, s.index)
