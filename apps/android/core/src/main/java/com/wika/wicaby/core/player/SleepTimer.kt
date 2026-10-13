package com.wika.wicaby.core.player

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

// X-04 sleep timer (feature-specs.md §4), one per process so it survives episode changes. The player
// screens call check() once a second: PROMPT shows "Still watching?", EXPIRE pauses. "End of this
// video" fires from atEnd() instead, and the player then neither autoplays nor shows up next.
object SleepTimer {
    const val PROMPT_MS = 30_000L
    const val EXTEND_MIN = 15

    // minutes == null: end of this video. endsAt is unset then; promptUntil once it fired.
    data class State(val minutes: Int?, val endsAt: Long?, val promptUntil: Long? = null)

    enum class Action { NONE, PROMPT, EXPIRE }

    private val _state = MutableStateFlow<State?>(null)
    val state: StateFlow<State?> = _state

    val endOfVideo: Boolean get() = _state.value?.let { it.minutes == null && it.promptUntil == null } == true

    fun start(minutes: Int?, now: Long = System.currentTimeMillis()) {
        _state.value = State(minutes, minutes?.let { now + it * 60_000L })
    }

    fun cancel() {
        _state.value = null
    }

    // "+15 min" while a timer runs.
    fun extend(now: Long = System.currentTimeMillis()) {
        val s = _state.value ?: return
        val base = s.endsAt ?: return
        _state.value = s.copy(endsAt = maxOf(base, now) + EXTEND_MIN * 60_000L, promptUntil = null)
    }

    // "Continue" (or Back) on the prompt: the same duration again.
    fun restart(now: Long = System.currentTimeMillis()) {
        _state.value?.let { start(it.minutes, now) }
    }

    // promptMs: the prompt's time to answer (the TV app passes the accessibility-recommended timeout).
    fun check(now: Long = System.currentTimeMillis(), promptMs: Long = PROMPT_MS): Action {
        val s = _state.value ?: return Action.NONE
        val until = s.promptUntil
        if (until != null) {
            if (now < until) return Action.NONE
            _state.value = null
            return Action.EXPIRE
        }
        if (s.endsAt == null || now < s.endsAt) return Action.NONE
        _state.value = s.copy(promptUntil = now + promptMs)
        return Action.PROMPT
    }

    // The item ended: true when "end of this video" was set, which now prompts instead of going on.
    fun atEnd(now: Long = System.currentTimeMillis(), promptMs: Long = PROMPT_MS): Boolean {
        if (!endOfVideo) return false
        _state.value = _state.value?.copy(promptUntil = now + promptMs)
        return true
    }
}
