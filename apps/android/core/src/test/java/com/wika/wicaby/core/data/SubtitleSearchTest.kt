package com.wika.wicaby.core.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

// X-03: the golden vectors of CK/fixtures/subtitles/subtitles.json, shared with tools/checks/subtitles-check.mjs
// (D/shared/subtitles.ts). Gradle runs unit tests from the module directory.
class SubtitleSearchTest {
    private val fx = Json.parseToJsonElement(File("../../../tools/checks/fixtures/subtitles/subtitles.json").readText()).jsonObject
    private fun cases(name: String) = fx.getValue(name).jsonArray.map { it.jsonObject }

    @Test
    fun flagsOfBothShapes() {
        for (c in cases("flags")) {
            val r = json.decodeFromString(RemoteSubtitle.serializer(), c.getValue("in").toString())
            val out = c.getValue("out").jsonObject
            val name = c.getValue("name").jsonPrimitive.content
            assertEquals(name, out.getValue("forced").jsonPrimitive.boolean, r.forcedFlag)
            assertEquals(name, out.getValue("sdh").jsonPrimitive.boolean, r.sdhFlag)
            assertEquals(name, out.getValue("machine").jsonPrimitive.boolean, r.machineFlag)
        }
    }

    @Test
    fun defaultLanguage() {
        for (c in cases("language")) {
            val s = { k: String -> c.getValue(k).jsonPrimitive.content }
            assertEquals(c.toString(), s("out"), SubtitleRules.language(s("last"), s("preferred"), s("ui")))
        }
    }

    @Test
    fun failureByStatus() {
        for (c in cases("failure")) {
            val status = c.getValue("status").jsonPrimitive.int
            val expected = mapOf("noProvider" to SubtitleRules.Failure.NO_PROVIDER, "forbidden" to SubtitleRules.Failure.FORBIDDEN, "failed" to SubtitleRules.Failure.FAILED)
            val e = if (status == 0) java.io.IOException("offline") else ApiException("x", status)
            assertEquals("$status", expected.getValue(c.getValue("out").jsonPrimitive.content), SubtitleRules.failure(e))
        }
    }

    @Test
    fun policy() {
        for (c in cases("policy")) {
            val p = c.getValue("policy").takeIf { it != JsonNull } as JsonObject?
            assertEquals(c.toString(), c.getValue("out").jsonPrimitive.boolean, SubtitleRules.canDownload(p, c.getValue("jellyfin").jsonPrimitive.boolean))
        }
    }

    @Test
    fun addedStream() {
        fun streams(c: JsonObject, k: String) = c.getValue(k).jsonArray.map { json.decodeFromString(MediaStream.serializer(), it.toString()) }
        for (c in cases("added")) {
            assertEquals(c.getValue("name").jsonPrimitive.content, c.getValue("out").jsonPrimitive.intOrNull, SubtitleRules.added(streams(c, "before"), streams(c, "after"))?.index)
        }
    }
}
