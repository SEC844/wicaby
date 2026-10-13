package com.wika.wicaby.tv.ui.livetv

import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.livetv.ChannelRow
import com.wika.wicaby.core.livetv.GuideClock
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.PendingJump
import com.wika.wicaby.core.livetv.ProgramLite
import com.wika.wicaby.core.livetv.searchPrograms
import com.wika.wicaby.core.livetv.voiceChannels
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.SheetButton
import com.wika.wicaby.tv.ui.TvSheet
import com.wika.wicaby.tv.ui.TvTextField
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.uiLocale
import kotlinx.coroutines.delay

// Guide search (spec §6.8, LT-10, F10): channels first (in memory: name, number prefix, Emby tag, spoken "chaîne 5"; 8),
// programmes from 2 characters after 300 ms (Emby asks the server; Jellyfin probes /Items and falls
// back to the loaded tiles when the server finds nothing the cache has). A pick is a PendingJump, so a
// jump while the guide is loading is replayed. The mic button shows when a speech handler resolves.

private val Mic = ImageVector.Builder(defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
    .addPath(
        addPathNodes("M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"),
        fill = SolidColor(Color.White),
    )
    .build()

@Composable
internal fun GuideSearch(repo: LiveTvRepository, clock: GuideClock, guideEnd: Long, onPick: (PendingJump) -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val locale = uiLocale()
    var query by remember { mutableStateOf("") }
    var programs by remember { mutableStateOf<List<ProgramLite>>(emptyList()) }
    var done by remember { mutableStateOf(false) }
    val byId = remember { repo.channels.value.associateBy { it.id } }
    val channels = remember(query) {
        val hidden = repo.prefs.prefs.value.hidden.toHashSet()
        if (query.isBlank()) emptyList() else voiceChannels(repo.channels.value.filter { it.id !in hidden }, query)
    }
    LaunchedEffect(query) {
        val q = query.trim()
        done = false
        if (q.length < 2) {
            programs = emptyList()
            return@LaunchedEffect
        }
        delay(300)
        programs = repo.searchPrograms(q, guideEnd)
        done = true
    }
    val voiceIntent = remember {
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
    }
    val canVoice = remember { voiceIntent.resolveActivity(context.packageManager) != null }
    val voice = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        r.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.let { query = it }
    }
    val now = repo.now()
    fun pickChannel(r: ChannelRow) = onPick(PendingJump(r.id, repo.now()))
    fun pickProgram(p: ProgramLite) = onPick(PendingJump(p.channelId, p.start, p.id))

    TvSheet(onDismiss, alignment = Alignment.TopCenter, width = 640.dp, padding = PaddingValues(top = 40.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TvTextField(
                query, { query = it }, stringResource(R.string.livetv_search_placeholder), Modifier.weight(1f),
                imeAction = ImeAction.Search, autoEdit = true,
                onSubmit = { channels.firstOrNull()?.let(::pickChannel) ?: programs.firstOrNull()?.let(::pickProgram) },
            )
            if (canVoice) {
                val voiceLabel = stringResource(R.string.livetv_search_voice)
                Pill(null, icon = Mic, onClick = { voice.launch(voiceIntent) }, modifier = Modifier.semantics { contentDescription = voiceLabel })
            }
        }
        val q = query.trim()
        when {
            q.length == 1 && channels.isEmpty() -> Hint(stringResource(R.string.livetv_search_min_chars))
            done && channels.isEmpty() && programs.isEmpty() -> Hint(stringResource(R.string.livetv_search_empty, q))
        }
        // Rows: channel hits, then programmes grouped by day (time span, an airing marker).
        val onNow = stringResource(R.string.livetv_now_rows_on_now)
        val channelsHead = stringResource(R.string.livetv_search_channels)
        val programsHead = stringResource(R.string.livetv_search_programs)
        val rows = remember(channels, programs) {
            buildList<Any> {
                if (channels.isNotEmpty()) add(channelsHead)
                addAll(channels)
                var day: String? = null
                if (programs.isNotEmpty()) add(programsHead)
                for (p in programs) {
                    val d = dayLabel(clock, p.start, now, locale, context)
                    if (d != day) add(d.also { day = it })
                    add(p)
                }
            }
        }
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 380.dp).padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(rows) { r ->
                when (r) {
                    is String -> Text(r, style = Type.caption, color = C.label2, modifier = Modifier.padding(top = 8.dp, start = 4.dp))
                    is ChannelRow -> SheetButton("${r.number}  ${r.name}".trim(), onClick = { pickChannel(r) }, centered = false)
                    is ProgramLite -> {
                        val airing = r.start <= now && now < r.end
                        val parts = listOfNotNull(r.title, "${timeText(r.start)} – ${timeText(r.end)}", byId[r.channelId]?.name, onNow.takeIf { airing })
                        SheetButton(parts.joinToString(" · "), onClick = { pickProgram(r) }, centered = false)
                    }
                }
            }
        }
    }
}

@Composable
private fun Hint(text: String) = Text(text, style = Type.footnote, color = C.label3, modifier = Modifier.padding(top = 14.dp, start = 4.dp))
