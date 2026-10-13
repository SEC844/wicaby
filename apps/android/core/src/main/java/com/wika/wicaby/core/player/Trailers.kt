package com.wika.wicaby.core.player

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import com.wika.wicaby.core.data.Item

// "Bande-annonce": local trailer files play in Wicaby's player (as a trailer: nothing is reported,
// so the film's progress is untouched); remote ones (YouTube) open in another app.
object Trailers {
    fun has(item: Item): Boolean = (item.localTrailerCount ?: 0) > 0 || remoteUrl(item) != null

    // The first remote trailer, YouTube first, as an https URL.
    fun remoteUrl(item: Item): String? {
        val urls = item.remoteTrailers.mapNotNull { normalize(it.url) }
        return urls.firstOrNull(::isYoutube) ?: urls.firstOrNull()
    }

    fun isYoutube(url: String): Boolean = Regex("""^https?://([a-z0-9-]+\.)?(youtube\.com|youtu\.be)/""", RegexOption.IGNORE_CASE).containsMatchIn(url)

    // NFO files often carry Kodi's plugin://plugin.video.youtube/?...videoid=ID form.
    fun normalize(raw: String): String? {
        val url = raw.trim()
        if (url.isEmpty()) return null
        Regex("""plugin\.video\.youtube.*[?&](?:videoid|video_id)=([\w-]+)""", RegexOption.IGNORE_CASE).find(url)?.let {
            return "https://www.youtube.com/watch?v=${it.groupValues[1]}"
        }
        return url.takeIf { it.startsWith("http://", true) || it.startsWith("https://", true) }
    }

    // ACTION_VIEW: the YouTube app when one is installed (phone, Android TV, Fire TV), else a real
    // app that opens the link (the browser). Android TV ships a "frameworkpackagestubs" browser
    // stub that only says "no app can do this": it does not count. False when nothing can open
    // it: the TV then shows a QR code.
    fun openRemote(context: Context, url: String): Boolean {
        val uri = Uri.parse(url)
        if (isYoutube(url)) {
            for (pkg in listOf("com.google.android.youtube.tv", "com.google.android.youtube", "com.amazon.firetv.youtube")) {
                if (start(context, Intent(Intent.ACTION_VIEW, uri).setPackage(pkg))) return true
            }
        }
        val view = Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
        val pm = context.packageManager
        val real = runCatching { pm.queryIntentActivities(view, PackageManager.MATCH_DEFAULT_ONLY) }.getOrDefault(emptyList())
            .map { it.activityInfo.packageName }.filterNot(::isStub)
        if (real.isEmpty()) return false
        val preferred = runCatching { pm.resolveActivity(view, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName }.getOrNull()
        return start(context, view.setPackage(preferred?.takeIf { it in real } ?: real.first()))
    }

    private fun isStub(pkg: String) = pkg.contains("frameworkpackagestubs") || pkg.endsWith(".stubs")

    private fun start(context: Context, intent: Intent): Boolean = try {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (_: ActivityNotFoundException) {
        false
    } catch (_: SecurityException) {
        false
    }
}
