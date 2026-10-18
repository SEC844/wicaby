package com.wika.wicaby.tv.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.ui.Tokens
import com.wika.wicaby.core.ui.themeLabel
import com.wika.wicaby.tv.data.TvSettings

/** The themes the TV offers, in the settings order (light is desktop and mobile only). */
val TvThemes get() = Tokens.Themes.filter { it.tv }

/**
 * A small picture of the app in [palette]: its canvas, cards, the accent in that theme's tone and the theme's
 * name in its own label colour. It is drawn with the theme's tokens, whatever theme the TV is in.
 */
@Composable
internal fun ThemeCard(palette: Tokens.Palette, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, onFocus: () -> Unit = {}, width: Int = 176) {
    val accentIndex = Accents.indexOf(LocalAccent.current).coerceAtLeast(0)
    val accent = Color(palette.accents.getOrElse(accentIndex) { palette.accents[0] }.argb)
    Column(
        modifier
            .width(width.dp)
            .testTag("theme-${palette.id}")
            .tvFocus(RoundedCornerShape(Radius.lg), focusedScale = 1.06f, onFocusChange = { if (it) onFocus() }, onClick = onClick)
            .background(Color(palette.bg))
            // Always outlined: the OLED card is as black as an OLED canvas.
            .border(2.dp, if (selected) accent else C.fill4, RoundedCornerShape(Radius.lg))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // The check sits on the preview, so the label keeps the full width (Contraste élevé).
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
            repeat(3) { Box(Modifier.size(28.dp, 36.dp).clip(RoundedCornerShape(Radius.xs)).background(Color(palette.elevated2))) }
            Spacer(Modifier.weight(1f))
            if (selected) Icon(Ic.Check, null, tint = accent, modifier = Modifier.size(18.dp))
        }
        Box(Modifier.size(48.dp, 7.dp).clip(CircleShape).background(accent))
        Text(stringResource(themeLabel(palette.id)), style = Type.headline, color = Color(palette.label), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * Every TV theme as a card, scrolling sideways with the focus. Entering the row lands on the selected card
 * (focusRestorer), and the focused card's 1.06 lift stays clear of the row's clip edges (inset and EdgeSpec).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun ThemeCardRow(current: String, onPick: (String) -> Unit, modifier: Modifier = Modifier, onFocus: (String) -> Unit = {}, cardModifier: (String) -> Modifier = { Modifier }) {
    val selected = remember { FocusRequester() }
    val margin = with(LocalDensity.current) { 24.dp.toPx() }
    CompositionLocalProvider(LocalBringIntoViewSpec provides remember(margin) { EdgeSpec(margin) }) {
        // fillMaxWidth: a scrolling row measured without a bound would widen the column around it.
        Row(
            modifier.fillMaxWidth().focusRestorer(selected).horizontalScroll(rememberScrollState()).padding(vertical = 12.dp, horizontal = 24.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            TvThemes.forEach { p ->
                val own = cardModifier(p.id)
                ThemeCard(p, selected = current == p.id, onClick = { onPick(p.id) }, onFocus = { onFocus(p.id) }, modifier = if (current == p.id) own.focusRequester(selected) else own)
            }
        }
    }
}

/**
 * Shown once on Home while the TV is on the default theme: OLED (black pixels off) or Cinéma (warm, for the evening)
 * suit a living room. Any button, or a theme picked in Réglages or the setup, hides it for good.
 */
@Composable
internal fun ThemeHint(modifier: Modifier = Modifier) {
    val focus = LocalFocusManager.current
    // The hint leaves the list in the same frame: hand focus to the row below first, or it falls back to the tab bar.
    fun done(id: String?) {
        focus.moveFocus(FocusDirection.Down)
        if (id != null) TvSettings.theme.value = id
        TvSettings.themeHintShown.value = true
    }
    Row(
        // Opaque: a translucent fill over the backdrop left the body text with weak separation.
        modifier.padding(horizontal = 48.dp, vertical = 8.dp).clip(RoundedCornerShape(Radius.lg)).background(C.elevated2).padding(horizontal = 24.dp, vertical = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(CoreR.string.theme_hint_title), style = Type.headline, color = C.label)
            Text(stringResource(CoreR.string.theme_hint_body), style = Type.callout, color = C.label2)
        }
        Pill(stringResource(CoreR.string.theme_oled), onClick = { done("oled") }, modifier = Modifier.testTag("hint-oled"))
        Pill(stringResource(CoreR.string.theme_cinema), onClick = { done("cinema") }, modifier = Modifier.testTag("hint-cinema"))
        Pill(stringResource(CoreR.string.theme_hint_keep), onClick = { done(null) }, modifier = Modifier.testTag("hint-keep"))
    }
}
