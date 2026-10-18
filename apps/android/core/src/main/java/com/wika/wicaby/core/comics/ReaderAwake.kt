package com.wika.wicaby.core.comics

import android.os.Handler
import android.os.Looper
import android.view.Window
import android.view.WindowManager

/**
 * Keeps a reader's screen on while it is in use: reading means long stretches without input, but a page left
 * alone lets the screen time out (or the TV's screensaver start) after [idleMs]. Call [poke] on every input.
 */
class ReaderAwake(private val window: Window, private val idleMs: Long = 10 * 60_000L) {
    private val handler = Handler(Looper.getMainLooper())
    private val off = Runnable { window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }

    fun poke() {
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        handler.removeCallbacks(off)
        handler.postDelayed(off, idleMs)
    }

    fun stop() = handler.removeCallbacks(off)
}
