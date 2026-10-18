package com.wika.wicaby.tv.ui.livetv

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import com.wika.wicaby.core.livetv.ClientGroup
import com.wika.wicaby.core.livetv.Daypart
import com.wika.wicaby.core.livetv.GuideClock
import com.wika.wicaby.core.livetv.LensRef
import com.wika.wicaby.core.livetv.LiveTvPrefs
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.PrefField
import com.wika.wicaby.core.livetv.SortMode
import com.wika.wicaby.livetvui.GuideState
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Ic
import com.wika.wicaby.tv.ui.LocalOverlay
import com.wika.wicaby.tv.ui.TvFocus
import com.wika.wicaby.tv.ui.TvPicker
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.tvFocus
import com.wika.wicaby.tv.ui.uiLocale
import java.util.Locale

// The guide header (spec §6.1, §6.4, §6.5): the lens, the day (a picker: one line on a 960 dp
// canvas), "Maintenant" and the dayparts, and search. Up from row 0 of the grid lands on the day.

private val DAYPARTS = listOf(
    Daypart.MORNING to R.string.livetv_guide_dayparts_morning,
    Daypart.AFTERNOON to R.string.livetv_guide_dayparts_afternoon,
    Daypart.EVENING to R.string.livetv_guide_dayparts_evening,
    Daypart.TONIGHT to R.string.livetv_guide_dayparts_tonight,
    Daypart.NIGHT to R.string.livetv_guide_dayparts_night,
)

@Composable
internal fun GuideHeader(
    st: GuideState,
    prefs: LiveTvPrefs,
    lenses: List<LensRef>,
    dayReq: FocusRequester,
    onLens: () -> Unit,
    onDay: (Long) -> Unit,
    onNow: () -> Unit,
    onDaypart: (Daypart) -> Unit,
    onSearch: () -> Unit,
) {
    val context = LocalContext.current
    val overlay = LocalOverlay.current
    val locale = uiLocale()
    // The day chip follows the view; derived, so a 30 min bucket crossing does not recompose the header.
    val shownDay by remember(st) { derivedStateOf { st.clock.dayStart(st.bucket.value * 30 * 60_000L + st.laneMs / 3) } }
    val dayTitle = stringResource(R.string.livetv_guide_day)
    Row(
        Modifier.padding(horizontal = GuideDims.side).fillMaxWidth().height(GuideDims.header),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (lenses.size > 1) Chip(lensLabel(context, prefs.lens, prefs.groups), onClick = onLens)
        Chip(dayLabel(st.clock, shownDay, st.now, locale), onClick = {
            val chips = st.clock.dayChips(st.now, st.rangeEnd)
            val labels = chips.map { dayLabel(st.clock, it.start, st.now, locale, context) }
            overlay.show(dayReq) {
                TvPicker(dayTitle, labels, chips.indexOfFirst { it.start == shownDay }, onSelect = { onDay(chips[it].start) }, onDismiss = overlay::close)
            }
        }, modifier = Modifier.focusRequester(dayReq))
        Chip(stringResource(R.string.livetv_guide_dayparts_now), onClick = onNow, selected = st.live.value)
        for ((part, label) in DAYPARTS) Chip(stringResource(label), onClick = { onDaypart(part) })
        Spacer(Modifier.weight(1f))
        Chip(null, icon = Ic.Search, onClick = onSearch, description = stringResource(R.string.livetv_actions_search))
    }
}

/** A compact header pill: white when focused, filled when selected, never the accent (§11). */
@Composable
private fun Chip(text: String?, onClick: () -> Unit, modifier: Modifier = Modifier, selected: Boolean = false, icon: ImageVector? = null, description: String? = null) {
    var focused by remember { mutableStateOf(false) }
    val fg = if (focused) TvFocus.fg else if (selected) C.label else C.label2
    Row(
        modifier
            .tvFocus(RoundedCornerShape(50), focusedScale = 1.06f, sheen = false, elevation = 8.dp, onFocusChange = { focused = it }, onClick = onClick)
            .background(if (focused) TvFocus.bg else if (selected) C.fill4 else C.fill2)
            .padding(horizontal = if (text == null) 10.dp else 14.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) Icon(icon, contentDescription = description, tint = fg, modifier = Modifier.size(18.dp))
        if (text != null) Text(text, style = Type.callout, color = fg, maxLines = 1)
    }
}

