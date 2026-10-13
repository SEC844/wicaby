package com.wika.wicaby.core.music

enum class Repeat { Off, All, One }

/** A play queue: the entries, the one playing, the repeat mode and the order before shuffle (null: not shuffled). */
data class QueueState(val ids: List<String>, val index: Int, val repeat: Repeat = Repeat.Off, val unshuffled: List<String>? = null)

sealed interface QueueOp {
    data class Move(val from: Int, val to: Int) : QueueOp
    data class Remove(val index: Int) : QueueOp
    data class Jump(val index: Int) : QueueOp
    data class InsertNext(val ids: List<String>) : QueueOp
    data class Append(val ids: List<String>) : QueueOp
    data object ClearUpcoming : QueueOp
    data class Shuffle(val seed: Int) : QueueOp
    data object Unshuffle : QueueOp
    data class SetRepeat(val mode: Repeat) : QueueOp
}

/**
 * Pure queue operations (music spec MU-01), the twin of desktop's shared/music-queue.ts: same semantics, same
 * vectors (tools/checks/fixtures/music/queue-vectors.json). An op that does not apply returns the state unchanged.
 */
object MusicQueue {
    /** mulberry32, bit for bit the desktop generator (Int arithmetic wraps like Math.imul). */
    fun random(seed: Int): () -> Double {
        var a = seed
        return {
            a += 0x6D2B79F5
            var t = (a xor (a ushr 15)) * (1 or a)
            t = (t + (t xor (t ushr 7)) * (61 or t)) xor t
            ((t xor (t ushr 14)).toLong() and 0xFFFFFFFFL).toDouble() / 4294967296.0
        }
    }

    fun apply(s: QueueState, op: QueueOp): QueueState {
        val ids = s.ids.toMutableList()
        val inRange = { i: Int -> i in s.ids.indices }
        return when (op) {
            is QueueOp.Move -> {
                if (!inRange(op.from) || !inRange(op.to) || op.from == op.to) return s
                ids.add(op.to, ids.removeAt(op.from))
                // The playing entry keeps playing wherever it lands.
                val index = when {
                    op.from == s.index -> op.to
                    op.from < s.index && op.to >= s.index -> s.index - 1
                    op.from > s.index && op.to <= s.index -> s.index + 1
                    else -> s.index
                }
                s.copy(ids = ids, index = index)
            }
            is QueueOp.Remove -> {
                if (!inRange(op.index)) return s
                ids.removeAt(op.index)
                // Removing the playing entry makes the next one current (the last one when it was the end).
                s.copy(ids = ids, index = if (op.index < s.index) s.index - 1 else minOf(s.index, maxOf(0, ids.size - 1)))
            }
            is QueueOp.Jump -> if (inRange(op.index)) s.copy(index = op.index) else s
            is QueueOp.InsertNext -> s.copy(ids = ids.apply { addAll(if (s.ids.isEmpty()) 0 else s.index + 1, op.ids) })
            is QueueOp.Append -> s.copy(ids = ids + op.ids)
            QueueOp.ClearUpcoming -> s.copy(ids = ids.take(s.index + 1))
            is QueueOp.SetRepeat -> s.copy(repeat = op.mode)
            is QueueOp.Shuffle -> {
                if (s.unshuffled != null || ids.isEmpty()) return s
                // The playing entry goes first, the rest (before and after it) in a seeded Fisher-Yates order.
                val current = ids.removeAt(s.index)
                val rnd = random(op.seed)
                for (i in ids.size - 1 downTo 1) {
                    val j = (rnd() * (i + 1)).toInt()
                    ids[i] = ids[j].also { ids[j] = ids[i] }
                }
                s.copy(ids = listOf(current) + ids, index = 0, unshuffled = s.ids)
            }
            QueueOp.Unshuffle -> {
                val old = s.unshuffled ?: return s
                // The old order of what is still queued, then what was added since, in its current order.
                val left = s.ids.groupingBy { it }.eachCount().toMutableMap()
                val restored = (old + s.ids).filter { id -> (left[id] ?: 0).let { n -> if (n > 0) true.also { left[id] = n - 1 } else false } }
                // shortcut: a track queued twice resumes at its first copy; entry keys would be needed to tell copies apart.
                s.copy(ids = restored, index = maxOf(0, restored.indexOf(s.ids[s.index])), unshuffled = null)
            }
        }
    }

    /** The entry after the current one, -1 for none. Repeat one replays it unless the user asked for the next (manual). */
    fun nextIndex(s: QueueState, manual: Boolean = false): Int = when {
        s.ids.isEmpty() -> -1
        s.repeat == Repeat.One && !manual -> s.index
        s.index + 1 < s.ids.size -> s.index + 1
        s.repeat == Repeat.Off -> -1
        else -> 0
    }
}
