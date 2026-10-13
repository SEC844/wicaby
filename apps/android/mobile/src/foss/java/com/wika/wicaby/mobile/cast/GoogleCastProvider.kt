package com.wika.wicaby.mobile.cast

import android.content.Context

// foss (cast spec CA-10): no Google code, so no Google Cast. The gplay flavour has the real one.
object GoogleCastProvider {
    @Suppress("UNUSED_PARAMETER")
    fun get(context: Context): GoogleCast? = null

    // No GPL section 7 permission to show: foss links nothing it would cover.
    val exception: LicenceException? = null
}
