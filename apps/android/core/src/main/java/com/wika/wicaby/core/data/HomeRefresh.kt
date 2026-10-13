package com.wika.wicaby.core.data

import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

// B10: when Home and Continue Watching reload by themselves (desktop: main/features/continue-watching.ts).
// While Home is on show: a LibraryChanged or UserDataChanged from the server, 2 s after the first one of a burst
// and at most every 30 s (another device playing sends one per progress report); and every 5 min.
// Coming back to it (from the player, another app): at once. [now] is a monotonic clock in ms (tests: a fake one).
class HomeRefresh(private val now: () -> Long = { System.nanoTime() / 1_000_000 }) {
    private var last = now()
    private var changedAt: Long? = null
    private var visits = 0

    fun onMessage(type: String) {
        if (type in TYPES && changedAt == null) changedAt = now()
    }

    // Home shows again: true from the second time on (the first load is the screen's own).
    fun shown(): Boolean = (visits++ > 0).also { if (it) done() }

    // Checked every TICK_MS while on show: true when Home should reload now.
    fun due(): Boolean {
        val t = now()
        val c = changedAt
        return ((c != null && t - c >= DEBOUNCE_MS && t - last >= MIN_GAP_MS) || t - last >= PERIOD_MS).also { if (it) done() }
    }

    private fun done() {
        last = now()
        changedAt = null
    }

    // Run while Home is on show (repeatOnLifecycle(STARTED)), on the main thread: [reload] refetches its rows.
    suspend fun run(messages: Flow<SocketMessage>, reload: () -> Unit) {
        coroutineScope {
            launch { messages.collect { onMessage(it.type) } }
            if (shown()) reload()
            while (true) {
                delay(TICK_MS)
                if (due()) reload()
            }
        }
    }

    companion object {
        val TYPES = setOf("LibraryChanged", "UserDataChanged")
        const val DEBOUNCE_MS = 2_000L
        const val MIN_GAP_MS = 30_000L
        const val PERIOD_MS = 5 * 60_000L
        const val TICK_MS = 1_000L
    }
}
