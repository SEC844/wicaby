package com.wika.wicaby.mobile.cast

import androidx.annotation.RawRes
import androidx.annotation.StringRes
import com.wika.wicaby.core.cast.CastRemote
import com.wika.wicaby.core.cast.CastTarget
import com.wika.wicaby.core.data.Api
import kotlinx.coroutines.flow.Flow

// Google Cast (cast spec CA-10): the picker's "Chromecast et Google TV" rows and what drives a picked one. Only the
// gplay flavour has it (Play services, src/gplay); GoogleCastProvider.get() is null in foss.
interface GoogleCast {
    // The Cast routes MediaRouter reports, as "c:" rows, while collected: discovery runs only while the picker is open.
    val routes: Flow<List<CastTarget>>

    // What drives [target]. Emby: the Default Media Receiver, fed and reported for by a CastController (§2.5),
    // [beforePlaying] as there. Jellyfin: its own receiver, which reports for itself and then is a Sessions-API session.
    fun remote(api: Api, target: CastTarget, beforePlaying: suspend () -> Unit): CastRemote
}

// The GPL section 7 permission of a flavour that links Play services (gplay), for the About section.
data class LicenceException(@StringRes val title: Int, @StringRes val summary: Int, @RawRes val text: Int)