/** "Aujourd’hui", "Demain", else the short weekday and day in the UI language ("mar. 13"). */
@Composable
internal fun dayLabel(clock: GuideClock, t: Long, now: Long, locale: Locale = uiLocale()): String = dayLabel(clock, t, now, locale, LocalContext.current)

internal fun dayLabel(clock: GuideClock, t: Long, now: Long, locale: Locale, context: Context): String {
    val d = clock.dayStart(t)
    val today = clock.dayStart(now)
    return when (d) {
        today -> context.getString(R.string.livetv_guide_today)
        clock.addDays(today, 1) -> context.getString(R.string.livetv_guide_tomorrow)
        else -> android.text.format.DateFormat.format(android.text.format.DateFormat.getBestDateTimePattern(locale, "EEEd"), d).toString()
    }
}

/** The lens name: built-in lenses are strings; tags and groups are server or user data, never translated. */
internal fun lensLabel(context: Context, lens: LensRef, groups: List<ClientGroup>): String = when (lens) {
    LensRef.All -> context.getString(com.wika.wicaby.core.R.string.livetv_lens_all)
    LensRef.Favorites -> context.getString(com.wika.wicaby.core.R.string.livetv_lens_favorites)
    LensRef.Recents -> context.getString(com.wika.wicaby.core.R.string.livetv_lens_recents)
    LensRef.Radio -> context.getString(com.wika.wicaby.core.R.string.livetv_lens_radio)
    is LensRef.Tag -> lens.tag
    is LensRef.Group -> groups.firstOrNull { it.id == lens.id }?.name ?: lens.id
}

@Composable
internal fun LensPicker(repo: LiveTvRepository, prefs: LiveTvPrefs, lenses: List<LensRef>, onDismiss: () -> Unit) {
    val context = LocalContext.current
    TvPicker(
        stringResource(com.wika.wicaby.core.R.string.livetv_lens_label),
        lenses.map { lensLabel(context, it, prefs.groups) },
        lenses.indexOf(prefs.lens).coerceAtLeast(0),
        onSelect = { repo.prefs.update(PrefField.LENS, prefs.copy(lens = lenses[it])) },
        onDismiss = onDismiss,
    )
}

/** MENU in the grid: the sort, and "Favoris en premier" as the last, checkable line. */
@Composable
internal fun SortPicker(repo: LiveTvRepository, prefs: LiveTvPrefs, onDismiss: () -> Unit) {
    val modes = listOf(
        SortMode.NUMBER to com.wika.wicaby.core.R.string.livetv_sort_number,
        SortMode.NAME to com.wika.wicaby.core.R.string.livetv_sort_name,
        SortMode.RECENT to com.wika.wicaby.core.R.string.livetv_sort_recent,
        SortMode.SERVER to com.wika.wicaby.core.R.string.livetv_sort_server,
    )
    val favFirst = stringResource(com.wika.wicaby.core.R.string.livetv_sort_favorites_first) + if (prefs.favFirst) "  ✓" else ""
    TvPicker(
        stringResource(com.wika.wicaby.core.R.string.livetv_sort_label),
        modes.map { stringResource(it.second) } + favFirst,
        modes.indexOfFirst { it.first == prefs.sort },
        onSelect = { i ->
            if (i < modes.size) repo.prefs.update(PrefField.SORT, prefs.copy(sort = modes[i].first)) else repo.prefs.update(PrefField.FAV_FIRST, prefs.copy(favFirst = !prefs.favFirst))
        },
        onDismiss = onDismiss,
    )
}
