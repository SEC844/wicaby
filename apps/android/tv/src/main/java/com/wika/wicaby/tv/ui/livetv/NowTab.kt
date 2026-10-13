package com.wika.wicaby.tv.ui.livetv

import com.wika.wicaby.tv.ui.dpadEdges
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
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
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ItemsResult
import com.wika.wicaby.core.livetv.Category
import com.wika.wicaby.core.livetv.CategorySource
import com.wika.wicaby.core.livetv.ChannelRow
import com.wika.wicaby.core.livetv.Dialect
import com.wika.wicaby.core.livetv.LiveApiException
import com.wika.wicaby.core.livetv.LiveTvPrefs
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.OnNowSource
import com.wika.wicaby.core.livetv.ProgramLite
import com.wika.wicaby.core.livetv.normalizeProgram
import com.wika.wicaby.core.livetv.onNowProbe
import com.wika.wicaby.core.livetv.programInCategory
import com.wika.wicaby.core.livetv.recentIds
import com.wika.wicaby.core.livetv.reconcileFavorites
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.play
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.EdgeSpec
import com.wika.wicaby.tv.ui.FocusMemory
import com.wika.wicaby.tv.ui.Ic
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.ThumbCard
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.dpPx
import com.wika.wicaby.tv.ui.remembered
import com.wika.wicaby.tv.ui.tvFocus
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

// "En direct" (spec §3.1, TV-1): the static "Reprendre" card (never rotating, §2.2), favourites,
// recents, on now, the category rails (rebuilt from the on-now genres when the server rail is empty,
// §6.6), recording now, then "Toutes les chaînes" as the compact list (LiveTvScreen adds the rows).

private val RAILS = listOf(
    Category.SPORTS to R.string.livetv_now_rows_sports,
    Category.MOVIES to R.string.livetv_now_rows_movies,
    Category.NEWS to R.string.livetv_now_rows_news,
    Category.KIDS to R.string.livetv_now_rows_kids,
    Category.SERIES to R.string.livetv_now_rows_series,
)

/** The server rails of En direct, loaded while visible (every 5 min); one per repository. */
class NowRails(private val repo: LiveTvRepository) {
    var onNow by mutableStateOf<List<ProgramLite>>(emptyList())
        private set
    var byCategory by mutableStateOf<Map<Category, List<ProgramLite>>>(emptyMap())
        private set
    var recording by mutableStateOf<List<Item>>(emptyList())
        private set
    var loaded by mutableStateOf(false)
        private set

    // §5.1 V15: an Emby that ignores IsAiring switches to the window query (for this repository).
    private var source: OnNowSource? = null

