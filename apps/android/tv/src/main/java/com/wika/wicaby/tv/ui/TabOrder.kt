package com.wika.wicaby.tv.ui

import com.wika.wicaby.core.data.HomeRows

// Réglages > Interface > Barre d'onglets (#6): the user's tab order and hidden tabs, stored per server/user in the
// home rows' shape (TvSettings.tabBar). Accueil stays first and the icon tabs (Recherche, Réglages) last; a tab the
// saved order does not know yet (a new library) keeps its default place, as in HomeRows.arrange.
object TabOrder {
    const val HOME = "home"
    private val PINNED = setOf(HOME, "search", "settings")

    // The tabs the user can move or hide, in their default order.
    fun movable(keys: List<String>): List<String> = keys.filter { it !in PINNED }

    // The tab bar: [keys] (default order) rearranged by [pref], without the hidden tabs. [current] stays while it is
    // open, so a jump to a hidden tab (the live Guide's Back lands on Live TV) still shows where the user is.
    fun bar(keys: List<String>, pref: HomeRows.Pref, current: String? = null): List<String> {
        val middle = HomeRows.arrange(movable(keys), pref).filter { it !in pref.hidden || it == current }
        return keys.filter { it == HOME } + middle + keys.filter { it in PINNED && it != HOME }
    }
}
