package com.wika.wicaby.core.torrents

import android.text.format.Formatter
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import java.math.RoundingMode
import java.text.NumberFormat

// Sizes, speeds, ETAs and percentages in the UI language (Core.localized):
// "1,4 Go", "820 ko/s", "2 h 05" in French; "1.4 GB", "820 kB/s", "2h 05m" in English.

fun formatBytes(bytes: Long): String {
    if (bytes < 0) return "—"
    // Formatter says "0 octet(s)" in French below 1 kB: keep the short unit there too.
    if (bytes < 1000) return Core.str(R.string.size_bytes, bytes.toInt())
    return Formatter.formatShortFileSize(Core.localized, bytes)
}

fun formatSpeed(bytesPerSecond: Long): String = Core.str(R.string.speed_per_second, formatBytes(bytesPerSecond.coerceAtLeast(0)))

// null when qBittorrent has no estimate.
fun formatEta(seconds: Long): String? {
    if (seconds <= 0 || seconds >= ETA_INFINITE) return null
    val d = (seconds / 86_400).toInt()
    val h = ((seconds % 86_400) / 3600).toInt()
    val m = ((seconds % 3600) / 60).toInt()
    return when {
        d > 0 -> Core.str(R.string.duration_days_hours, d, h)
        h > 0 -> Core.str(R.string.duration_hours_minutes, h, m)
        m > 0 -> Core.str(R.string.duration_minutes, m)
        else -> Core.str(R.string.duration_seconds, seconds.toInt())
    }
}

fun formatPercent(progress: Float): String {
    val p = progress.coerceIn(0f, 1f)
    val nf = NumberFormat.getPercentInstance(Core.locale)
    nf.maximumFractionDigits = if (p > 0f && p < 0.1f) 1 else 0
    nf.minimumFractionDigits = nf.maximumFractionDigits
    // Truncate: never show 100 % before the torrent is complete.
    nf.roundingMode = RoundingMode.DOWN
    return nf.format(p.toDouble())
}
