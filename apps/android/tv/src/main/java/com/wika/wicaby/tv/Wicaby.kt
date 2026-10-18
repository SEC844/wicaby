package com.wika.wicaby.tv

import android.app.Application
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.memory.MemoryCache
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.crossfade
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.comics.ComicCoverFetcher
import com.wika.wicaby.core.comics.ComicCoverKeyer
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.OfflineProgress
import com.wika.wicaby.core.data.Prefs
import com.wika.wicaby.core.livetv.DeviceClassDetector
import com.wika.wicaby.core.livetv.FormFactor
import kotlinx.coroutines.launch

class Wicaby : Application(), SingletonImageLoader.Factory {
    // Shared state lives in :core; these keep the TV screens' call sites unchanged.
    val prefs: Prefs get() = Core.prefs

    var api: Api?
        get() = Core.api
        set(v) {
            Core.api = v
            // Progress an external player handed back while the server was unreachable.
            v?.let { Core.scope.launch { runCatching { OfflineProgress.flush(it) } } }
        }

    var maxMbps: Int
        get() = Core.maxMbps
        set(v) {
            Core.maxMbps = v
        }

    var accent: Int = 0
    var displayMode: Int = 0

    override fun onCreate() {
        super.onCreate()
        app = this
        Core.init(this, BuildConfig.VERSION_NAME, "Wicaby Android TV")
        // Photos spec §6.1: signing out or removing an account drops the cached images.
        Core.prefs.clearImages = { SingletonImageLoader.get(this).run { memoryCache?.clear(); diskCache?.clear() } }
        com.wika.wicaby.tv.data.AppLanguage.init(this)
        com.wika.wicaby.tv.data.TvSettings.applyToCore()
        com.wika.wicaby.core.update.Updater.init("tv", BuildConfig.VERSION_CODE, BuildConfig.VERSION_NAME)
        // Live TV tuning (§21.3): classify once, off the main thread, and log it (incl. a debug override).
        Core.scope.launch { DeviceClassDetector.detect(this@Wicaby, FormFactor.TV) }
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
                add(com.wika.wicaby.core.files.PhotoThumbFetcher.Factory(parallel = 2))
                add(OkHttpNetworkFetcherFactory(callFactory = { com.wika.wicaby.core.files.FileSources.calls }))
            }
            // design.md --t-fast, scaled by the system "Animator duration scale"; none on low-RAM devices, where a fade that
            // starts while a row scrolls can stall part-way. shortcut: the scale is read once per process.
            .crossfade(if (DeviceClassDetector.detect(this, FormFactor.TV).isLow) 0 else (160 * android.provider.Settings.Global.getFloat(contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f)).toInt())
            // §21.9: decoded images ≤ 15 % of memoryClass on a tv-low device (Coil's default is 25 %).
            .memoryCache { MemoryCache.Builder().maxSizePercent(context, if (DeviceClassDetector.detect(this, FormFactor.TV).isLow) 0.15 else 0.25).build() }
            .build()

    companion object {
        lateinit var app: Wicaby
            private set
    }
}
