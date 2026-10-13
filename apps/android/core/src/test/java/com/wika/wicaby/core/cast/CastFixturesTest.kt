package com.wika.wicaby.core.cast

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Document
import org.w3c.dom.Element
import java.io.File
import java.net.URI
import java.nio.ByteBuffer
import javax.xml.parsers.DocumentBuilderFactory

// Cast spec CA-06 AC5: the recorded renderer XML and the CASTV2 golden vectors in CK/fixtures/cast/ are the files
// tools/mock-server/mock-dlna.mjs serves and tools/checks/cast-mock-check.mjs replays. This pins their shape for the
// Android side until CA-08 (DlnaTest) and CA-12 parse them with the real code. Gradle runs from the module directory.
class CastFixturesTest {
    private val dir = File("../../../tools/checks/fixtures/cast")
    private val location = "http://127.0.0.1:8970/desc.xml"

    // No DTD and no entities, as the CA-08 parser (cast spec §6).
    private fun xml(name: String): Document =
        DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = true
            setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        }.newDocumentBuilder().parse(File(dir, name))

    private fun Element.text(tag: String): String? = getElementsByTagNameNS("*", tag).item(0)?.textContent?.trim()

    @Test
    fun descriptions() {
        val udns = mutableSetOf<String>()
        for (profile in listOf("generic", "sony", "samsung")) {
            val root = xml("dlna-desc-$profile.xml").documentElement
            assertEquals("urn:schemas-upnp-org:device:MediaRenderer:1", root.text("deviceType"))
            assertTrue(profile, root.text("friendlyName")!!.isNotBlank())
            val udn = root.text("UDN")!!
            assertTrue(udn, udn.startsWith("uuid:") && udns.add(udn))
            val base = root.text("URLBase")
            assertEquals("URLBase only on generic", profile == "generic", base != null)
            val services = root.getElementsByTagNameNS("*", "service")
            val control = (0 until services.length).map { services.item(it) as Element }
                .associate { it.text("serviceType")!!.substringAfter(":service:").substringBefore(":1") to it.text("controlURL")!! }
            assertEquals(setOf("AVTransport", "RenderingControl", "ConnectionManager"), control.keys)
            // controlURL against URLBase, or against LOCATION without one.
            assertEquals("http://127.0.0.1:8970/ctl/avt", URI(base ?: location).resolve(control.getValue("AVTransport")).toString())
        }
    }

    @Test
    fun protocolInfoSinks() {
        for (profile in listOf("generic", "sony", "samsung")) {
            val sink = xml("dlna-protocolinfo-$profile.xml").documentElement.text("Sink")!!.split(',')
            assertTrue(profile, sink.size > 5 && sink.all { it.startsWith("http-get:*:") && it.split(':').size == 4 })
        }
        assertTrue(xml("dlna-protocolinfo-samsung.xml").documentElement.text("Sink")!!.contains("video/x-mkv"))
    }

    @Test
    fun faults() {
        for (code in listOf("701", "714", "716")) assertEquals(code, xml("dlna-fault-$code.xml").documentElement.text("errorCode"))
    }

    @Test
    fun castv2Frames() {
        val vectors = Json.parseToJsonElement(File(dir, "castv2-vectors.json").readText()).jsonObject.getValue("vectors").jsonArray
        assertEquals(5, vectors.size)
        for (v in vectors) {
            val frame = v.jsonObject.getValue("hex").jsonPrimitive.content.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
            val msg = v.jsonObject.getValue("message").jsonObject
            assertEquals("4-byte big-endian length", frame.size - 4, ByteBuffer.wrap(frame, 0, 4).int)
            // payload_utf8 (field 6) is the last field: its bytes close the frame.
            val data = msg.getValue("data").jsonPrimitive.content.toByteArray()
            assertArrayEquals(data, frame.copyOfRange(frame.size - data.size, frame.size))
            assertTrue(String(frame, Charsets.UTF_8).contains(msg.getValue("namespace").jsonPrimitive.content))
        }
    }
}
