package com.wika.wicaby.core.music

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

// Music spec MU-01 AC2: the LRC vectors desktop's tools/checks/music-check.mjs runs, through Lrc.kt.
class LrcTest {
    private fun cases(name: String): List<JsonObject> =
        Json.parseToJsonElement(File("../../../tools/checks/fixtures/music/$name.json").readText()).jsonObject["cases"]!!.jsonArray.map { it.jsonObject }

    @Test
    fun sharedVectors() {
        val all = cases("lrc-cases")
        assert(all.size >= 15)
        for (c in all) {
            val name = c["name"]!!.jsonPrimitive.content
            val want = c["expected"]!!.jsonObject
            val lines = want["lines"]!!.jsonArray.map { it.jsonObject }.map { LyricLine(it["startMs"]?.jsonPrimitive?.long, it["text"]!!.jsonPrimitive.content) }
            assertEquals(name, Lyrics(want["synced"]!!.jsonPrimitive.boolean, lines), Lrc.parse(c["input"]!!.jsonPrimitive.content))
        }
    }

    @Test
    fun jellyfinLyricsKeepTheirTicks() {
        val synced = JellyfinLyrics(JellyfinLyrics.Meta(true), listOf(JellyfinLyrics.Row("A", 12_500_000))).toLyrics()
        assertEquals(Lyrics(true, listOf(LyricLine(1250, "A"))), synced)
        assertEquals(Lyrics(false, listOf(LyricLine(null, "A"))), JellyfinLyrics(JellyfinLyrics.Meta(false), listOf(JellyfinLyrics.Row("A"))).toLyrics())
        assertNull(JellyfinLyrics().toLyrics())
    }
}
