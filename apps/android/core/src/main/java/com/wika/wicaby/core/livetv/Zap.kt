package com.wika.wicaby.core.livetv

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator

// Live TV zapping (spec §8.3, §8.4): the zap list, CH+/- merging, held keys, the last channel and the
// number-entry DigitBuffer (also the guide's jump mode). Time is injected so the golden vectors
// replay it. Mirrors D/shared/livetv/zap.ts (golden vectors: zap.json).

// ---- Zap list ----

const val ZAP_MERGE_MS = 400L

/** Held CH keys preview at most 8 channels/s. */
const val HELD_PREVIEW_MS = 125L

/**
 * Next / previous with wrap, skipping hidden ids. When [fromId] is not in the list (a search tune),
 * its position is found by number order.
 */
fun zapTarget(list: List<ZapEntry>, fromId: String, delta: Int, fromNumber: String? = null, hidden: Collection<String> = emptyList()): String? {
    val skip = hidden.toHashSet()
    val usable = list.filter { it.id !in skip }
    if (usable.isEmpty()) return null
    val n = usable.size
    val i = usable.indexOfFirst { it.id == fromId }
    if (i >= 0) {
        if (n == 1) return if (usable[0].id == fromId) null else usable[0].id
        return usable[Math.floorMod(i + delta, n)].id
    }
    // Not in the list: the slot it would take in number order.
    val key = parseChannelNumber(fromNumber ?: list.firstOrNull { it.id == fromId }?.number ?: "")
    var at = usable.indexOfFirst { compareNumKey(parseChannelNumber(it.number), key) > 0 }
    if (at < 0) at = n // after everything
    return if (delta > 0) usable[at % n].id else usable[Math.floorMod(at - 1, n)].id
}