    private suspend fun onNowRaw(cat: Category?): List<JsonObject> {
        val live = repo.api
        val now = repo.now()
        val src = source ?: repo.caps.value.onNowSource
        val req = Dialect.onNow(live.kind, live.userId, now, cat, src) ?: return emptyList()
        val items = ((live.json(req) as? JsonObject)?.get("Items") as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
        if (src == OnNowSource.RECOMMENDED && onNowProbe(items, now) == OnNowSource.WINDOW) {
            source = OnNowSource.WINDOW
            return onNowRaw(cat)
        }
        return items
    }

    private suspend fun onNow(cat: Category?): List<ProgramLite>? = try {
        onNowRaw(cat).mapNotNull { normalizeProgram(it, repo.api.kind, CategorySource.GENRES) }
    } catch (e: LiveApiException) {
        null
    }

    suspend fun load(api: Api) {
        onNow(null)?.let { onNow = it }
        // One at a time: a low-RAM 32-bit TV allows 2 requests in flight and the guide tiles come first.
        val cats = HashMap<Category, List<ProgramLite>>()
        for ((cat, _) in RAILS) onNow(cat)?.let { cats[cat] = it }
        byCategory = cats
        try {
            val req = Dialect.recordings(repo.api.kind, repo.api.userId, limit = 24, inProgress = true)
            recording = api.get<ItemsResult>(req.path, *req.query.toList().toTypedArray()).items
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
        loaded = true
    }
}

/** What the rails show, derived from the lineup and the synced prefs (hidden channels left out). */
class NowModel(
    val byId: Map<String, ChannelRow>,
    val hidden: Set<String>,
    val favorites: List<ChannelRow>,
    val recents: List<ChannelRow>,
) {
    val last: ChannelRow? get() = recents.firstOrNull()

    /** The channels whose "now" slab the planner fetches for the rails. */
    val railIds: List<String> = (favorites + recents).map { it.id }.distinct()

    companion object {
        fun of(channels: List<ChannelRow>, prefs: LiveTvPrefs): NowModel {
            val hidden = prefs.hidden.toHashSet()
            val byId = channels.associateBy { it.id }
            return NowModel(
                byId, hidden,
                reconcileFavorites(channels, prefs.fav).filter { it.id !in hidden }.take(30),
                recentIds(channels, prefs.recents).mapNotNull { byId[it] }.filter { it.id !in hidden },
            )
        }
    }
}

internal fun LazyListScope.nowItems(
    api: Api,
    repo: LiveTvRepository,
    model: NowModel,
    rails: NowRails,
    tick: Tick,
    memory: FocusMemory,
    entry: FocusRequester,
    tune: (String) -> Unit,
    onGuide: () -> Unit,
) {
    model.last?.let { last ->
        item("resume") { ResumeCard(api, repo, last, tick, memory, entry) { tune(last.id) } }
    }
    // Without Reprendre, the first card of the first rail is the entry (first focus); read outside the lazy item lambdas.
    var lead: FocusRequester? = if (model.last == null) entry else null
    fun take() = lead.also { lead = null }
    if (model.favorites.isNotEmpty()) {
        val l = take()
        item("fav") { Rail(stringResource(R.string.livetv_now_rows_favorites), model.favorites, { it.id }, memory, "fav", l) { r, m -> ChannelCard(api, repo, r, tick, m) { tune(r.id) } } }
    }
    if (model.recents.isNotEmpty()) {
        val l = take()
        item("recents") { Rail(stringResource(R.string.livetv_now_rows_recents), model.recents, { it.id }, memory, "recents", l) { r, m -> ChannelCard(api, repo, r, tick, m) { tune(r.id) } } }
    }
    val airing = rails.onNow.filter { it.channelId in model.byId && it.channelId !in model.hidden }
    if (airing.isNotEmpty()) {
        val l = take()
        item("onnow") { Rail(stringResource(R.string.livetv_now_rows_on_now), airing, { it.id }, memory, "onnow", l) { p, m -> ProgramCard(api, p, model.byId[p.channelId], tick.now, m) { tune(p.channelId) } } }
    }
    for ((cat, title) in RAILS) {
        val server = rails.byCategory[cat].orEmpty().filter { it.channelId in model.byId && it.channelId !in model.hidden }
        val list = server.ifEmpty { airing.filter { programInCategory(it.flags, cat) } }
        if (list.isEmpty()) continue
        val l = take()
        item("cat-${cat.id}") { Rail(stringResource(title), list, { it.id }, memory, "cat-${cat.id}", l) { p, m -> ProgramCard(api, p, model.byId[p.channelId], tick.now, m) { tune(p.channelId) } } }
    }
    if (rails.recording.isNotEmpty()) {
        val l = take()
        item("recording") {
            val context = LocalContext.current
            Rail(stringResource(R.string.livetv_now_rows_recording), rails.recording, { it.id }, memory, "recording", l) { it, m -> ThumbCard(it, api, onClick = { play(context, it) }, focusModifier = m) }
        }
    }
    if (rails.loaded && airing.isEmpty() && model.byId.isEmpty()) item("empty") {
        Column(Modifier.fillMaxWidth().padding(vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.livetv_now_empty), style = Type.body, color = C.label3)
            Pill(stringResource(R.string.livetv_now_open_guide), onClick = onGuide, modifier = Modifier.padding(top = 14.dp))
        }
    }
    item("all") {
        Text(stringResource(R.string.livetv_now_rows_all_channels), style = Type.title3, color = C.label, modifier = Modifier.padding(start = 48.dp, top = 28.dp, bottom = 14.dp))
    }
}

@OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable
private fun <T> Rail(title: String, items: List<T>, key: (T) -> String, memory: FocusMemory, rowKey: String, lead: FocusRequester?, card: @Composable (T, Modifier) -> Unit) {
    val margin = with(LocalDensity.current) { 56.dp.toPx() }
    val spec = remember(margin) { EdgeSpec(margin) }
    Column(Modifier.fillMaxWidth().padding(top = 14.dp)) {
        Text(title, style = Type.title3, color = C.label, modifier = Modifier.padding(start = 48.dp, bottom = 2.dp))
        CompositionLocalProvider(LocalBringIntoViewSpec provides spec) {
            LazyRow(
                modifier = Modifier.fillMaxWidth().dpadEdges().focusRestorer(),
                contentPadding = PaddingValues(horizontal = 48.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(22.dp),
            ) {
                items(items, key = key) {
                    val first = lead != null && it === items[0]
                    card(it, Modifier.remembered(memory, "$rowKey/${key(it)}", default = first).then(if (first) Modifier.focusRequester(lead!!) else Modifier))
                }
            }
        }
    }
}

/** "Reprendre {chaîne}": the last channel, static (§2.2). */
@Composable
private fun ResumeCard(api: Api, repo: LiveTvRepository, row: ChannelRow, tick: Tick, memory: FocusMemory, entry: FocusRequester, onClick: () -> Unit) {
    val now = tick.now
    val cur = nowNext(repo, row.id, now).first
    Row(
        Modifier
            .padding(start = 48.dp, bottom = 8.dp)
            .width(560.dp)
            .remembered(memory, "resume", default = true)
            .focusRequester(entry)
            .tvFocus(RoundedCornerShape(Radius.lg), focusedScale = 1.06f, onClick = onClick)
            .background(C.elevated)
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        ChannelLogo(api, row, 48.dp)
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.livetv_now_resume, row.name), style = Type.headline, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (cur != null) {
                Text(cur.title, style = Type.footnote, color = C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                LiveProgress(progressOf(cur, now), Modifier.padding(top = 6.dp))
            }
        }
        Icon(Ic.Play, contentDescription = null, tint = C.label, modifier = Modifier.size(22.dp))
    }
}

/** A favourite or recent channel: its logo, what is on and how far it went. */
@Composable
private fun ChannelCard(api: Api, repo: LiveTvRepository, row: ChannelRow, tick: Tick, focusModifier: Modifier, onClick: () -> Unit) {
    val now = tick.now
    var focused by remember { mutableStateOf(false) }
    val cur = nowNext(repo, row.id, now).first
    Column(Modifier.width(232.dp)) {
        Box(
            Modifier.fillMaxWidth().aspectRatio(16f / 9f).then(focusModifier)
                .tvFocus(RoundedCornerShape(Radius.md), focusedScale = 1.06f, onFocusChange = { focused = it }, onClick = onClick)
                .background(C.elevated2),
            contentAlignment = Alignment.Center,
        ) {
            ChannelLogo(api, row, 52.dp)
            if (cur != null) LiveProgress(progressOf(cur, now), Modifier.align(Alignment.BottomCenter).padding(horizontal = 12.dp, vertical = 10.dp))
        }
        Text(cur?.title ?: row.name, style = Type.callout, color = if (focused) C.label else C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 12.dp, start = 2.dp))
        Text("${row.number}  ${row.name}".trim(), style = Type.footnote, color = C.label3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp, start = 2.dp))
    }
}

