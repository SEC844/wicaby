package com.wika.wicaby.tv.ui.livetv

import android.content.Context
import android.content.res.Resources
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.livetv.ChannelRow
import com.wika.wicaby.core.livetv.Dialect
import com.wika.wicaby.core.livetv.FocusKind
import com.wika.wicaby.core.livetv.GuideFocus
import com.wika.wicaby.core.livetv.LiveApiException
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.Mark
import com.wika.wicaby.core.livetv.ProgramLite
import com.wika.wicaby.core.livetv.Reminder
import com.wika.wicaby.core.livetv.Reminders
import com.wika.wicaby.core.livetv.TimerLite
import com.wika.wicaby.core.livetv.fireAt
import com.wika.wicaby.core.livetv.markFor
import com.wika.wicaby.livetvui.CellContext
import com.wika.wicaby.livetvui.GuideState
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.data.TvSettings
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Ic
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.SheetButton
import com.wika.wicaby.tv.ui.TvSheet
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.dpPx
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// The detail band over the guide (spec §6.1: 150 dp, always on, no hover on TV) and the programme
// sheet (long OK, INFO, OK on a programme that is not airing). Art and the overview wait for 400 ms of
// stable focus (§2.2) so a held D-pad never loads images. Also the focused cell's TalkBack label (§12).

/** Overviews by programme id (the tiles carry no overview): a small LRU, main thread only. */
private object Overviews {
    private val map = object : LinkedHashMap<String, String>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > 64
    }

    fun peek(id: String): String? = map[id]

    suspend fun load(repo: LiveTvRepository, id: String): String {
        map[id]?.let { return it }
        val text = try {
            ((repo.api.json(Dialect.programDetail(repo.api.kind, repo.api.userId, id)) as? JsonObject)?.get("Overview") as? JsonPrimitive)?.content.orEmpty()
        } catch (_: LiveApiException) {
            return ""
        }
        map[id] = text
        return text
    }
}

/** The programme under the focus, from the memory cache (main-thread safe). */
internal fun programOf(repo: LiveTvRepository, f: GuideFocus?): ProgramLite? {
    if (f == null || f.kind != FocusKind.PROGRAM) return null
    return repo.programs(f.channelId, f.start ?: return null, f.end ?: return null).firstOrNull { it.id == f.programId }
}

private val MARK_TEXT = mapOf(
    Mark.TIMER to R.string.livetv_marks_timer,
    Mark.SERIES to R.string.livetv_marks_series,
    Mark.RECORDING to R.string.livetv_marks_recording,
    Mark.CONFLICT_WONT to R.string.livetv_marks_wont_record,
    Mark.CONFLICT_OK to R.string.livetv_marks_conflict_ok,
    Mark.ERROR to R.string.livetv_marks_error,
    Mark.RULE_SKIP to R.string.livetv_marks_rule_skips,
)

/** The status words of a programme: badges, the recording mark and the reminder (colour is never the only signal). */
private fun statusWords(res: Resources, p: ProgramLite, marks: Map<String, TimerLite>, reminded: Boolean, ctx: CellContext): List<String> {
    val out = ArrayList(ctx.badgesOf(p))
    markFor(p, marks.takeIf { it.isNotEmpty() })?.let { m -> MARK_TEXT[m]?.let { out.add(res.getString(it)) } }
    if (reminded) out.add(res.getString(R.string.livetv_marks_reminder))
    return out
}

/** §12, §21.7: the focused cell's label, published on the grid's single focus node and its live region. */
@Composable
internal fun focusLabel(f: GuideFocus?, p: ProgramLite?, byId: Map<String, ChannelRow>, now: Long, marks: Map<String, TimerLite>, reminders: Set<String>, ctx: CellContext): String {
    val res = LocalResources.current
    f ?: return ""
    val row = byId[f.channelId] ?: return ""
    val channel = if (row.number.isNotEmpty()) res.getString(R.string.livetv_guide_aria_channel, row.number, row.name) else row.name
    return when {
        p != null -> {
            val parts = arrayListOf(res.getString(R.string.livetv_guide_aria_cell, p.title, row.name, ctx.timeFmt.format(java.util.Date(p.start)), ctx.timeFmt.format(java.util.Date(p.end))))
            if (p.start <= now && now < p.end) parts.add(res.getString(R.string.livetv_guide_aria_on_now, ((now - p.start) * 100 / maxOf(1, p.end - p.start)).toInt()))
            parts.addAll(statusWords(res, p, marks, p.id in reminders, ctx))
            parts.joinToString(", ")
        }
        f.kind == FocusKind.FILLER -> res.getString(R.string.livetv_guide_aria_filler, row.name)
        else -> channel
    }
}

