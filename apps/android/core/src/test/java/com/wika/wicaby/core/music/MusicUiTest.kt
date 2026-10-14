package com.wika.wicaby.core.music

import com.wika.wicaby.core.data.json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// The release type (music-feishin-navidrome spec C4): the vectors desktop's tools/checks/music-ui-check.mjs runs.
class MusicUiTest {
    @Test
    fun releaseTypeMatchesTheSharedVectors() {
        val cases = json.parseToJsonElement(File("../../../tools/checks/fixtures/music/ui-vectors.json").readText()).jsonObject["release"]!!.jsonArray
        assertTrue(cases.size >= 10)
        for (c in cases.map { it.jsonObject }) {
            val got = MusicUi.releaseType(c["tracks"]!!.jsonPrimitive.int, c["ms"]!!.jsonPrimitive.long, c["artist"]?.jsonPrimitive?.contentOrNull)
            assertEquals(c["name"]!!.jsonPrimitive.content, c["expect"]!!.jsonPrimitive.content, got.name.lowercase())
        }
    }
}
