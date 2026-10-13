package com.wika.wicaby.core.mesh

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// The desktop side of this fixture is tools/checks/vpn-selfcheck.mjs.
class DiagnosticsTest {
    @Test
    fun sharedFixture() {
        val cases = Json.parseToJsonElement(File("../../../tools/checks/fixtures/diagnostics-redact.json").readText()).jsonObject["cases"]!!.jsonArray
        assertTrue(cases.size > 10)
        for (c in cases.map { it.jsonObject }) {
            val names = c["names"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()
            assertEquals(c["name"]!!.jsonPrimitive.content, c["expected"]!!.jsonPrimitive.content, redactDiagnostics(c["input"]!!.jsonPrimitive.content, names))
        }
    }
}
