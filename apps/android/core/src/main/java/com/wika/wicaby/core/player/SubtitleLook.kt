package com.wika.wicaby.core.player

import io.github.peerless2012.ass.media.AssHandler

// Text subtitle look: the desktop's playback.subtitleStyle (mpv-player.ts subtitleProps) as values
// Media3's SubtitleView and libass take. Settings store indexes into these lists; a stale index clamps.
object SubtitleLook {
    // Percent of the default size: desktop 75 / 100 / 125 / 150.
    val SIZES = listOf(0.75f, 1f, 1.25f, 1.5f)
    // Geist (the desktop default, bundled in :core res/font), then the system sans and serif families.
    val FONTS = listOf("geist", "sans-serif", "serif")
    // ARGB: white, yellow, light grey (desktop SUB_COLORS).
    val COLORS = listOf(0xFFFFFFFF.toInt(), 0xFFFFE14D.toInt(), 0xFFD1D1D6.toInt())
    // mpv sub-pos: bottom, slightly raised, raised (desktop SUB_POSITIONS).
    val POSITIONS = listOf(100, 95, 88)
    // Media3 SubtitleView.DEFAULT_BOTTOM_PADDING_FRACTION (media3-ui is not on :core's classpath).
    const val BOTTOM_PADDING = 0.08f

    fun size(i: Int) = SIZES[i.coerceIn(SIZES.indices)]
    fun font(i: Int) = FONTS[i.coerceIn(FONTS.indices)]
    fun color(i: Int) = COLORS[i.coerceIn(COLORS.indices)]

    // mpv raises the text by (100 - sub-pos) % of the picture height.
    fun bottomPadding(i: Int) = BOTTOM_PADDING + (100 - POSITIONS[i.coerceIn(POSITIONS.indices)]) / 100f

    // libass only exposes a font scale. Override off: 1, ASS stays as authored (mpv sub-ass-override=scale).
    fun assFontScale(sizeIndex: Int, overrideAss: Boolean) = if (overrideAss) size(sizeIndex) else 1f
}

// Applies a libass font scale now and to a render created later (AssHandler makes one lazily; in
// OVERLAY_OPEN_GL mode nothing else uses renderCallback).
fun AssHandler.setFontScale(scale: Float) {
    renderCallback = { it?.setFontScale(scale) }
    render?.takeUnless { it.released }?.setFontScale(scale)
}