data class ZapState(
    /** Adopted channel. */
    val current: String? = null,
    /** The adopted channel before it ("Chaîne précédente"). */
    val last: String? = null,
    /** Merged target shown in the banner, not yet tuned. */
    val pending: String? = null,
    /** When the merged tune fires. */
    val fireAt: Long? = null,
    /** A CH key is held (TV): preview only, tune on key-up. */
    val held: Boolean = false,
    /** null = never (−Infinity in zap.ts). */
    val lastPreviewAt: Long? = null,
    /** The tune in flight. */
    val tuning: String? = null,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("type")
sealed interface ZapEvent {
    @Serializable @SerialName("press") data class Press(val delta: Int, val at: Long, val repeat: Boolean = false) : ZapEvent
    @Serializable @SerialName("key-up") data class KeyUp(val at: Long) : ZapEvent
    @Serializable @SerialName("tick") data class Tick(val at: Long) : ZapEvent

    /** Digits, mini-guide, guide, search… */
    @Serializable @SerialName("tune") data class Tune(val id: String, val at: Long) : ZapEvent
    @Serializable @SerialName("last-channel") data class LastChannel(val at: Long) : ZapEvent
    @Serializable @SerialName("adopted") data class Adopted(val id: String) : ZapEvent
    @Serializable @SerialName("failed") data class Failed(val id: String) : ZapEvent
}

@Serializable
data class ZapEffect(val type: Type, val id: String) {
    @Serializable
    enum class Type {
        @SerialName("banner") BANNER,
        @SerialName("tune") TUNE,
    }
}

data class ZapStep(val state: ZapState, val effects: List<ZapEffect>)

fun zapInit(current: String? = null): ZapState = ZapState(current = current)

private fun banner(id: String) = ZapEffect(ZapEffect.Type.BANNER, id)
private fun tuneFx(id: String) = ZapEffect(ZapEffect.Type.TUNE, id)

fun zapReduce(s: ZapState, ev: ZapEvent, list: List<ZapEntry>, hidden: Collection<String> = emptyList()): ZapStep = when (ev) {
    is ZapEvent.Press -> {
        val from = s.pending ?: s.tuning ?: s.current
        when {
            from == null -> ZapStep(s, emptyList())
            ev.repeat && s.lastPreviewAt != null && ev.at - s.lastPreviewAt < HELD_PREVIEW_MS -> ZapStep(s.copy(held = true, fireAt = null), emptyList())
            else -> {
                val target = zapTarget(list, from, ev.delta, null, hidden)
                if (target == null) {
                    ZapStep(s, emptyList())
                } else {
                    ZapStep(
                        s.copy(pending = target, fireAt = if (ev.repeat) null else ev.at + ZAP_MERGE_MS, held = ev.repeat, lastPreviewAt = ev.at),
                        listOf(banner(target)),
                    )
                }
            }
        }
    }
    is ZapEvent.KeyUp -> if (!s.held || s.pending == null) ZapStep(s.copy(held = false), emptyList()) else fire(s.copy(held = false))
    is ZapEvent.Tick -> if (s.pending == null || s.fireAt == null || ev.at < s.fireAt) ZapStep(s, emptyList()) else fire(s)
    is ZapEvent.Tune -> {
        val st = s.copy(pending = null, fireAt = null, held = false)
        if (ev.id == s.current && s.tuning == null) {
            ZapStep(st, listOf(banner(ev.id)))
        } else {
            ZapStep(st.copy(tuning = ev.id), listOf(banner(ev.id), tuneFx(ev.id)))
        }
    }
    is ZapEvent.LastChannel -> if (s.last == null) ZapStep(s, emptyList()) else zapReduce(s, ZapEvent.Tune(s.last, ev.at), list, hidden)
    is ZapEvent.Adopted -> {
        val tuning = if (s.tuning == ev.id) null else s.tuning
        if (ev.id == s.current) ZapStep(s.copy(tuning = tuning), emptyList()) else ZapStep(s.copy(last = s.current, current = ev.id, tuning = tuning), emptyList())
    }
    is ZapEvent.Failed -> ZapStep(s.copy(tuning = if (s.tuning == ev.id) null else s.tuning), emptyList())
}

private fun fire(s: ZapState): ZapStep {
    val id = s.pending!!
    val st = s.copy(pending = null, fireAt = null)
    if (id == s.current && s.tuning == null) return ZapStep(st, emptyList())
    return ZapStep(st.copy(tuning = id), listOf(tuneFx(id)))
}

// ---- Number entry (§8.4) ----

@Serializable
data class DigitChannel(val id: String, val number: String, val hidden: Boolean = false)

const val DIGIT_TIMEOUT_MS = 1800L
const val JUMP_TIMEOUT_MS = 1200L
const val DIGIT_MAX_CHARS = 6

data class DigitState(
    /** Digits and at most one '.'. */
    val buf: String,
    /** Index among exact duplicates (↑/↓). */
    val pick: Int,
    val lastKeyAt: Long,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("kind")
sealed interface DigitPreview {
    /** Ids in lineup order; [pick] is the one OK tunes. */
    @Serializable @SerialName("exact") data class Exact(val ids: List<String>, val pick: Int) : DigitPreview
    @Serializable @SerialName("prefix") data class Prefix(val id: String) : DigitPreview
    @Serializable @SerialName("alias") data class Alias(val id: String) : DigitPreview
    @Serializable @SerialName("none") data object None : DigitPreview
}

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("type")
sealed interface DigitResult {
    @Serializable @SerialName("commit") data class Commit(val id: String, val hidden: Boolean, val via: Via) : DigitResult
    @Serializable @SerialName("fail") data class Fail(val number: String) : DigitResult
    @Serializable @SerialName("last-channel") data object LastChannel : DigitResult
    @Serializable @SerialName("cancel") data object Cancel : DigitResult

    @Serializable
    enum class Via {
        @SerialName("exact") EXACT,
        @SerialName("alias") ALIAS,
    }
}

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("type")
sealed interface DigitEvent {
    val at: Long

    @Serializable @SerialName("digit") data class Digit(val d: String, override val at: Long) : DigitEvent
    @Serializable @SerialName("separator") data class Separator(override val at: Long) : DigitEvent
    @Serializable @SerialName("backspace") data class Backspace(override val at: Long) : DigitEvent
    @Serializable @SerialName("enter") data class Enter(override val at: Long) : DigitEvent
    @Serializable @SerialName("pick") data class Pick(val delta: Int, override val at: Long) : DigitEvent
    @Serializable @SerialName("escape") data class Escape(override val at: Long) : DigitEvent
    @Serializable @SerialName("tick") data class Tick(override val at: Long) : DigitEvent
}

data class DigitStep(
    /** null = the buffer is closed. */
    val state: DigitState?,
    val preview: DigitPreview?,
    val result: DigitResult? = null,
)

/** Lookup tables over the whole lineup (hidden channels included), built once per lineup. */
class DigitIndex internal constructor(internal val rows: List<Row>) {
    internal class Row(val id: String, val raw: String, val key: NumKey?, val canon: String, val hidden: Boolean)
}

private val RAW_SEP_RE = Regex("$JS_WS*[.\\-_ ]$JS_WS*")
private fun normRaw(s: String): String = RAW_SEP_RE.replaceFirst(jsTrim(s), ".")

fun digitIndex(lineup: List<DigitChannel>): DigitIndex = DigitIndex(
    lineup.map { c ->
        val key = parseChannelNumber(c.number)
        DigitIndex.Row(c.id, if (key != null) normRaw(c.number) else "", key, if (key != null) numKeyText(key) else "", c.hidden)
    },
)

/** Exact matches, raw first ('05' reaches the channel numbered '05'), then by number key ('02' → 2). */
private fun exact(ix: DigitIndex, buf: String): List<DigitIndex.Row> {
    val raw = ix.rows.filter { it.key != null && it.raw == buf }
    if (raw.isNotEmpty()) return raw
    val key = parseChannelNumber(buf) ?: return emptyList()
    return ix.rows.filter { it.key != null && it.key == key }
}

/**
 * Numbers that extend the buffer (raw or canonical form), other than an exact match. A buffer with
 * a leading zero extends by raw numbers only ('0' waits for '05'; '02' does not wait for 20–29).
 */
private fun extendable(ix: DigitIndex, buf: String): List<DigitIndex.Row> {
    if (buf.startsWith("0")) return ix.rows.filter { it.key != null && it.raw.startsWith(buf) && it.raw != buf }
    val dot = buf.endsWith(".")
    val key = parseChannelNumber(if (dot) buf.dropLast(1) else buf)
    val canon = if (key != null) numKeyText(key) + (if (dot) "." else "") else buf
    return ix.rows.filter { it.key != null && ((it.raw.startsWith(buf) && it.raw != buf) || (it.canon.startsWith(canon) && it.canon != canon)) }
}

/** Sub-channel alias: '51' → 5.1 when no channel 51 exists (longest major part first). */
private fun alias(ix: DigitIndex, buf: String): DigitIndex.Row? {
    if (buf.contains('.') || buf.length < 2) return null
    for (i in buf.length - 1 downTo 1) {
        val major = buf.substring(0, i).toLong()
        val minor = buf.substring(i).toLong()
        ix.rows.firstOrNull { it.key != null && it.key.major == major && it.key.minor == minor }?.let { return it }
    }
    return null
}

/** Could more digits still make an alias match? ('51' waits when 5.12 exists.) */
private fun aliasPossible(ix: DigitIndex, buf: String): Boolean {
    if (buf.contains('.')) return false
    for (i in 1 until buf.length) {
        val major = buf.substring(0, i).toLong()
        val minorPart = buf.substring(i)
        if (ix.rows.any { it.key != null && it.key.minor >= 0 && it.key.major == major && it.key.minor.toString().startsWith(minorPart) }) return true
    }
    return false
}

fun digitPreview(ix: DigitIndex, st: DigitState): DigitPreview {
    val ex = exact(ix, st.buf)
    if (ex.isNotEmpty()) return DigitPreview.Exact(ex.map { it.id }, minOf(st.pick, ex.size - 1))
    alias(ix, st.buf)?.let { return DigitPreview.Alias(it.id) }
    val ext = extendable(ix, st.buf)
    if (ext.isNotEmpty()) return DigitPreview.Prefix(ext[0].id)
    return DigitPreview.None
}

private fun resolve(ix: DigitIndex, st: DigitState): DigitResult {
    val ex = exact(ix, st.buf)
    if (ex.isNotEmpty()) {
        val r = ex[minOf(st.pick, ex.size - 1)]
        return DigitResult.Commit(r.id, r.hidden, DigitResult.Via.EXACT)
    }
    alias(ix, st.buf)?.let { return DigitResult.Commit(it.id, it.hidden, DigitResult.Via.ALIAS) }
    return DigitResult.Fail(st.buf)
}

/**
 * After a key: commit at once on a unique exact match that nothing extends; fail at once when
 * nothing starts with the buffer and no alias can match.
 */
private fun settle(ix: DigitIndex, st: DigitState): DigitStep {
    val preview = digitPreview(ix, st)
    val ex = exact(ix, st.buf)
    val ext = extendable(ix, st.buf)
    if (ex.size == 1 && ext.isEmpty() && !aliasPossible(ix, st.buf)) return DigitStep(null, preview, resolve(ix, st))
    if (ex.isEmpty() && ext.isEmpty() && alias(ix, st.buf) == null && !aliasPossible(ix, st.buf)) return DigitStep(null, preview, DigitResult.Fail(st.buf))
    return DigitStep(st, preview)
}

private val ONE_DIGIT_RE = Regex("[0-9]")

/** One step of the buffer. [st] null means closed: a digit opens it, Backspace means last channel. */
fun digitReduce(ix: DigitIndex, st: DigitState?, ev: DigitEvent, timeoutMs: Long = DIGIT_TIMEOUT_MS): DigitStep = when (ev) {
    is DigitEvent.Digit -> {
        val buf = st?.buf ?: ""
        when {
            !ONE_DIGIT_RE.matches(ev.d) -> DigitStep(st, st?.let { digitPreview(ix, it) })
            buf.length >= DIGIT_MAX_CHARS -> DigitStep(st!!.copy(lastKeyAt = ev.at), digitPreview(ix, st))
            else -> settle(ix, DigitState(buf + ev.d, 0, ev.at))
        }
    }
    is DigitEvent.Separator -> {
        if (st == null || st.buf.contains('.') || st.buf.length >= DIGIT_MAX_CHARS) {
            DigitStep(st?.copy(lastKeyAt = ev.at), st?.let { digitPreview(ix, it) })
        } else {
            val next = DigitState(st.buf + ".", 0, ev.at)
            DigitStep(next, digitPreview(ix, next))
        }
    }
    is DigitEvent.Backspace -> when {
        st == null -> DigitStep(null, null, DigitResult.LastChannel)
        st.buf.length <= 1 -> DigitStep(null, null, DigitResult.Cancel)
        else -> DigitState(st.buf.dropLast(1), 0, ev.at).let { DigitStep(it, digitPreview(ix, it)) }
    }
    is DigitEvent.Pick -> when {
        st == null -> DigitStep(null, null)
        else -> {
            val ex = exact(ix, st.buf)
            if (ex.size < 2) {
                DigitStep(st.copy(lastKeyAt = ev.at), digitPreview(ix, st))
            } else {
                val next = st.copy(pick = Math.floorMod(st.pick + ev.delta, ex.size), lastKeyAt = ev.at)
                DigitStep(next, digitPreview(ix, next))
            }
        }
    }
    is DigitEvent.Enter -> if (st == null) DigitStep(null, null) else DigitStep(null, digitPreview(ix, st), resolve(ix, st))
    is DigitEvent.Escape -> DigitStep(null, null, if (st != null) DigitResult.Cancel else null)
    is DigitEvent.Tick -> when {
        st == null -> DigitStep(null, null)
        ev.at - st.lastKeyAt < timeoutMs -> DigitStep(st, digitPreview(ix, st))
        else -> DigitStep(null, digitPreview(ix, st), resolve(ix, st))
    }
}
