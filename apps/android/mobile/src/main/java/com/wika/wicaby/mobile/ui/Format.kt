package com.wika.wicaby.mobile.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalConfiguration
import java.text.NumberFormat
import java.util.Locale

// Numbers in the UI language ("1,5×" in French, "1.5×" in English), not the JVM default:
// below Android 13 the in-app language only changes the activity configuration.
@Composable
fun uiLocale(): Locale = LocalConfiguration.current.locales[0]

@Composable
fun formatNumber(value: Number, maxFractionDigits: Int = 0, minFractionDigits: Int = 0): String =
    NumberFormat.getNumberInstance(uiLocale()).apply {
        maximumFractionDigits = maxFractionDigits
        minimumFractionDigits = minFractionDigits
    }.format(value)
