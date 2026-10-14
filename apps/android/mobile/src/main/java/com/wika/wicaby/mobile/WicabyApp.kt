package com.wika.wicaby.mobile

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.res.Configuration
import android.net.ConnectivityManager
import android.net.Network
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.crossfade
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.comics.ComicCoverFetcher
import com.wika.wicaby.core.comics.ComicCoverKeyer
import com.wika.wicaby.core.data.OfflineProgress
import com.wika.wicaby.core.livetv.DeviceClassDetector
import com.wika.wicaby.core.livetv.FormFactor
import com.wika.wicaby.mobile.download.Downloads
import kotlinx.coroutines.launch

class WicabyApp : Application(), SingletonImageLoader.Factory {
    override fun onCreate() {
        super.onCreate()
        Core.init(this, BuildConfig.VERSION_NAME, "Wicaby Android")
        // Photos spec §6.1: signing out or removing an account drops the cached images.
        Core.prefs.clearImages = { SingletonImageLoader.get(this).run { memoryCache?.clear(); diskCache?.clear() } }
        Core.setUiLocale(Lang.uiLocale(this))
        Downloads.init(this)
        // Music wave 5: the LRCLIB toggle and the equalizer (handed to AudioFx).
        com.wika.wicaby.core.music.MusicPrefs.load(this)
        // One update channel per flavour (cast spec CA-10): same versionCode, so a foss build must never pick up the gplay
        // APK and the reverse. "mobile" stays foss, which installed 0.2.0 builds read.
        com.wika.wicaby.core.update.Updater.init(if (BuildConfig.FLAVOR == "gplay") "mobile-gplay" else "mobile", BuildConfig.VERSION_CODE, BuildConfig.VERSION_NAME)
        com.wika.wicaby.core.update.Updater.checkAtStart()
        createChannels()
        // Live TV tuning (§21.3): classify once, off the main thread, and log it (incl. a debug override).
        Core.scope.launch { DeviceClassDetector.detect(this@WicabyApp, FormFactor.MOBILE) }
        // Watch states recorded offline go up as soon as a network is back.
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                syncPending()
            }
        })
    }

    // Channel names follow the app language (re-posted when it changes).
    fun createChannels() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(Downloads.CHANNEL, Lang.wrap(this).getString(R.string.download_channel), NotificationManager.IMPORTANCE_LOW),
        )
    }

    // Android 13+: a per-app language change (system Settings or ours) lands here.
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        Core.setUiLocale(Lang.uiLocale(this))
        createChannels()
    }

    override fun newImageLoader(context: PlatformContext): ImageLoader =
        ImageLoader.Builder(context)
            .components {
                // Comics without a server cover: their first page, read with Range requests (core ComicCover.kt).
                add(ComicCoverKeyer())
                add(ComicCoverFetcher.Factory())
                // Music albums and artists without art: their first track's or album's cover, looked up once (core MusicArt.kt).
                add(com.wika.wicaby.core.music.MusicCoverKeyer())
                add(com.wika.wicaby.core.music.MusicCoverFetcher.Factory())
                // Photo sources' thumbnails: decoded once from the file, kept in cacheDir/photo-thumbs (core PhotoThumbs.kt).
                add(com.wika.wicaby.core.files.PhotoThumbFetcher.Factory())
                add(OkHttpNetworkFetcherFactory(callFactory = { com.wika.wicaby.core.files.FileSources.calls }))
            }
            .crossfade(220)
            .build()

    companion object {
        fun syncPending() {
            // TP-06: every account's queue, the extra servers' too.
            Core.scope.launch { com.wika.wicaby.mobile.ui.savedApis().forEach { runCatching { OfflineProgress.flush(it) } } }
        }
    }
}
