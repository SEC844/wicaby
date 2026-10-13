package com.wika.wicaby.tv.ui.livetv

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.livetv.ChannelRow
import com.wika.wicaby.core.livetv.FocusKind
import com.wika.wicaby.core.livetv.TimerLite
import com.wika.wicaby.livetvui.CellContext
import com.wika.wicaby.livetvui.GuideState
import com.wika.wicaby.livetvui.GuideStyle
import com.wika.wicaby.livetvui.Lane
import com.wika.wicaby.livetvui.Ruler
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.uiLocale

// One guide row (spec §6.2): the TV channel cell and the shared lane (:livetv-ui, GuideLane.kt), which
// draws the cells in one drawBehind. A D-pad move, a scroll or a 30 min bucket crossing recomposes
// nothing: it redraws the lanes (TV-2 §16.2 budget).

/** The TV theme's tokens for the shared grid (§11). */
internal val TvGuideStyle = GuideStyle(
    bg = C.bg, label = C.label, label2 = C.label2, label3 = C.label3, fill1 = C.fill1, fill2 = C.fill2, fill3 = C.fill3,
    separator = C.separator, red = C.red, title = Type.callout, caption = Type.caption, radius = Radius.xs,
)

@Composable
internal fun GuideRowView(
    api: Api,
    st: GuideState,
    row: ChannelRow,
    rowH: Dp,
    version: State<Long>,
    marks: Map<String, TimerLite>,
    reminders: Set<String>,
    ctx: CellContext,
) {
    Row(Modifier.height(rowH).fillMaxWidth().padding(vertical = 3.dp)) {
        ChannelCell(api, st, row, Modifier.width(GuideDims.channelCol - 6.dp).fillMaxHeight())
        Spacer(Modifier.width(6.dp))
        Lane(st, row, version, marks, reminders, ctx, Modifier.fillMaxSize())
    }
}

/** Number and logo (the name when there is none); focus is fill-4 (§11), drawn from derived state. */
@Composable
private fun ChannelCell(api: Api, st: GuideState, row: ChannelRow, modifier: Modifier) {
    val focused = remember(row.id) { derivedStateOf { st.focus?.let { it.kind == FocusKind.CHANNEL && it.channelId == row.id } == true } }
    val r = with(LocalDensity.current) { Radius.xs.toPx() }
    Row(
        modifier.drawBehind { drawRoundRect(if (focused.value) C.fill4 else C.fill1, cornerRadius = CornerRadius(r)) }.padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(row.number, style = Type.mono, color = C.label2, maxLines = 1, modifier = Modifier.width(44.dp))
        if (row.logoTag != null) {
            ChannelLogo(api, row, 34.dp)
        } else {
            Text(row.name, style = Type.footnote, color = C.label, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
        if (row.favorite) Text("★", style = Type.caption, color = C.label2)
    }
}

/** The ruler with the TV day label in its corner. */
@Composable
internal fun GuideRuler(st: GuideState, modifier: Modifier) {
    val context = LocalContext.current
    val locale = uiLocale()
    val day = remember(st, locale, context) { { t: Long -> dayLabel(st.clock, t, st.now, locale, context) } }
    Ruler(st, TvGuideStyle, GuideDims.channelCol, day, modifier)
}
