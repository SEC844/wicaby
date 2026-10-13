package com.wika.wicaby.core.music

import com.wika.wicaby.core.player.PlayQueue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

// Music spec MU-01 AC2: the queue vectors desktop's tools/checks/music-check.mjs runs, through MusicQueue.kt, with
// the same results (shuffles included: the seeded generator is bit for bit desktop's).
class MusicQueueTest {
    private val cases: List<JsonObject> =
        Json.parseToJsonElement(File("../../../tools/checks/fixtures/music/queue-vectors.json").readText()).jsonObject["cases"]!!.jsonArray.map { it.jsonObject }

    private fun ids(e: JsonElement?): List<String>? = if (e == null || e is JsonNull) null else e.jsonArray.map { it.jsonPrimitive.content }
    private fun repeat(e: JsonElement?) = Repeat.entries.first { it.name.lowercase() == e!!.jsonPrimitive.content }

    private fun state(o: JsonObject) = QueueState(ids(o["ids"])!!, o["index"]!!.jsonPrimitive.int, repeat(o["repeat"]), ids(o["unshuffled"]))

    private fun op(o: JsonObject): QueueOp {
        val i = { k: String -> o[k]!!.jsonPrimitive.int }
        return when (val name = o["op"]!!.jsonPrimitive.content) {
            "move" -> QueueOp.Move(i("from"), i("to"))
            "remove" -> QueueOp.Remove(i("index"))
            "jump" -> QueueOp.Jump(i("index"))
            "insertNext" -> QueueOp.InsertNext(ids(o["ids"])!!)
            "append" -> QueueOp.Append(ids(o["ids"])!!)
            "clearUpcoming" -> QueueOp.ClearUpcoming
            "shuffle" -> QueueOp.Shuffle(i("seed"))
            "unshuffle" -> QueueOp.Unshuffle
            "repeat" -> QueueOp.SetRepeat(repeat(o["mode"]))
            else -> error("unknown op $name")
        }
    }

    @Test
    fun sharedVectors() {
        assert(cases.size >= 25)
        for (c in cases) {
            val name = c["name"]!!.jsonPrimitive.content
            val s = (c["ops"] as JsonArray).map { op(it.jsonObject) }.fold(state(c["state"]!!.jsonObject)) { acc, o -> MusicQueue.apply(acc, o) }
            val e = c["expect"]!!.jsonObject
            assertEquals(name, state(e), s)
            assertEquals("$name: next", e["next"]!!.jsonPrimitive.int, MusicQueue.nextIndex(s))
            assertEquals("$name: next (manual)", e["nextManual"]!!.jsonPrimitive.int, MusicQueue.nextIndex(s, manual = true))
        }
    }

    @Test
    fun generatorMatchesMulberry32() {
        // First outputs of mulberry32(42), as JavaScript computes them.
        val r = MusicQueue.random(42)
        assertEquals(listOf(0.6011037519201636, 0.44829055899754167, 0.8524657934904099), List(3) { r() })
    }

    @Test
    fun playQueueAppliesTheSharedOps() {
        val q = PlayQueue(listOf("a", "b", "c", "d"), 1)
        q.apply(QueueOp.Move(3, 0))
        assertEquals(listOf("d", "a", "b", "c"), q.ids.toList())
        assertEquals("b", q.id)
        q.apply(QueueOp.SetRepeat(Repeat.All))
        q.apply(QueueOp.Jump(3))
        assertEquals(0, q.nextIndex())
        q.apply(QueueOp.Shuffle(7))
        assertEquals("c", q.id)
        q.apply(QueueOp.Unshuffle)
        assertEquals(listOf("d", "a", "b", "c"), q.ids.toList())
        assertEquals(3, q.index)
    }
}
