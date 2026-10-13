package com.wika.wicaby.core.livetv

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// C-5: the "tuning" and "deviceClass" cases of CK/fixtures/livetv/tiles.json (shared with
// D/shared/livetv/tiles.ts), run on the JVM. Gradle runs unit tests from the module directory.
class DeviceClassTest {
    private val cases = Json.parseToJsonElement(File("../../../tools/checks/fixtures/livetv/tiles.json").readText())
        .jsonObject.getValue("cases").jsonArray.map { it.jsonObject }

    private fun JsonObject.str(key: String) = this[key]?.jsonPrimitive?.content

    @Test
    fun tuningForTheFiveClasses() {
        val case = cases.single { it.str("fn") == "tuning" }
        val out = case.getValue("out").jsonObject
        assertEquals(DeviceClass.entries.map { it.id }.toSet(), out.keys)
        for ((id, v) in out) {
            val o = v.jsonObject
            val expected = PlatformTuning(
                channelPage = o.getValue("channelPage").jsonPrimitive.int,
                channelPagesInFlight = o.getValue("channelPagesInFlight").jsonPrimitive.int,
                tileChannels = o.getValue("tileChannels").jsonPrimitive.int,
                tileMaxSlabs = o.getValue("tileMaxSlabs").jsonPrimitive.int,
                concurrency = o.getValue("concurrency").jsonPrimitive.int,
                rowOverscan = o.getValue("rowOverscan").jsonPrimitive.int,
                timeOverscanMin = o.getValue("timeOverscanMin").jsonPrimitive.int,
                maxCells = o.getValue("maxCells").jsonPrimitive.int,
                lruPrograms = o.getValue("lruPrograms").jsonPrimitive.int,
                persistMb = o.getValue("persistMb").jsonPrimitive.int,
                idleFavoritesOnly = o.getValue("idleFavoritesOnly").jsonPrimitive.boolean,
                idleMax = o.getValue("idleMax").jsonPrimitive.int,
                artDelayMs = o.getValue("artDelayMs").jsonPrimitive.int,
            )
            assertEquals(id, expected, DeviceClass.fromId(id)!!.tuning)
            // Every key in the vector is a field we compared (a new field must be added here too).
            assertEquals(id, 13, o.size)
        }
    }

    @Test
    fun deviceClassVectors() {
        val vectors = cases.filter { it.str("fn") == "deviceClass" }
        assertTrue("expected the device class vectors", vectors.size >= 8)
        val seen = mutableSetOf<DeviceClass>()
        for (case in vectors) {
            val a = case.getValue("args").jsonArray[0].jsonObject
            val facts = DeviceFacts(
                platform = FormFactor.valueOf(a.str("platform")!!.uppercase()),
                is64Bit = a["is64Bit"]?.jsonPrimitive?.booleanOrNull,
                lowRam = a["lowRam"]?.jsonPrimitive?.booleanOrNull,
                totalMemBytes = a["totalMemBytes"]?.jsonPrimitive?.longOrNull,
                memoryClassMb = a["memoryClassMb"]?.jsonPrimitive?.intOrNull,
                override = a.str("override")?.let { assertNotNull(it, DeviceClass.fromId(it)); DeviceClass.fromId(it) },
            )
            val got = classifyDevice(facts)
            assertEquals(case.str("name"), case.str("out"), got.id)
            seen += got
        }
        assertEquals("the vectors cover all five classes", DeviceClass.entries.toSet(), seen)
    }

    @Test
    fun thresholdsAreInclusive() {
        val gib22 = (2.2 * 1024 * 1024 * 1024).toLong()
        assertEquals(DeviceClass.TV_LOW, classifyDevice(DeviceFacts(FormFactor.TV, true, false, gib22, 512)))
        assertEquals(DeviceClass.TV, classifyDevice(DeviceFacts(FormFactor.TV, true, false, gib22 + 1, 512)))
        assertEquals(DeviceClass.TV_LOW, classifyDevice(DeviceFacts(FormFactor.TV, true, false, 8L shl 30, 192)))
        assertEquals(DeviceClass.TV, classifyDevice(DeviceFacts(FormFactor.TV, true, false, 8L shl 30, 193)))
        // Unknown facts never make a device "-low".
        assertEquals(DeviceClass.TV, classifyDevice(DeviceFacts(FormFactor.TV)))
        assertEquals(DeviceClass.MOBILE, classifyDevice(DeviceFacts(FormFactor.MOBILE)))
        // The override wins even on desktop; mobile-low shares the tv-low tuning.
        assertEquals(DeviceClass.TV_LOW, classifyDevice(DeviceFacts(FormFactor.DESKTOP, override = DeviceClass.TV_LOW)))
        assertEquals(PlatformTuning.TV_LOW, DeviceClass.MOBILE_LOW.tuning)
    }

    @Test
    fun overrideIds() {
        assertEquals(DeviceClass.TV_LOW, DeviceClass.fromId(" TV-LOW "))
        assertEquals(null, DeviceClass.fromId("fast"))
        assertEquals(null, DeviceClass.fromId(null))
        assertEquals(null, DeviceClass.fromId(""))
    }
}
