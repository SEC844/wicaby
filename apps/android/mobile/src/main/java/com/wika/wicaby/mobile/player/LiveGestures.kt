package com.wika.wicaby.mobile.player

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.ZapController
import com.wika.wicaby.core.livetv.ZapEntry
import com.wika.wicaby.core.livetv.programAt
import com.wika.wicaby.core.livetv.zapEntry
import com.wika.wicaby.core.livetv.zapTarget
import com.wika.wicaby.core.player.Playback
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.PillButton
import com.wika.wicaby.mobile.ui.Radius
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.livetv.ChannelLogo
import com.wika.wicaby.mobile.ui.livetv.LiveRepos
import com.wika.wicaby.mobile.ui.livetv.ROW_WINDOW_MS
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlin.math.abs

// Mobile live player (spec §10.3, §8.3, work package M-2): a horizontal swipe on the video zaps with a
// peek card, CH± also come from the chips, PiP actions and the media notification (PlaybackService).

/** A swipe commits past this share of the width, or on a fling faster than ZAP_FLING_DP_S. */
const val ZAP_COMMIT_FRACTION = 0.25f
const val ZAP_FLING_DP_S = 1_000f

/** A released swipe: +1 next (finger went left), -1 previous (right), 0 snap back. [velocity] in dp/s. */
fun zapSwipe(dx: Float, width: Float, velocity: Float): Int {
    val fling = abs(velocity) > ZAP_FLING_DP_S && velocity * dx > 0
    if (dx == 0f || (abs(dx) < width * ZAP_COMMIT_FRACTION && !fling)) return 0
    return if (dx < 0) 1 else -1
}

/** The live player's ZapController, kept with its Playback so PiP and notification actions zap off screen. */
object LiveZap {
    private var pb: Playback? = null
    private var ctl: ZapController? = null
    private var scope: CoroutineScope? = null
    var repo: LiveTvRepository? = null
        private set

    /** Something live plays (commands and actions show CH±). */
    val active: Boolean get() = PlayerHolder.playback?.liveState != null

    /** The controller of [pb] while it plays a channel, made on first use (main thread). */
    fun of(context: Context, pb: Playback): ZapController? {
        if (pb.liveState == null) return null
        if (this.pb === pb) return ctl
        drop()
        // TP-06: the zap list of the server the channel plays from.
        val r = LiveRepos.of(context, pb.api).also { it.open() }
        val sc = MainScope()
        val z = ZapController(sc, onTune = { id -> entry(id)?.let(pb::tune) })
        this.pb = pb
        ctl = z
        scope = sc
        repo = r
        // The zap list is the current lens; a lens change from the mini-guide replaces it.
        sc.launch { r.rows.collect { rows -> z.setList(rows.map(::zapEntry), r.prefs.prefs.value.hidden, r.lineup()) } }
        sc.launch {
            snapshotFlow { pb.liveState }.collect { s ->
                if (s == null || s.tuning) return@collect
                val zs = z.state.value
                // A failed zap stays on the open channel (make-before-break).
                zs.tuning?.takeIf { it != s.channel.id }?.let(z::failed)
                if (zs.current != s.channel.id) r.noteTuned(s.channel.id)
                z.adopted(s.channel.id)
            }
        }
        PlayerHolder.onRelease(::drop)
        return z
    }

    private fun entry(id: String): ZapEntry? =
        ctl?.entries?.firstOrNull { it.id == id } ?: repo?.channels?.value?.firstOrNull { it.id == id }?.let(::zapEntry)

    /** CH± from PiP and the notification: false when nothing live plays. */
    fun press(context: Context, delta: Int): Boolean {
        val p = PlayerHolder.playback ?: return false
        val z = of(context, p) ?: return false
        z.press(delta)
        return true
    }

    private fun drop() {
        scope?.cancel()
        scope = null
        ctl = null
        pb = null
    }
}

/** The swipe in progress: offset of the peek card and the channel it shows. */
class ZapDrag {
    var dx by mutableFloatStateOf(0f)
    var target by mutableStateOf<ZapEntry?>(null)
    private val tracker = VelocityTracker()

    fun move(zap: ZapController, total: Float, c: PointerInputChange) {
        tracker.addPosition(c.uptimeMillis, c.position)
        dx = total
        val s = zap.state.value
        val from = s.pending ?: s.tuning ?: s.current ?: return
        val id = zapTarget(zap.entries, from, if (total < 0) 1 else -1)
        target = zap.entries.firstOrNull { it.id == id }
    }

    /** Released: the zap delta (0 = snap back). [density] turns px/s into dp/s. */
    fun end(width: Float, density: Float): Int {
        val v = tracker.calculateVelocity().x / density
        val d = zapSwipe(dx, width, v)
        tracker.resetTracking()
        dx = 0f
        target = null
        return d
    }
}

/** Logo, number, name and current programme of [entry]; follows the finger by [offsetX] px. */
@Composable
fun PeekCard(repo: LiveTvRepository, entry: ZapEntry, offsetX: Float, tuning: Boolean, modifier: Modifier = Modifier) {
    val channels by repo.channels.collectAsState()
    val row = remember(channels, entry.id) { channels.firstOrNull { it.id == entry.id } }
    val now = repo.now()
    val prog = remember(entry.id, now / 60_000) { programAt(repo.programs(entry.id, now, now + ROW_WINDOW_MS), now) }
    Row(
        modifier.graphicsLayer { translationX = offsetX }.widthIn(max = 420.dp).clip(RoundedCornerShape(Radius.lg))
            .background(G.elevated.copy(alpha = 0.92f)).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (row != null) ChannelLogo(repo, row, 36.dp, Modifier.widthIn(max = 72.dp), nameLines = 1)
        Column {
            Text(listOf(entry.number, entry.name).filter { it.isNotEmpty() }.joinToString("  "), style = Type.headline, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val sub = if (tuning) stringResource(R.string.player_live_tuning) else prog?.title
            if (sub != null) Text(sub, style = Type.callout, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Button alternatives to the gestures (§10.3, TalkBack): CH−, channel list, CH+, last channel. */
@Composable
fun LiveChips(zap: ZapController, onList: () -> Unit, modifier: Modifier = Modifier) {
    val s by zap.state.collectAsState()
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        PillButton(null, { zap.press(-1) }, icon = Ic.Back, onArt = true, compact = true, contentDescription = stringResource(R.string.player_live_previous_channel))
        PillButton(stringResource(R.string.player_live_channel_list), onList, icon = Ic.List, onArt = true, compact = true)
        PillButton(null, { zap.press(1) }, icon = Ic.ChevronRight, onArt = true, compact = true, contentDescription = stringResource(R.string.player_live_next_channel))
        if (s.last != null) PillButton(stringResource(R.string.player_live_last_channel), zap::lastChannel, icon = Ic.History, onArt = true, compact = true)
    }
}
