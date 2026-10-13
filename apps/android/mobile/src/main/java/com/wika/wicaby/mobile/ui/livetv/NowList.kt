package com.wika.wicaby.mobile.ui.livetv

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.livetv.Category
import com.wika.wicaby.core.livetv.ChannelRow
import com.wika.wicaby.core.livetv.Dialect
import com.wika.wicaby.core.livetv.LensInput
import com.wika.wicaby.core.livetv.LensPrefs
import com.wika.wicaby.core.livetv.LensRef
import com.wika.wicaby.core.livetv.LiveApiException
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.MINUTE
import com.wika.wicaby.core.livetv.OnNowSource
import com.wika.wicaby.core.livetv.ProgramLite
import com.wika.wicaby.core.livetv.applyLens
import com.wika.wicaby.core.livetv.normalizeProgram
import com.wika.wicaby.core.livetv.onNowProbe
import com.wika.wicaby.core.livetv.recentIds
import com.wika.wicaby.core.livetv.reconcileFavorites
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.Radius
import com.wika.wicaby.mobile.ui.SectionTitle
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.pressScale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

// The En direct tab (spec §3.1): "Reprendre {chaîne}", favourites, recents, the "En ce moment" and
// category rails, then every channel as the compact list (the Guide tab's rows at "now").

private val RAILS = listOf(
    null to R.string.livetv_now_rows_on_now,
    Category.SPORTS to R.string.livetv_now_rows_sports,
    Category.MOVIES to R.string.livetv_now_rows_movies,
    Category.NEWS to R.string.livetv_now_rows_news,
    Category.KIDS to R.string.livetv_now_rows_kids,
    Category.SERIES to R.string.livetv_now_rows_series,
)

/** Programmes airing now, optionally in a category; the V15 probe falls back to a time window. */
private suspend fun onNow(repo: LiveTvRepository, cat: Category?): List<ProgramLite> {
    val api = repo.api
    val now = repo.now()
    suspend fun fetch(source: OnNowSource): List<JsonObject> {
        val req = Dialect.onNow(api.kind, api.userId, now, cat, source) ?: return emptyList()
        return ((api.json(req) as? JsonObject)?.get("Items") as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
    }
    var raw = fetch(OnNowSource.RECOMMENDED)
    if (onNowProbe(raw, now) == OnNowSource.WINDOW) raw = fetch(OnNowSource.WINDOW)
    return raw.mapNotNull { normalizeProgram(it, api.kind) }.filter { it.start <= now && it.end > now }
}

@Composable
fun NowList(repo: LiveTvRepository, nonce: Int, onAgenda: (String) -> Unit) {
    val context = LocalContext.current
    val channels by repo.channels.collectAsState()
    val prefs by repo.prefs.prefs.collectAsState()
    val ver by repo.guideVersion.collectAsState()
    val now by rememberNow(repo)
    val byId = remember(channels) { channels.associateBy { it.id } }
    val hidden = remember(prefs.hidden) { prefs.hidden.toHashSet() }
    // "Toutes les chaînes": the All lens (hidden out, the user's sort), derived off the main thread.
    val all by produceState(emptyList<ChannelRow>(), channels, prefs) {
        value = withContext(Dispatchers.Default) {
            applyLens(LensInput(channels, LensRef.All, LensPrefs(prefs.fav, prefs.hidden, prefs.groups, prefs.recents), prefs.sort, prefs.favFirst))
        }
    }
    val favs = remember(channels, prefs.fav, hidden) { reconcileFavorites(channels, prefs.fav).filter { it.id !in hidden } }
    val recents = remember(byId, prefs.recents) { recentIds(channels, prefs.recents).mapNotNull { byId[it] } }
    val railIds = remember(favs, recents) { (recents + favs).map { it.id }.distinct().take(repo.tuning.tileChannels * 3) }
    // Now for the favourite and recent cards: one direct request (they are rarely in the visible rows).
    val railNow by produceState(emptyMap<String, ProgramLite>(), railIds, nonce) {
        if (railIds.isEmpty()) return@produceState
        val t = repo.now()
        value = try {
            repo.api.programsTile(railIds, t, t + MINUTE, false).programs.filter { it.start <= t && it.end > t }.associateBy { it.channelId }
        } catch (_: LiveApiException) {
            value
        }
    }
    val rails = RAILS.map { (cat, title) ->
        val list by produceState(emptyList<ProgramLite>(), cat, nonce) {
            value = try { onNow(repo, cat).distinctBy { it.id } } catch (_: LiveApiException) { value }
        }
        title to list.filter { it.channelId in byId && it.channelId !in hidden }
    }

    val list = rememberLazyListState()
    // List items before the channel rows: top, resume + recents rail, favourites rail, the programme rails, the title.
    val header = 2 + (if (recents.isNotEmpty()) 2 else 0) + (if (favs.isNotEmpty()) 1 else 0) + rails.count { it.second.isNotEmpty() }
    RowsViewport(repo, list, all, now, offset = header)
    LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = 24.dp)) {
        item("top") { Box(Modifier.padding(top = 4.dp)) }
        recents.firstOrNull()?.let { last ->
            item("resume") { ResumeCard(repo, last, railNow[last.id], now) { tune(context, repo, last.id) } }
        }
        if (favs.isNotEmpty()) item("favs") {
            Rail(stringResource(R.string.livetv_now_rows_favorites)) {
                items(favs, key = { it.id }) { ch -> ChannelCard(repo, ch, railNow[ch.id], now) { tune(context, repo, ch.id) } }
            }
        }
        if (recents.isNotEmpty()) item("recents") {
            Rail(stringResource(R.string.livetv_now_rows_recents)) {
                items(recents, key = { it.id }) { ch -> ChannelCard(repo, ch, railNow[ch.id], now) { tune(context, repo, ch.id) } }
            }
        }
        for ((title, progs) in rails) {
            if (progs.isEmpty()) continue
            item("rail-$title") {
                Rail(stringResource(title)) {
                    items(progs, key = { it.id }) { p -> ChannelCard(repo, byId.getValue(p.channelId), p, now) { tune(context, repo, p.channelId) } }
                }
            }
        }
        item("all") { SectionTitle(stringResource(R.string.livetv_now_rows_all_channels), Modifier.padding(top = 22.dp)) }
        channelItems(repo, all, now, live = true, ver = ver, onAgenda = onAgenda)
    }
}

