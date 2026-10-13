package com.wika.wicaby.mobile.cast

import android.content.Context
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.OptionsProvider
import com.google.android.gms.cast.framework.SessionProvider
import com.google.android.gms.cast.framework.media.CastMediaOptions

// The CastContext's options (cast spec CA-10), named in src/gplay/AndroidManifest.xml. The Default Media Receiver
// by default; GmsGoogleCast switches to Jellyfin's receiver before connecting to a Jellyfin server. No Cast SDK
// notification nor media session: PlaybackService already posts the cast's (CA-08), with Stop.
class WicabyCastOptions : OptionsProvider {
    override fun getCastOptions(context: Context): CastOptions = CastOptions.Builder()
        .setReceiverApplicationId(GmsGoogleCast.DMR)
        .setSupportedNamespaces(listOf(GmsGoogleCast.CONNECTSDK))
        .setCastMediaOptions(CastMediaOptions.Builder().setNotificationOptions(null).setMediaSessionEnabled(false).build())
        .build()

    override fun getAdditionalSessionProviders(context: Context): List<SessionProvider>? = null
}