/** An airing programme (OK tunes its channel): its art, else the channel logo. */
@Composable
private fun ProgramCard(api: Api, p: ProgramLite, channel: ChannelRow?, now: Long, focusModifier: Modifier, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val w = dpPx(232.dp)
    Column(Modifier.width(232.dp)) {
        Box(
            Modifier.fillMaxWidth().aspectRatio(16f / 9f).then(focusModifier)
                .tvFocus(RoundedCornerShape(Radius.md), focusedScale = 1.06f, onFocusChange = { focused = it }, onClick = onClick)
                .background(C.elevated2),
            contentAlignment = Alignment.Center,
        ) {
            val art = remember(p.id) { p.imageTag?.let { api.image(p.id, "Primary", it, maxWidth = w) } }
            if (art != null) {
                AsyncImage(art, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            } else if (channel != null) {
                ChannelLogo(api, channel, 52.dp)
            }
            LiveProgress(progressOf(p, now), Modifier.align(Alignment.BottomCenter).padding(horizontal = 12.dp, vertical = 10.dp))
        }
        Text(p.title, style = Type.callout, color = if (focused) C.label else C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 12.dp, start = 2.dp))
        val sub = listOfNotNull(channel?.name, stringResource(R.string.livetv_now_until, timeText(p.end))).joinToString(" · ")
        Text(sub, style = Type.footnote, color = C.label3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp, start = 2.dp))
    }
}