@Composable
private fun Rail(title: String, content: androidx.compose.foundation.lazy.LazyListScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 22.dp)) {
        SectionTitle(title)
        LazyRow(contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}

/** A channel with its current programme: the logo on a tile, the title, "jusqu’à 21:00", progress. */
@Composable
private fun ChannelCard(repo: LiveTvRepository, ch: ChannelRow, p: ProgramLite?, now: Long, onClick: () -> Unit) {
    val fmt = rememberTimeFormat()
    val source = remember { MutableInteractionSource() }
    Column(Modifier.width(176.dp).pressScale(source).clickable(source, null, role = Role.Button, onClick = onClick)) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(Radius.md)).background(G.elevated2), contentAlignment = Alignment.Center) {
            ChannelLogo(repo, ch, 40.dp, Modifier.padding(horizontal = 16.dp))
        }
        Text(p?.title ?: ch.name, style = Type.callout, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp, start = 2.dp))
        if (p != null) {
            Text(stringResource(R.string.livetv_now_until, fmt(p.end)), style = Type.footnote, color = G.label2, maxLines = 1, modifier = Modifier.padding(start = 2.dp))
            ProgramProgress(p, now, Modifier.padding(top = 6.dp, start = 2.dp, end = 2.dp).fillMaxWidth())
        }
    }
}

/** "Reprendre {chaîne}": the last channel, a static card (§2.2). */
@Composable
private fun ResumeCard(repo: LiveTvRepository, ch: ChannelRow, p: ProgramLite?, now: Long, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    Row(
        Modifier.padding(horizontal = 20.dp, vertical = 6.dp).fillMaxWidth().pressScale(source).clip(RoundedCornerShape(Radius.lg))
            .background(G.elevated2).clickable(source, null, role = Role.Button, onClick = onClick).padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ChannelLogo(repo, ch, 40.dp, Modifier.width(88.dp))
        Column(Modifier.weight(1f).padding(horizontal = 14.dp)) {
            Text(stringResource(R.string.livetv_now_resume, ch.name), style = Type.headline, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (p != null) {
                Text(p.title, style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                ProgramProgress(p, now, Modifier.padding(top = 6.dp).fillMaxWidth())
            }
        }
        Icon(Ic.Play, contentDescription = null, tint = G.label, modifier = Modifier.size(24.dp))
    }
}
