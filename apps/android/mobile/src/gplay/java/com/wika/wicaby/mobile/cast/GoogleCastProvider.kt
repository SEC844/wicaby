package com.wika.wicaby.mobile.cast

import android.content.Context
import com.google.android.gms.cast.framework.CastContext
import com.wika.wicaby.mobile.R

// gplay (cast spec CA-10): Google Cast through Play services, once per process. null where Play services is missing
// or too old (the picker then simply has no Chromecast section). Main thread (CastContext).
object GoogleCastProvider {
    private var cast: GoogleCast? = null
    private var failed = false

    fun get(context: Context): GoogleCast? {
        if (cast == null && !failed) {
            @Suppress("DEPRECATION") // The synchronous getter: the picker needs the context now, on the main thread.
            cast = runCatching { GmsGoogleCast(context, CastContext.getSharedInstance(context.applicationContext)) }.getOrNull()
            failed = cast == null
        }
        return cast
    }

    // The GPL section 7 permission the About section shows (LICENSE-EXCEPTION.md).
    val exception: LicenceException? = LicenceException(R.string.gplay_exception_title, R.string.licence_play_services, R.raw.gplay_exception)
}
