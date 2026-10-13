package com.wika.wicaby.core.livetv

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

// Live TV zap controller (spec §4.1, §8.3, §8.4): the stateful shell around the pure zapReduce and
// digitReduce of Zap.kt. It owns the zap list (the lens snapshot the player started with), merges
// CH+/- presses (tune 400 ms after the last one, never while the key is still down; a held key
// previews and tunes on key-up), keeps the last channel, and runs the number-entry buffer with its timeout. The player side (LiveSession) gets
// the tunes through [onTune] and reports back with [adopted] / [failed]. Main-thread friendly:
// every call is short, timers run on [scope].

/** The open digit buffer and what it previews. */
data class DigitView(val buf: String, val preview: DigitPreview?)

class ZapController(
    private val scope: CoroutineScope,
    private val onTune: (String) -> Unit,
    private val clock: () -> Long = { System.nanoTime() / 1_000_000 },
    /** §8.4: 1,000–5,000 ms setting; the guide's jump mode uses JUMP_TIMEOUT_MS. */
    var digitTimeoutMs: Long = DIGIT_TIMEOUT_MS,
) {
    private var list: List<ZapEntry> = emptyList()
    private var hidden: Set<String> = emptySet()
    private var index: DigitIndex = digitIndex(emptyList())
    private var digitState: DigitState? = null
    private var tickJob: Job? = null
    private var digitJob: Job? = null
    @Volatile private var holding = false

    private val _state = MutableStateFlow(zapInit())
    val state: StateFlow<ZapState> = _state.asStateFlow()

    /** The channel the banner shows (pending target, else the tune), null until a zap. */
    private val _banner = MutableStateFlow<String?>(null)
    val banner: StateFlow<String?> = _banner.asStateFlow()

    private val _digits = MutableStateFlow<DigitView?>(null)
    val digits: StateFlow<DigitView?> = _digits.asStateFlow()

    /** Every number-entry outcome: the UI words a hidden commit ("Chaîne masquée") and a failure ("Aucune chaîne {n}"), and announces commits. */
    private val _results = MutableSharedFlow<DigitResult>(extraBufferCapacity = 8)
    val results: SharedFlow<DigitResult> = _results.asSharedFlow()

    val entries: List<ZapEntry> get() = synchronized(this) { list }

    /**
     * A new zap list (player start, or a lens change from the mini-guide; the position is found
     * again by id). [lineup] is the whole lineup, hidden channels included, for number entry.
     */
    fun setList(entries: List<ZapEntry>, hiddenIds: Collection<String> = emptyList(), lineup: List<DigitChannel>? = null) {
        val h = hiddenIds.toHashSet()
        val ix = digitIndex(lineup ?: entries.map { DigitChannel(it.id, it.number, it.id in h) })
        synchronized(this) {
            list = entries
            hidden = h
            index = ix
        }
    }

    /**
     * A CH press. [keyDown] = the key is still down (TV): the 400 ms merge tune waits for [keyUp], because
     * Android's key repeat starts only after ~500 ms and a held key must preview, not tune its first step.
     */
    fun press(delta: Int, repeat: Boolean = false, keyDown: Boolean = false) {
        if (keyDown) holding = true
        dispatch(ZapEvent.Press(delta, clock(), repeat))
    }

    fun keyUp() {
        holding = false
        dispatch(ZapEvent.KeyUp(clock())) // also arms the merge tune a short press left pending
    }

    fun tune(id: String) = dispatch(ZapEvent.Tune(id, clock()))
    fun lastChannel() = dispatch(ZapEvent.LastChannel(clock()))
    fun adopted(id: String) = dispatch(ZapEvent.Adopted(id))
    fun failed(id: String) = dispatch(ZapEvent.Failed(id))

    private fun dispatch(ev: ZapEvent) {
        val tunes = ArrayList<String>()
        synchronized(this) {
            val step = zapReduce(_state.value, ev, list, hidden)
            _state.value = step.state
            for (fx in step.effects) when (fx.type) {
                ZapEffect.Type.BANNER -> _banner.value = fx.id
                ZapEffect.Type.TUNE -> tunes.add(fx.id)
            }
            armTick(step.state.fireAt)
        }
        tunes.forEach(onTune)
    }

    private fun armTick(fireAt: Long?) {
        tickJob?.cancel()
        tickJob = fireAt?.takeUnless { holding }?.let { at ->
            scope.launch {
                delay((at - clock()).coerceAtLeast(0))
                dispatch(ZapEvent.Tick(clock()))
            }
        }
    }

    // ---- Number entry ----

    fun digit(d: Char) = digitEvent(DigitEvent.Digit(d.toString(), clock()))
    fun separator() = digitEvent(DigitEvent.Separator(clock()))
    fun backspace() = digitEvent(DigitEvent.Backspace(clock()))
    fun enter() = digitEvent(DigitEvent.Enter(clock()))
    fun pick(delta: Int) = digitEvent(DigitEvent.Pick(delta, clock()))
    fun escape() = digitEvent(DigitEvent.Escape(clock()))

    /** True while the buffer is open (OK, ↑/↓ and Back go to it). */
    val digitsOpen: Boolean get() = synchronized(this) { digitState != null }

    private fun digitEvent(ev: DigitEvent) {
        val result = synchronized(this) {
            val step = digitReduce(index, digitState, ev, digitTimeoutMs)
            digitState = step.state
            _digits.value = step.state?.let { DigitView(it.buf, step.preview) }
            digitJob?.cancel()
            digitJob = step.state?.let { st ->
                scope.launch {
                    delay((st.lastKeyAt + digitTimeoutMs - clock()).coerceAtLeast(0))
                    digitEvent(DigitEvent.Tick(clock()))
                }
            }
            step.result
        } ?: return
        when (result) {
            is DigitResult.Commit -> tune(result.id)
            DigitResult.LastChannel -> lastChannel()
            else -> {}
        }
        _results.tryEmit(result) // every outcome: the TV announces commits (§21.7) and words failures
    }
}
