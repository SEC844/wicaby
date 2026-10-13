package com.wika.wicaby.mobile.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.mobile.R

// "Graphite" (docs/design.md), mirrored from apps/desktop/src/renderer/app.css like the TV app.
object G {
    // OB-X, html[data-theme='oled'] as on the TV: pure black canvas, surfaces nudged down to keep their contrast.
    // Snapshot state, so every screen reading G.bg recomposes when the setting flips.
    var oled by mutableStateOf(false)
    val bg get() = if (oled) Color.Black else Color(0xFF0B0B0D)
    val elevated get() = if (oled) Color(0xFF0E0E10) else Color(0xFF151517)
    val elevated2 get() = if (oled) Color(0xFF161618) else Color(0xFF1C1C1F)
    val raised = Color(0xFF2A2A2D)
    val label = Color(0xFFF5F5F7)
    val label2 = Color(0x9EEBEBF5)
    val label3 = Color(0x57EBEBF5)
    val fill1 = Color(0x0AFFFFFF)
    val fill2 = Color(0x12FFFFFF)
    val fill3 = Color(0x1CFFFFFF)
    val fill4 = Color(0x29FFFFFF)
    val separator = Color(0x14FFFFFF)
    val red = Color(0xFFFF453A)
}

// Same order and values as html[data-accent] and the TV app; the index is what Prefs stores.
val Accents = listOf(
    Color(0xFF0A84FF), // blue
    Color(0xFF5E5CE6), // indigo
    Color(0xFFBF5AF2), // purple
    Color(0xFFFF375F), // pink
    Color(0xFFFF453A), // red
    Color(0xFFFF9F0A), // orange
    Color(0xFF30D158), // green
    Color(0xFFD1D1D6), // graphite
)

// Spoken names for the swatches, same order as [Accents].
val AccentNames = listOf(
    R.string.accent_blue, R.string.accent_indigo, R.string.accent_purple, R.string.accent_pink,
    R.string.accent_red, R.string.accent_orange, R.string.accent_green, R.string.accent_graphite,
)

fun onAccent(c: Color) = if (c == Accents[5] || c == Accents[6] || c == Accents[7]) Color.Black else Color.White

val LocalAccent = staticCompositionLocalOf { Accents[0] }

object Radius {
    val xs = 6.dp
    val sm = 10.dp
    val md = 14.dp
    val lg = 20.dp
    val xl = 28.dp
}

val Geist = FontFamily(
    Font(CoreR.font.geist_regular, FontWeight.Normal),
    Font(CoreR.font.geist_medium, FontWeight.Medium),
    Font(CoreR.font.geist_semibold, FontWeight.SemiBold),
    Font(CoreR.font.geist_bold, FontWeight.Bold),
)
val GeistMono = FontFamily(Font(CoreR.font.geist_mono_regular, FontWeight.Normal), Font(CoreR.font.geist_mono_medium, FontWeight.Medium))

// The desktop scale, nudged up a step for arm's-length reading.
object Type {
    val hero = TextStyle(fontFamily = Geist, fontWeight = FontWeight.Bold, fontSize = 34.sp, lineHeight = 38.sp, letterSpacing = (-0.03).em)
    val largeTitle = TextStyle(fontFamily = Geist, fontWeight = FontWeight.Bold, fontSize = 32.sp, lineHeight = 38.sp, letterSpacing = (-0.02).em)
    val title1 = TextStyle(fontFamily = Geist, fontWeight = FontWeight.Bold, fontSize = 26.sp, lineHeight = 31.sp, letterSpacing = (-0.02).em)
    val title2 = TextStyle(fontFamily = Geist, fontWeight = FontWeight.SemiBold, fontSize = 21.sp, lineHeight = 26.sp, letterSpacing = (-0.01).em)
    val title3 = TextStyle(fontFamily = Geist, fontWeight = FontWeight.SemiBold, fontSize = 19.sp, lineHeight = 24.sp, letterSpacing = (-0.01).em)
    val headline = TextStyle(fontFamily = Geist, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 21.sp)
    val body = TextStyle(fontFamily = Geist, fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 22.sp)
    val callout = TextStyle(fontFamily = Geist, fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 19.sp)
    val footnote = TextStyle(fontFamily = Geist, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 17.sp)
    val caption = TextStyle(fontFamily = Geist, fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 15.sp, letterSpacing = 0.01.em)
    val eyebrow = TextStyle(fontFamily = Geist, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, lineHeight = 15.sp, letterSpacing = 0.08.em)
    val mono = TextStyle(fontFamily = GeistMono, fontWeight = FontWeight.Medium, fontSize = 13.sp, lineHeight = 17.sp)
}

// Material 3 underneath (sheets, switches, the navigation suite), retinted to Graphite:
// no dynamic colour, no tonal surfaces, selection as a neutral fill rather than an accent pill.
fun graphiteScheme(accent: Color) = darkColorScheme(
    primary = accent,
    onPrimary = onAccent(accent),
    primaryContainer = accent,
    onPrimaryContainer = onAccent(accent),
    inversePrimary = accent,
    secondary = G.label2,
    onSecondary = G.bg,
    secondaryContainer = G.fill3,
    onSecondaryContainer = G.label,
    tertiary = accent,
    onTertiary = onAccent(accent),
    tertiaryContainer = G.fill3,
    onTertiaryContainer = G.label,
    background = G.bg,
    onBackground = G.label,
    surface = G.bg,
    onSurface = G.label,
    surfaceVariant = G.elevated2,
    onSurfaceVariant = G.label2,
    surfaceTint = Color.Transparent,
    inverseSurface = G.label,
    inverseOnSurface = G.bg,
    error = G.red,
    onError = Color.White,
    outline = G.label3,
    outlineVariant = G.separator,
    scrim = Color.Black,
    surfaceBright = G.raised,
    surfaceDim = G.bg,
    surfaceContainerLowest = G.bg,
    surfaceContainerLow = G.elevated,
    surfaceContainer = G.elevated,
    surfaceContainerHigh = G.elevated2,
    surfaceContainerHighest = G.raised,
)

private val typography = Typography(
    displayLarge = Type.hero,
    displayMedium = Type.hero,
    displaySmall = Type.largeTitle,
    headlineLarge = Type.largeTitle,
    headlineMedium = Type.title1,
    headlineSmall = Type.title2,
    titleLarge = Type.title3,
    titleMedium = Type.headline,
    titleSmall = Type.callout.copy(fontWeight = FontWeight.SemiBold),
    bodyLarge = Type.body,
    bodyMedium = Type.callout.copy(fontWeight = FontWeight.Normal),
    bodySmall = Type.footnote,
    labelLarge = Type.callout,
    labelMedium = Type.caption.copy(fontWeight = FontWeight.Medium),
    labelSmall = Type.caption,
)

@Composable
fun WicabyTheme(accent: Color, content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = graphiteScheme(accent), typography = typography) {
        CompositionLocalProvider(LocalAccent provides accent, content = content)
    }
}
