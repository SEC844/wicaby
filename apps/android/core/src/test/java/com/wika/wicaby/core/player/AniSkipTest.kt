package com.wika.wicaby.core.player

import com.wika.wicaby.core.data.json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

// Android side of tools/checks/fixtures/aniskip.json; the desktop side is tools/checks/aniskip-check.mjs.
class AniSkipTest {
    private val fx = json.parseToJsonElement(File("../../../tools/checks/fixtures/aniskip.json").readText()).jsonObject

    private fun JsonObject.long(key: String): Long? = this[key]?.takeIf { it !is JsonNull }?.jsonPrimitive?.long
    private fun JsonObject.ids(key: String) = this[key]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }

    @Test
    fun parsesSavedResponses() {
        for (c in fx["cases"]!!.jsonArray.map { it.jsonObject }) {
            val name = c["name"]!!.jsonPrimitive.content
            val s = AniSkip.parse(c["response"].toString())
            val e = c["expect"]
            if (e is JsonNull) {
                assertNull(name, s)
                continue
            }
            e as JsonObject
            assertEquals(name, e.long("introStartMs"), s!!.introStart)
            assertEquals(name, e.long("introEndMs"), s.introEnd)
            assertEquals(name, e.long("creditsStartMs"), s.credits)
            val recap = s.ranges.firstOrNull { it.kind == SegmentKind.Recap }?.let { listOf(it.startMs, it.endMs) }
            assertEquals(name, e["recap"]?.takeIf { it !is JsonNull }?.jsonArray?.map { it.jsonPrimitive.long }, recap)
        }
        assertNull(AniSkip.parse("not json"))
    }

    @Test
    fun resolvesTargets() {
        for (c in fx["targets"]!!.jsonArray.map { it.jsonObject }) {
            val ep = c["episode"]!!.jsonObject
            val t = AniSkip.target(ep.long("IndexNumber")?.toInt(), ep.long("ParentIndexNumber")?.toInt(), c.ids("season"), c.ids("series"))
            val e = c["expect"]
            val want = (e as? JsonObject)?.let { AniSkipTarget(it.long("mal")?.toInt(), it.long("anilist")?.toInt(), it.long("episode")!!.toInt()) }
            assertEquals(c["name"]!!.jsonPrimitive.content, want, t)
        }
    }

    @Test
    fun serverRangesWin() {
        val server = Segments(ranges = listOf(SkipRange(SegmentKind.Recap, 0, 5_000), SkipRange(SegmentKind.Preview, 1_400_000, 1_420_000)))
        val a = AniSkip.parse(fx["cases"]!!.jsonArray[1].jsonObject["response"].toString())!!
        val m = AniSkip.merge(server, a)
        assertEquals(100_000L, m.introStart)
        assertEquals(listOf(SegmentKind.Recap, SegmentKind.Intro, SegmentKind.Preview), m.ranges.map { it.kind })
        assertEquals(0L, m.ranges.first().startMs)
        assertEquals(
            "https://api.aniskip.com/v2/skip-times/5114/1?types[]=op&types[]=ed&types[]=mixed-op&types[]=mixed-ed&types[]=recap&episodeLength=1470",
            AniSkip.url(5114, 1, 1_469_634),
        )
    }
}
