package com.wika.wicaby.core.ui

import com.wika.wicaby.core.R

/** Theme ids the settings offer besides the palettes: 'system' follows the OS between light and graphite (mobile only). */
const val THEME_SYSTEM = "system"

/** The settings label of a theme id ([Tokens.Themes] or [THEME_SYSTEM]). */
fun themeLabel(id: String): Int = when (id) {
    "oled" -> R.string.theme_oled
    "slate" -> R.string.theme_slate
    "cinema" -> R.string.theme_cinema
    "contrast" -> R.string.theme_contrast
    "light" -> R.string.theme_light
    THEME_SYSTEM -> R.string.theme_system
    else -> R.string.theme_graphite
}
