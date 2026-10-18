package com.wika.wicaby.core.data

import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.mutablePreferencesOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The pre-theme-list "oled" boolean becomes a theme id once, and never overrides a theme chosen later.
class PrefsThemeTest {
    private val oled = booleanPreferencesKey("oled")

    @Test
    fun oledBecomesTheOledTheme() {
        val p = mutablePreferencesOf(oled to true)
        migrateTheme(p)
        assertEquals("oled", p[themeKey])
        assertNull(p[oled])
    }

    @Test
    fun darkBecomesGraphite() {
        val p = mutablePreferencesOf(oled to false)
        migrateTheme(p)
        assertEquals("graphite", p[themeKey])
        assertNull(p[oled])
    }

    @Test
    fun aChosenThemeWins() {
        val p = mutablePreferencesOf(oled to true, themeKey to "cinema")
        migrateTheme(p)
        assertEquals("cinema", p[themeKey])
        assertNull(p[oled])
    }

    @Test
    fun aFreshStoreStaysUnset() {
        val p = mutablePreferencesOf()
        migrateTheme(p)
        assertNull(p[themeKey])
    }
}
