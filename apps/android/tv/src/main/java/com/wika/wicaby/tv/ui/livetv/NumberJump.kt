package com.wika.wicaby.tv.ui.livetv

import android.content.Context
import android.os.SystemClock
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.livetv.ChannelRow
import com.wika.wicaby.core.livetv.DigitEvent
import com.wika.wicaby.core.livetv.DigitIndex
import com.wika.wicaby.core.livetv.DigitPreview
import com.wika.wicaby.core.livetv.DigitResult
import com.wika.wicaby.core.livetv.DigitState
import com.wika.wicaby.core.livetv.JUMP_TIMEOUT_MS
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.PendingJump
import com.wika.wicaby.core.livetv.digitIndex
import com.wika.wicaby.core.livetv.digitReduce
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.GeistMono
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.Type

// Digits in the guide (spec §6.8, §8.4): the shared digit buffer (Zap.kt) in jump mode, 1,200 ms.
// A commit scrolls to the channel and focuses its airing cell; it never tunes (OK then tunes).
// The whole lineup is indexed, so a hidden channel is found and answered with "Chaîne masquée".

@Stable
internal class NumberJumpState {
    var state by mutableStateOf<DigitState?>(null)
        private set
    var preview by mutableStateOf<DigitPreview?>(null)
        private set
    val open: Boolean get() = state != null
    val timeoutMs = JUMP_TIMEOUT_MS

    private var index: DigitIndex? = null
    private var indexOf: List<ChannelRow>? = null

    private fun index(repo: LiveTvRepository): DigitIndex {
        val ch = repo.channels.value
        if (index == null || indexOf !== ch) {
            index = digitIndex(repo.lineup())
            indexOf = ch
        }
        return index!!
    }

    private fun step(context: Context, repo: LiveTvRepository, ev: DigitEvent): PendingJump? {
        val s = digitReduce(index(repo), state, ev, timeoutMs)
        state = s.state
        preview = s.state?.let { s.preview }
        val r = s.result as? DigitResult.Commit ?: return null
        if (r.hidden) {
            Toast.makeText(context, com.wika.wicaby.core.R.string.livetv_channel_hidden_toast, Toast.LENGTH_SHORT).show()
            return null
        }
        return PendingJump(r.id, repo.now())
    }

    private fun at() = SystemClock.elapsedRealtime()

    fun digit(context: Context, repo: LiveTvRepository, d: String) = step(context, repo, DigitEvent.Digit(d, at()))
    fun enter(context: Context, repo: LiveTvRepository) = step(context, repo, DigitEvent.Enter(at()))
    fun tick(context: Context, repo: LiveTvRepository) = step(context, repo, DigitEvent.Tick(at()))

    // These never commit; the index exists once a digit opened the buffer.
    private fun local(ev: DigitEvent) {
        val ix = index ?: return
        val s = digitReduce(ix, state, ev, timeoutMs)
        state = s.state
        preview = s.state?.let { s.preview }
    }

    fun separator() = local(DigitEvent.Separator(at()))
    fun backspace() = local(DigitEvent.Backspace(at()))
    fun pick(delta: Int) = local(DigitEvent.Pick(delta, at()))
    fun cancel() = local(DigitEvent.Escape(at()))
}

/** The buffer, top right, `.title-1` mono (§11), with the channel it would reach. */
@Composable
internal fun NumberJumpOverlay(jump: NumberJumpState, byId: Map<String, ChannelRow>, modifier: Modifier) {
    val s = jump.state ?: return
    val target = when (val p = jump.preview) {
        is DigitPreview.Exact -> p.ids.getOrNull(p.pick)
        is DigitPreview.Prefix -> p.id
        is DigitPreview.Alias -> p.id
        else -> null
    }?.let { byId[it] }
    val label = stringResource(R.string.livetv_guide_jump_to, s.buf)
    Column(
        modifier
            .widthIn(min = 160.dp, max = 320.dp)
            .background(C.elevated.copy(alpha = 0.92f), RoundedCornerShape(Radius.lg)) // opaque, no blur on TV (§11)
            .padding(horizontal = 22.dp, vertical = 14.dp)
            .semantics { contentDescription = label },
        horizontalAlignment = Alignment.End,
    ) {
        Text(s.buf, style = Type.title1.copy(fontFamily = GeistMono), color = C.label, maxLines = 1)
        if (target != null) Text(target.name, style = Type.footnote, color = C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