@Composable
internal fun DetailBand(
    api: Api,
    repo: LiveTvRepository,
    st: GuideState,
    byId: Map<String, ChannelRow>,
    marks: Map<String, TimerLite>,
    reminders: Set<String>,
    ctx: CellContext,
    modifier: Modifier,
) {
    val res = LocalResources.current
    val f = st.shown
    val p = programOf(repo, f)
    val now = st.now
    val row = f?.let { byId[it.channelId] }
    var settled by remember { mutableStateOf<String?>(null) }
    var overview by remember { mutableStateOf("") }
    LaunchedEffect(p?.id) {
        settled = null
        overview = p?.id?.let(Overviews::peek).orEmpty()
        val id = p?.id ?: return@LaunchedEffect
        delay(repo.tuning.artDelayMs.toLong())
        settled = id
        overview = Overviews.load(repo, id)
    }
    val artW = dpPx(224.dp)
    Row(
        modifier.background(C.elevated2, RoundedCornerShape(Radius.md)).padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Box(Modifier.fillMaxHeight().aspectRatio(16f / 9f).clip(RoundedCornerShape(Radius.sm)).background(C.fill1), contentAlignment = Alignment.Center) {
            val tag = p?.imageTag
            if (p != null && tag != null && settled == p.id) {
                AsyncImage(api.image(p.id, "Primary", tag, maxWidth = artW), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            } else if (row != null) {
                ChannelLogo(api, row, 40.dp)
            }
        }
        Column(Modifier.weight(1f).fillMaxHeight()) {
            if (row == null) return@Column
            Text(p?.title ?: row.name, style = Type.title3, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val episode = p?.takeIf { it.season != null || !it.episodeTitle.isNullOrEmpty() }?.let(ctx::subLine)
            val head = listOfNotNull(episode, p?.let { "${timeText(it.start)} – ${timeText(it.end)}" }, "${row.number} ${row.name}".trim()).joinToString(" · ")
            Text(head, style = Type.footnote, color = C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
            when {
                p != null -> {
                    if (overview.isNotEmpty()) Text(overview, style = Type.footnote, color = C.label2, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
                    val words = statusWords(res, p, marks, p.id in reminders, ctx)
                    if (words.isNotEmpty()) Text(words.joinToString(" · "), style = Type.caption, color = C.label2, maxLines = 1, modifier = Modifier.padding(top = 6.dp))
                    if (p.start <= now && now < p.end) LiveProgress(progressOf(p, now), Modifier.padding(top = 8.dp).fillMaxWidth(0.4f))
                }
                f.kind == FocusKind.FILLER -> Text(ctx.noInfo, style = Type.footnote, color = C.label3, modifier = Modifier.padding(top = 6.dp))
                else -> {
                    val (cur, next) = nowNext(repo, row.id, now)
                    cur?.let { Text(it.title, style = Type.footnote, color = C.label2, maxLines = 1, modifier = Modifier.padding(top = 6.dp)) }
                    next?.let { Text("${timeText(it.start)}  ${it.title}", style = Type.footnote, color = C.label3, maxLines = 1, modifier = Modifier.padding(top = 2.dp)) }
                }
            }
        }
    }
}

/** Long OK / INFO: the programme sheet, or the channel menu when [p] is null. Record actions only when the server lets us. */
@Composable
internal fun ProgramSheet(
    repo: LiveTvRepository,
    row: ChannelRow,
    p: ProgramLite?,
    now: Long,
    canRecord: Boolean,
    recording: Boolean,
    reminded: Boolean,
    onWatch: () -> Unit,
    onRecord: () -> Unit,
    onRemind: () -> Unit,
    onFavorite: () -> Unit,
    onDismiss: () -> Unit,
) {
    var overview by remember { mutableStateOf(p?.id?.let(Overviews::peek).orEmpty()) }
    LaunchedEffect(p?.id) { p?.id?.let { overview = Overviews.load(repo, it) } }
    TvSheet(onDismiss, width = 540.dp) {
        Text(p?.title ?: row.name, style = Type.title2, color = C.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
        val sub = listOfNotNull(p?.let { "${timeText(it.start)} – ${timeText(it.end)}" }, "${row.number} ${row.name}".trim()).joinToString(" · ")
        Text(sub, style = Type.footnote, color = C.label2, maxLines = 1, modifier = Modifier.padding(top = 4.dp))
        if (overview.isNotEmpty()) Text(overview, style = Type.callout, color = C.label2, maxLines = 5, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 12.dp))
        val first = remember { FocusRequester() }
        LaunchedEffect(Unit) {
            delay(60)
            runCatching { first.requestFocus() }
        }
        Column(Modifier.fillMaxWidth().padding(top = 20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SheetButton(stringResource(R.string.livetv_sheet_watch_channel), onClick = onWatch, icon = Ic.Play, modifier = Modifier.focusRequester(first))
            if (p != null && canRecord && p.end > now) {
                SheetButton(stringResource(if (recording) R.string.livetv_actions_cancel_recording else R.string.livetv_actions_record), onClick = onRecord)
            }
            if (p != null && p.start > now) {
                SheetButton(stringResource(if (reminded) R.string.livetv_sheet_cancel_reminder else R.string.livetv_sheet_remind_me), onClick = onRemind)
            }
            SheetButton(
                stringResource(if (row.favorite) com.wika.wicaby.core.R.string.livetv_channel_favorite_remove else com.wika.wicaby.core.R.string.livetv_channel_favorite_add),
                onClick = onFavorite,
            )
        }
    }
}

/** Me le rappeler / Annuler le rappel (TV: the in-app banner first, §21.3). */
internal suspend fun toggleReminder(context: Context, repo: LiveTvRepository, p: ProgramLite, row: ChannelRow, on: Boolean) {
    val api = repo.api
    if (on) {
        Reminders.cancel(context, api.serverId, api.userId, p.id)
        return
    }
    val lead = TvSettings.liveReminderLeadMin.value
    Reminders.add(
        context,
        Reminder(api.serverId, api.userId, p.id, row.id, p.start, p.title, row.name, lead, TvSettings.liveReminderAutoTune.value, fireAt(p.start, lead, repo.caps.value.clockSkewMs)),
    )
}
