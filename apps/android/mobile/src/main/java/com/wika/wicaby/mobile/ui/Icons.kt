package com.wika.wicaby.mobile.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

// Lucide glyphs (ISC) at stroke 1.5, as docs/design.md asks; a few transport glyphs are filled.
// Inlined path data: cheaper than an icon library, and every icon stays static and monochrome.
object Ic {
    val Home = stroke("M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8", "M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z")
    val Library = stroke("m16 6 4 14", "M12 6v14", "M8 8v12", "M4 4v16")
    val Search = stroke(circle(11f, 11f, 8f), "m21 21-4.3-4.3")
    val Download = stroke("M12 15V3", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5")
    val Settings = stroke(
        "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
        circle(12f, 12f, 3f),
    )
    val Back = stroke("m15 18-6-6 6-6")
    val ChevronRight = stroke("m9 18 6-6-6-6")
    val ChevronDown = stroke("m6 9 6 6 6-6")
    val Close = stroke("M18 6 6 18", "m6 6 12 12")
    val Check = stroke("M20 6 9 17l-5-5")
    val Heart = stroke("M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z")
    val HeartFilled = fill("M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z")
    val CircleCheck = stroke(circle(12f, 12f, 10f), "m9 12 2 2 4-4")
    val Restart = stroke("M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5")
    val History = stroke("M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5", "M12 7v5l4 2")
    val List = stroke("M3 12h.01", "M3 18h.01", "M3 6h.01", "M8 12h13", "M8 18h13", "M8 6h13")
    val Server = stroke(rect(2f, 2f, 20f, 8f, 2f), rect(2f, 14f, 20f, 8f, 2f), "M6 6h.01", "M6 18h.01")
    val Refresh = stroke("M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5")
    val Sort = stroke("m21 16-4 4-4-4", "M17 20V4", "m3 8 4-4 4 4", "M7 4v16")
    val Trash = stroke("M3 6h18", "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2")
    val User = stroke("M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2", circle(12f, 7f, 4f))
    val Users = stroke("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", circle(9f, 7f, 4f), "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75")
    val Eye = stroke("M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0", circle(12f, 12f, 3f))
    val EyeOff = stroke(
        "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49", "M14.084 14.158a3 3 0 0 1-4.242-4.242",
        "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143", "m2 2 20 20",
    )
    val Lock = stroke(rect(3f, 11f, 18f, 11f, 2f), "M7 11V7a5 5 0 0 1 10 0v4")
    val Plus = stroke("M5 12h14", "M12 5v14")
    val LogOut = stroke("m16 17 5-5-5-5", "M21 12H9", "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4")
    val WifiOff = stroke("M12 20h.01", "M8.5 16.429a5 5 0 0 1 7 0", "M5 12.859a10 10 0 0 1 5.17-2.69", "M19 12.859a10 10 0 0 0-2.007-1.523", "M2 8.82a15 15 0 0 1 4.177-2.643", "M22 8.82a15 15 0 0 0-11.288-3.764", "m2 2 20 20")

    // Player.
    val Play = fill("M6 4.83v14.34a1.2 1.2 0 0 0 1.83 1.02l11.47-7.17a1.2 1.2 0 0 0 0-2.04L7.83 3.81A1.2 1.2 0 0 0 6 4.83z")
    val Pause = fill(rect(6f, 4f, 4f, 16f, 1f), rect(14f, 4f, 4f, 16f, 1f))
    val Next = fill("M5 5.2v13.6a1 1 0 0 0 1.55.83l9.6-6.8a1 1 0 0 0 0-1.66l-9.6-6.8A1 1 0 0 0 5 5.2z", rect(17f, 4.5f, 2.2f, 15f, 1.1f))
    val Back10 = stroke("M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5")
    val Fwd10 = stroke("M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5")
    val Captions = stroke(rect(3f, 5f, 18f, 14f, 2f), "M7 15h4M15 15h2M7 11h2M13 11h4")
    val Gauge = stroke("m12 14 4-4", "M3.34 19a10 10 0 1 1 17.32 0")
    val Pip = stroke("M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4", rect(12f, 13f, 10f, 7f, 2f))
    val Rewind = stroke("m11 17-5-5 5-5", "m18 17-5-5 5-5")
    val Forward = stroke("m6 17 5-5-5-5", "m13 17 5-5-5-5")
    val Sun = stroke(circle(12f, 12f, 4f), "M12 2v2", "M12 20v2", "m4.93 4.93 1.41 1.41", "m17.66 17.66 1.41 1.41", "M2 12h2", "M20 12h2", "m6.34 17.66-1.41 1.41", "m19.07 4.93-1.41 1.41")
    val Volume = stroke(
        "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z",
        "M16 9a5 5 0 0 1 0 6", "M19.364 18.364a9 9 0 0 0 0-12.728",
    )
    val Stop = fill(rect(6f, 6f, 12f, 12f, 1.5f))
    val Cast = stroke("M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6", "M2 12a9 9 0 0 1 8 8", "M2 16a5 5 0 0 1 4 4", "M2 20h.01")
    val Scan = stroke("M3 7V5a2 2 0 0 1 2-2h2", "M17 3h2a2 2 0 0 1 2 2v2", "M21 17v2a2 2 0 0 1-2 2h-2", "M7 21H5a2 2 0 0 1-2-2v-2")
    val Mic = stroke("M12 19v3", "M19 10v2a7 7 0 0 1-14 0v-2", rect(9f, 2f, 6f, 13f, 3f))
    val External = stroke("M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6")
    val Film = stroke(rect(3f, 3f, 18f, 18f, 2f), "M7 3v18", "M3 7.5h4", "M3 12h18", "M3 16.5h4", "M17 3v18", "M17 7.5h4", "M17 16.5h4")
    // Photos (photos spec §4.5): info, presentation (slideshow), images.
    val Info = stroke(circle(12f, 12f, 10f), "M12 16v-4", "M12 8h.01")
    val Slideshow = stroke("M2 3h20", "M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3", "m7 21 5-5 5 5")

    // Music (music spec MU-08).
    val Shuffle = stroke("m18 14 4 4-4 4", "m18 2 4 4-4 4", "M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22", "M2 6h1.972a4 4 0 0 1 3.6 2.2", "M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45")
    val Repeat = stroke("m17 2 4 4-4 4", "M3 11v-1a4 4 0 0 1 4-4h14", "m7 22-4-4 4-4", "M21 13v1a4 4 0 0 1-4 4H3")
    val RepeatOne = stroke("m17 2 4 4-4 4", "M3 11v-1a4 4 0 0 1 4-4h14", "m7 22-4-4 4-4", "M21 13v1a4 4 0 0 1-4 4H3", "M11 10h1v4")
    val Previous = fill("M19 5.2v13.6a1 1 0 0 1-1.55.83l-9.6-6.8a1 1 0 0 1 0-1.66l9.6-6.8A1 1 0 0 1 19 5.2z", rect(4.8f, 4.5f, 2.2f, 15f, 1.1f))
    val Queue = stroke("M21 15V6", "M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z", "M12 12H3", "M16 6H3", "M12 18H3")
    val Lyrics = stroke("m11 7.601-5.994 8.19a1 1 0 0 0 .1 1.298l.817.818a1 1 0 0 0 1.314.087L15.09 12", "M16.5 21.174C15.5 20.5 14.372 20 13 20c-2.058 0-3.928 2.356-6 2-2.072-.356-2.775-3.369-1.5-4.5", circle(16f, 7f, 5f))
    val Grip = stroke(circle(9f, 12f, 1f), circle(9f, 5f, 1f), circle(9f, 19f, 1f), circle(15f, 12f, 1f), circle(15f, 5f, 1f), circle(15f, 19f, 1f))
    val More = stroke(circle(12f, 12f, 1f), circle(12f, 5f, 1f), circle(12f, 19f, 1f))
    val Music = stroke("M9 18V5l12-2v13", circle(6f, 18f, 3f), circle(18f, 16f, 3f))
    val Mix = stroke("M4.9 19.1C1 15.2 1 8.8 4.9 4.9", "M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5", circle(12f, 12f, 2f), "M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5", "M19.1 4.9C23 8.8 23 15.1 19.1 19")

    private fun circle(cx: Float, cy: Float, r: Float) = "M${cx - r} ${cy}a$r $r 0 1 0 ${2 * r} 0a$r $r 0 1 0 ${-2 * r} 0"

    private fun rect(x: Float, y: Float, w: Float, h: Float, r: Float) =
        "M${x + r} ${y}h${w - 2 * r}a$r $r 0 0 1 $r ${r}v${h - 2 * r}a$r $r 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a$r $r 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a$r $r 0 0 1 $r ${-r}z"

    private fun build(paths: Array<out String>, filled: Boolean) =
        ImageVector.Builder(defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f).apply {
            for (d in paths) {
                addPath(
                    addPathNodes(d),
                    fill = if (filled) SolidColor(Color.White) else null,
                    stroke = if (filled) null else SolidColor(Color.White),
                    strokeLineWidth = 1.5f,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()

    private fun stroke(vararg paths: String) = build(paths, false)

    private fun fill(vararg paths: String) = build(paths, true)
}
