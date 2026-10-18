package com.wika.wicaby.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.GenericShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.ui.THEME_SYSTEM
import com.wika.wicaby.core.ui.Tokens
import com.wika.wicaby.core.ui.themeLabel

/** The phone's theme choices: every palette, then Automatic (light or graphite with the phone). */
val MobileThemes get() = Tokens.Themes.map { it.id } + THEME_SYSTEM

// Automatic's preview: graphite on the right of a diagonal.
private val RightHalf = GenericShape { size, _ ->
    moveTo(size.width * 0.62f, 0f)
    lineTo(size.width, 0f)
    lineTo(size.width, size.height)
    lineTo(size.width * 0.38f, size.height)
    close()
}

/**
 * One card per theme, each drawn with that theme's own tokens (canvas, card, accent tone), so the row is the
 * preview; a tap applies it to the whole app at once.
 */
@Composable
fun ThemePicker(selected: String, accentIndex: Int, onPick: (String) -> Unit) {
    // Opens with the selected card in view (one card of context before it), not scrolled to the start.
    val step = with(LocalDensity.current) { (104.dp + 12.dp).roundToPx() }
    val scroll = rememberScrollState(initial = (MobileThemes.indexOf(selected) - 1).coerceAtLeast(0) * step)
    val accent = LocalAccent.current
    Row(Modifier.horizontalScroll(scroll).padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        MobileThemes.forEach { id ->
            val on = id == selected
            Column(
                Modifier.width(104.dp).testTag("theme-$id")
                    .selectable(on, role = Role.RadioButton) { onPick(id) },
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // Selected: an accent ring with a gap around the preview and a check, readable on light and dark previews.
                Box(
                    Modifier.fillMaxWidth().height(78.dp)
                        .border(2.dp, if (on) accent else Color.Transparent, RoundedCornerShape(Radius.sm + 3.dp))
                        .padding(3.dp)
                        .clip(RoundedCornerShape(Radius.sm))
                        .border(1.dp, G.separator, RoundedCornerShape(Radius.sm)),
                ) {
                    if (id == THEME_SYSTEM) {
                        Shot(Tokens.Light, accentIndex)
                        Box(Modifier.fillMaxSize().clip(RightHalf)) { Shot(Tokens.Graphite, accentIndex) }
                    } else {
                        Shot(Tokens.byId(id), accentIndex)
                    }
                    if (on) {
                        Box(Modifier.align(Alignment.TopEnd).padding(5.dp).size(20.dp).clip(CircleShape).background(accent), contentAlignment = Alignment.Center) {
                            Icon(Ic.Check, null, tint = onAccent(accent), modifier = Modifier.size(13.dp))
                        }
                    }
                }
                Text(stringResource(themeLabel(id)), style = Type.footnote, color = if (on) G.label else G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

// A canvas with a card and the accent, in [p]'s colours.
@Composable
private fun Shot(p: Tokens.Palette, accentIndex: Int) {
    val accent = Color(p.accents.getOrElse(accentIndex) { p.accents[0] }.argb)
    Box(Modifier.fillMaxSize().background(Color(p.bg)).padding(9.dp)) {
        Box(Modifier.width(26.dp).height(36.dp).clip(RoundedCornerShape(Radius.xs)).background(Color(p.elevated2)))
        Column(Modifier.align(Alignment.TopEnd).width(44.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Box(Modifier.fillMaxWidth().height(5.dp).clip(CircleShape).background(Color(p.label)))
            Box(Modifier.width(30.dp).height(5.dp).clip(CircleShape).background(Color(p.label3)))
        }
        Box(Modifier.align(Alignment.BottomEnd).width(36.dp).height(9.dp).clip(CircleShape).background(accent))
    }
}
