package com.wika.wicaby.tv.ui

import com.wika.wicaby.core.data.HomeRows
import org.junit.Assert.assertEquals
import org.junit.Test

class TabOrderTest {
    private val keys = listOf("home", "lib:films", "lib:series", "lib:live", "iptv", "torrents", "search", "settings")

    @Test
    fun defaultOrderWithoutPreference() {
        assertEquals(keys, TabOrder.bar(keys, HomeRows.Pref()))
    }

    @Test
    fun movableLeavesOutThePinnedTabs() {
        assertEquals(listOf("lib:films", "lib:series", "lib:live", "iptv", "torrents"), TabOrder.movable(keys))
    }

    @Test
    fun savedOrderKeepsHomeFirstAndIconTabsLast() {
        val pref = HomeRows.Pref(order = listOf("lib:series", "lib:films", "torrents", "lib:live", "iptv"))
        assertEquals(
            listOf("home", "lib:series", "lib:films", "torrents", "lib:live", "iptv", "search", "settings"),
            TabOrder.bar(keys, pref),
        )
    }

    @Test
    fun hiddenTabsLeaveTheBar() {
        val pref = HomeRows.Pref(hidden = setOf("torrents", "iptv"))
        assertEquals(listOf("home", "lib:films", "lib:series", "lib:live", "search", "settings"), TabOrder.bar(keys, pref))
    }

    @Test
    fun hiddenTabStaysWhileItIsOpen() {
        val pref = HomeRows.Pref(hidden = setOf("lib:live"))
        assertEquals(keys, TabOrder.bar(keys, pref, current = "lib:live"))
    }

    @Test
    fun pinnedTabsCannotBeHidden() {
        val pref = HomeRows.Pref(hidden = setOf("home", "search", "settings"))
        assertEquals(keys, TabOrder.bar(keys, pref))
    }

    @Test
    fun newLibraryKeepsItsDefaultPlace() {
        // Saved before "lib:docs" existed: it lands after its default neighbour, "lib:series".
        val pref = HomeRows.Pref(order = listOf("lib:series", "lib:films", "lib:live", "iptv", "torrents"))
        val withDocs = listOf("home", "lib:films", "lib:series", "lib:docs", "lib:live", "iptv", "torrents", "search", "settings")
        assertEquals(
            listOf("home", "lib:series", "lib:docs", "lib:films", "lib:live", "iptv", "torrents", "search", "settings"),
            TabOrder.bar(withDocs, pref),
        )
    }
}
