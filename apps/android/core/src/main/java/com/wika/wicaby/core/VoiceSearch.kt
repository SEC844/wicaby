package com.wika.wicaby.core

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.speech.RecognizerIntent
import java.util.Locale

// Voice search through the system speech recognizer (the remote's or the phone's microphone):
// the spoken words fill the search field. For both apps: show the mic only when available(),
// launch intent() with ActivityResultContracts.StartActivityForResult, read it with result().
object VoiceSearch {
    fun available(context: Context): Boolean = runCatching {
        context.packageManager.queryIntentActivities(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH), PackageManager.MATCH_DEFAULT_ONLY).isNotEmpty()
    }.getOrDefault(false)

    // [locale]: the app's language (it can differ from the system's), so titles are heard in it.
    fun intent(prompt: String, locale: Locale): Intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale.toLanguageTag())
        .putExtra(RecognizerIntent.EXTRA_PROMPT, prompt)
        .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)

    // The best transcription, or null when the viewer said nothing or cancelled.
    fun result(data: Intent?): String? =
        data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }
}
