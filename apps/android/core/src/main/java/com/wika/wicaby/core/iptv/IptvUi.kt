package com.wika.wicaby.core.iptv

import androidx.annotation.StringRes
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.Server

// What the TV and phone IPTV screens share: the setup link of a server's Live TV, and the text of an add failure.

/** The page of [s]'s own web admin where Live TV (tuners, M3U) is set up; null for a source that has none. */
fun liveSetupUrl(s: Server): String? {
    val base = s.address.trimEnd('/').takeIf { it.startsWith("http://", true) || it.startsWith("https://", true) }
    return when (s.kind) {
        "plex" -> "https://app.plex.tv/desktop/#!/settings/server/${s.id}/settings"
        "emby" -> base?.let { "$it/web/index.html#!/livetvsetup" }
        "jellyfin" -> base?.let { "$it/web/#/dashboard/livetv" }
        else -> null
    }
}

@StringRes
fun iptvErrorText(e: Throwable): Int = when ((e as? IptvError)?.kind) {
    IptvError.Kind.BAD_URL -> R.string.iptv_error_url
    IptvError.Kind.EMPTY -> R.string.iptv_error_empty
    IptvError.Kind.TOO_LARGE -> R.string.iptv_error_too_large
    else -> R.string.iptv_error_unreachable
}
