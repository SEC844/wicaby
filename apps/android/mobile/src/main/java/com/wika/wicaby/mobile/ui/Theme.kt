package com.wika.wicaby.mobile.ui

import android.os.Build
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.ui.THEME_SYSTEM
import com.wika.wicaby.core.ui.Tokens
import com.wika.wicaby.mobile.R

// "Graphite" (docs/design.md): a facade over the generated tokens (packages/tokens/tokens.json), like the TV's C.
object G {
    // The theme id (Prefs.theme, same ids as the desktop's ui.theme). Snapshot state, so every screen reading
    // G.bg recomposes when it changes. 'system' follows the phone between light and graphite ([systemDark]).
    var theme by mutableStateOf(Tokens.Graphite.id)
    var systemDark by mutableStateOf(true)
    // The player and the reader stay dark in the light theme, like the desktop's media surfaces: counted up in
    // their onStart and down in onStop ([MediaHold]), so a reader opened over a PiP player stays dark when the player stops.
    // shortcut: process-wide, so the screen behind a picture-in-picture player is dark too; a per-window palette
    // (CompositionLocal) would fix it.
    var mediaStarted by mutableIntStateOf(0)
    val media get() = mediaStarted > 0

    /** One activity's share of [mediaStarted]: on in onStart, off in onStop, or already in onPause when it is
     *  finishing (the screen behind resumes before this one stops, and would draw one dark frame). */
    class MediaHold {
        private var on = false
        fun start() {
            if (!on) mediaStarted++
            on = true
        }
        fun stop() {
            if (on) mediaStarted--
            on = false
        }
    }
    val palette: Tokens.Palette get() {
        val p = if (theme == THEME_SYSTEM) (if (systemDark) Tokens.Graphite else Tokens.Light) else Tokens.byId(theme)
        return if (media && p.light) Tokens.Graphite else p
    }
    private val p get() = palette
    val bg get() = Color(p.bg)
    val elevated get() = Color(p.elevated)
    val elevated2 get() = Color(p.elevated2)
    val raised get() = Color(p.raised)
    val label get() = Color(p.label)
    val label2 get() = Color(p.label2)
    val label3 get() = Color(p.label3)
    val fill1 get() = Color(p.fill1)
    val fill2 get() = Color(p.fill2)
    val fill3 get() = Color(p.fill3)
    val fill4 get() = Color(p.fill4)
    val separator get() = Color(p.separator)
    // A switch's off track (3:1 on the light canvas, tokens.json control) and its knob: white on light, as on iOS.
    val control get() = Color(p.control)
    val controlKnob get() = if (p.light) Color.White else label2
    val red get() = Color(p.system.red)
}

// Same order and values as html[data-accent] and the TV app, in the current theme's tones; the index is what
// Prefs stores. [ACCENT_SYSTEM] comes after them.
// Built once per palette: both are read during composition.
private val accentColors = Tokens.Themes.associateWith { p -> p.accents.map { Color(it.argb) } }
// The theme's tones first, then the Graphite ones (reversed: associate keeps the last of equal keys).
private val onAccents = Tokens.Themes.associateWith { p -> (p.accents + Tokens.Accents).asReversed().associate { Color(it.argb) to Color(it.onArgb) } }
val Accents get() = accentColors.getValue(G.palette)

// The wallpaper's colour (Material You, Android 12+): the accent only, the canvas stays the theme's.
const val ACCENT_SYSTEM = 8
val systemAccentSupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

// The dynamic accent in use and the text on it, for onAccent (set by accentOf).
private var dynamicAccent: Pair<Color, Color>? = null

/** The accent for a stored index: a palette tone, or the wallpaper's on Android 12+ when it stands out from the canvas. */
@Composable
fun accentOf(index: Int): Color {
    if (index == ACCENT_SYSTEM && systemAccentSupported) {
        val context = LocalContext.current
        val light = G.palette.light
        val s = remember(context, light) { if (light) dynamicLightColorScheme(context) else dynamicDarkColorScheme(context) }
        // A wallpaper tone too close to the canvas would hide buttons and progress: blue instead.
        if (contrast(s.primary, G.bg) >= 3f) return s.primary.also { dynamicAccent = it to s.onPrimary }
    }
    return Accents.getOrElse(index) { Accents[0] }
}

/** WCAG contrast ratio of two opaque colours. */
fun contrast(a: Color, b: Color): Float {
    val (hi, lo) = listOf(a.luminance(), b.luminance()).sortedDescending()
    return (hi + 0.05f) / (lo + 0.05f)
}

// Spoken names for the swatches, same order as [Accents].
val AccentNames = listOf(
    R.string.accent_blue, R.string.accent_indigo, R.string.accent_purple, R.string.accent_pink,
    R.string.accent_red, R.string.accent_orange, R.string.accent_green, R.string.accent_graphite,
)

fun onAccent(c: Color) = dynamicAccent?.takeIf { it.first == c }?.second
    ?: onAccents.getValue(G.palette)[c] ?: Color.White

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

// Material 3 underneath (sheets, switches, the navigation suite), retinted to the theme's tokens: no tonal
// surfaces (the wallpaper only ever gives the accent), selection as a neutral fill rather than an accent pill.
// Built from the light or dark baseline, so the roles not set here (the fixed roles) match the theme's scheme.
fun graphiteScheme(accent: Color) = (if (G.palette.light) lightColorScheme() else darkColorScheme()).copy(
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
    errorContainer = G.elevated2,
    onErrorContainer = G.red,
    // Outlined fields and unchecked controls: 3:1 on the light canvas.
    outline = if (G.palette.light) G.control else G.label3,
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
