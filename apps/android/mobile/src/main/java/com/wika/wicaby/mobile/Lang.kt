package com.wika.wicaby.mobile

import android.content.Context
import android.content.res.Configuration
import android.os.Build
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.content.edit
import androidx.core.os.LocaleListCompat
import com.wika.wicaby.core.Core
import java.util.Locale

// The app language: French (values, the default) or English (values-en), or the system's.
// AppCompatDelegate stores the choice (LocaleManager on Android 13+, AppLocalesMetadataHolderService
// below) and relocalizes the activities. Below 13 the application context, services and workers do
// not follow it, so the tag is mirrored here and [wrap] localizes those contexts (notifications).
object Lang {
    private const val PREFS = "wicaby_lang"
    private const val KEY = "tag"

    // "" = follow the system, else a language tag ("fr", "en").
    fun current(context: Context): String {
        val tags = AppCompatDelegate.getApplicationLocales().toLanguageTags()
        return (if (tags.isEmpty() && Build.VERSION.SDK_INT < 33) stored(context) else tags).substringBefore(',').substringBefore('-')
    }

    fun set(context: Context, tag: String) {
        val app = context.applicationContext
        app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit { putString(KEY, tag) }
        Core.setUiLocale(tag.takeIf { it.isNotEmpty() }?.let(Locale::forLanguageTag))
        (app as? WicabyApp)?.createChannels()
        AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(tag))
    }

    // The locale core should format and translate with; null = the system's.
    fun uiLocale(context: Context): Locale? =
        if (Build.VERSION.SDK_INT >= 33) AppCompatDelegate.getApplicationLocales()[0]
        else stored(context).takeIf { it.isNotEmpty() }?.let(Locale::forLanguageTag)

    private fun stored(context: Context): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null).orEmpty()

    // A context in the app language, for strings shown outside an activity. Android 13+ already does this.
    fun wrap(context: Context): Context {
        if (Build.VERSION.SDK_INT >= 33) return context
        val locale = uiLocale(context) ?: return context
        val config = Configuration(context.resources.configuration).apply { setLocale(locale) }
        return context.createConfigurationContext(config)
    }
}
