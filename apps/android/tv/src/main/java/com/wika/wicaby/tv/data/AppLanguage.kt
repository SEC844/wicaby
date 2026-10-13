package com.wika.wicaby.tv.data

import android.app.Activity
import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import android.os.Build
import android.os.LocaleList
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.content.edit
import androidx.core.os.LocaleListCompat
import com.wika.wicaby.core.Core
import java.util.Locale

// Réglages > Interface > Langue: System, Français or English (res/xml/locales_config.xml).
//
// API 33+: the per-app language belongs to the system (LocaleManager), which also lists it
// in the system settings and recreates the activities on change. AppCompatDelegate cannot
// reach LocaleManager here: it looks it up through AppCompatActivity delegates, and our
// activities are plain ComponentActivity.
// Below 33: the choice is stored in our SharedPreferences, handed to AppCompatDelegate,
// and applied by each activity in attachBaseContext (overrideConfiguration below).
object AppLanguage {
    const val SYSTEM = ""
    val TAGS = listOf(SYSTEM, "fr", "en")

    private const val KEY = "ui_language"

    private fun prefs(context: Context) = context.getSharedPreferences("wicaby_tv", Context.MODE_PRIVATE)

    private fun stored(context: Context): String = prefs(context).getString(KEY, SYSTEM).orEmpty().takeIf { it in TAGS } ?: SYSTEM

    // "" (follow the system), "fr" or "en".
    fun current(context: Context): String {
        if (Build.VERSION.SDK_INT >= 33) {
            val list = context.getSystemService(LocaleManager::class.java)?.applicationLocales
            if (list == null || list.isEmpty) return SYSTEM
            return list[0].language.takeIf { it in TAGS } ?: SYSTEM
        }
        return stored(context)
    }

    // Application.onCreate.
    fun init(context: Context) {
        if (Build.VERSION.SDK_INT >= 33) return
        val tag = stored(context)
        AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(tag))
        applyLegacy(tag)
    }

    fun set(activity: Activity, tag: String) {
        if (tag == current(activity)) return
        prefs(activity).edit { putString(KEY, tag) }
        if (Build.VERSION.SDK_INT >= 33) {
            // The system recreates every activity with the new configuration.
            activity.getSystemService(LocaleManager::class.java)?.applicationLocales = LocaleList.forLanguageTags(tag)
        } else {
            AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(tag))
            applyLegacy(tag)
            activity.recreate()
        }
    }

    // Below 33: what attachBaseContext passes to applyOverrideConfiguration, or null for the
    // system language. Only the locale is set; fontScale 0 leaves the user's text size alone.
    fun overrideConfiguration(context: Context): Configuration? {
        if (Build.VERSION.SDK_INT >= 33) return null
        val tag = stored(context).ifEmpty { return null }
        return Configuration().apply {
            fontScale = 0f
            setLocale(Locale.forLanguageTag(tag))
        }
    }

    // Text written outside an activity (the launcher's channel names): the chosen language below 33 too.
    fun localized(context: Context): Context = overrideConfiguration(context)?.let(context::createConfigurationContext) ?: context

    // Activity.onCreate: :core formats its own text (torrent states, sizes, errors) in the
    // language this activity resolved, whichever path set it.
    fun applyToCore(activity: Activity) {
        Core.setUiLocale(localeOf(activity.resources.configuration))
    }

    fun localeOf(config: Configuration): Locale =
        if (Build.VERSION.SDK_INT >= 24) config.locales[0] else @Suppress("DEPRECATION") config.locale

    // Below 33 the default Locale (String.format, NumberFormat) does not follow on its own.
    private fun applyLegacy(tag: String) {
        val locale = if (tag.isEmpty()) localeOf(Resources.getSystem().configuration) else Locale.forLanguageTag(tag)
        Locale.setDefault(locale)
        Core.setUiLocale(if (tag.isEmpty()) null else locale)
    }
}
