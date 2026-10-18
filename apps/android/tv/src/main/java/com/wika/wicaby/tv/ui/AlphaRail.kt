package com.wika.wicaby.tv.ui

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.mutableStateOf
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.BoxWithConstraints
import android.provider.Settings
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import com.wika.wicaby.core.data.LetterIndex

// The system's "remove animations" (animator duration scale 0): the rail then jumps instead of springing.
@Composable
fun reducedMotion(): Boolean {
    val context = LocalContext.current
    return remember { runCatching { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }.getOrDefault(false) }
}

// The A–Z jump rail beside a library grid sorted by name: '#' and A–Z, letters without items dimmed and skipped.
// The grid sends LEFT from its first column to [reqs] of the current title's letter (railLetter); UP/DOWN move between letters and [onBrowse] scrolls the
// grid there; OK or RIGHT [onPick] that letter (the grid then focuses its first item); BACK [onLeave]s. Its other
// sides are dead ends (no side navigation on TV: the tabs are above).
@Composable
fun AlphaRail(offsets: IntArray, rail: RailFocus, onBrowse: (Int) -> Unit, onPick: (Int) -> Unit, onLeave: () -> Unit, modifier: Modifier = Modifier) {
    val reqs = rail.reqs
    var focused by remember { mutableIntStateOf(-1) }
    val still = reducedMotion()
    val accent = LocalAccent.current
    // Added when the rail takes focus, so it is the newest and wins over the screen's (previous tab, quit).
    if (focused >= 0) BackHandler { onLeave() }
    // Letters as tall as the screen allows (15 dp at most): all 27 fit whatever the TV's height.
    BoxWithConstraints(modifier.fillMaxHeight(), contentAlignment = Alignment.CenterStart) {
        val letterH = minOf(15.dp, (maxHeight - 24.dp) / LetterIndex.LETTERS.length)
        val top = (maxHeight - letterH * LetterIndex.LETTERS.length) / 2
        Column(
            Modifier
                .width(28.dp)
                .focusProperties {
                    // D-pad moves out are dead ends, RIGHT picks the letter; the grid taking focus back (OK, BACK) goes through.
                    onExit = {
                        val d = requestedFocusDirection
                        if (d == FocusDirection.Left || d == FocusDirection.Right || d == FocusDirection.Up || d == FocusDirection.Down) cancelFocusChange()
                        // Leaving for the grid: disarmed, the rail is only reached by LEFT from it (RailFocus.enter).
                        else rail.armed = false
                        if (d == FocusDirection.Right && focused >= 0) onPick(focused)
                    }
                }
                .focusGroup()

                .semantics { contentDescription = "A–Z" },
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            LetterIndex.LETTERS.forEachIndexed { i, ch ->
                val has = offsets[i] >= 0
                val on = focused == i
                val grow by animateFloatAsState(if (on) 1.25f else 1f, if (still) snap() else spring(dampingRatio = 0.9f, stiffness = 500f), label = "rail-letter")
                Box(
                    Modifier
                        .size(28.dp, letterH)
                        .focusRequester(reqs[i])
                        .focusProperties { canFocus = has && rail.armed }
                        .onFocusChanged {
                            if (it.isFocused) {
                                focused = i
                                onBrowse(i)
                            } else if (focused == i) focused = -1
                        }
                        .onKeyEvent { e ->
                            val ok = e.key == Key.DirectionCenter || e.key == Key.Enter || e.key == Key.NumPadEnter
                            if (ok && e.type == KeyEventType.KeyUp) onPick(i)
                            ok
                        }
                        .focusable(),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        ch.toString(),
                        // Small caps: capitals at caption size, a touch of tracking.
                        style = Type.eyebrow.copy(fontSize = 10.sp, letterSpacing = 0.04.sp),
                        color = when {
                            on -> accent
                            has -> C.label2
                            else -> C.label3.copy(alpha = 0.18f)
                        },
                        modifier = Modifier.scale(grow),
                    )
                }
            }
        }
        // The big letter beside the rail, level with the focused one.
        AnimatedVisibility(focused >= 0, enter = if (still) fadeIn(snap()) else fadeIn(), exit = if (still) fadeOut(snap()) else fadeOut(), modifier = Modifier.align(Alignment.TopStart).offset(x = 40.dp, y = top + letterH * focused.coerceAtLeast(0) - 24.dp)) {
            Box(Modifier.size(64.dp).background(C.elevated2.copy(alpha = 0.95f), RoundedCornerShape(Radius.lg)), contentAlignment = Alignment.Center) {
                Text(LetterIndex.LETTERS.getOrElse(focused.coerceAtLeast(0)) { '#' }.toString(), style = Type.largeTitle, color = accent)
            }
        }
    }
}

// The letter LEFT from the grid lands on: [i] when it has titles, else the nearest one that has.
fun railLetter(offsets: IntArray, i: Int): Int =
    if (offsets.getOrElse(i) { -1 } >= 0) i else LetterIndex.next(offsets, i, 1).takeIf { offsets[it] >= 0 } ?: LetterIndex.next(offsets, i, -1)

// The rail's letters, reachable only when the grid sends LEFT from its first column ([enter]): DOWN from the tab bar
// or UP from the grid never land in it.
class RailFocus {
    val reqs = List(LetterIndex.LETTERS.length) { FocusRequester() }
    var armed by mutableStateOf(false)

    fun enter(i: Int) {
        armed = true
        if (!runCatching { reqs[i].requestFocus() }.getOrDefault(false)) armed = false
    }
}
