package com.wika.wicaby.core.iptv

import com.wika.wicaby.core.livetv.Civil
import com.wika.wicaby.core.livetv.parseServerDate
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.GZIPOutputStream

// Replays tools/checks/fixtures/iptv (the vectors iptv-check.mjs replays against D/shared/iptv/*.ts) through the
// Kotlin twins: the playlists to m3u.expected.json, guide.xml with edge.m3u to guide.expected.json, the guide fed
// whole, in 7-character chunks and gzipped through feedGuide.
class IptvParityTest {
    private val dir: File by lazy {
        generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, FIXTURES) }.firstOrNull { it.isDirectory }
            ?: error("$FIXTURES not found above ${File("").absolutePath}")
    }
    private val out = Json { explicitNulls = false }

    private fun fixture(name: String) = File(dir, name).readText()
    private fun expected(name: String) = Json.parseToJsonElement(fixture(name)).jsonObject

    @Test
    fun playlists() {
        val exp = expected("m3u.expected.json")
        assertEquals(setOf("edge.m3u", "plain.m3u"), exp.keys)
        for ((file, want) in exp) assertEquals(file, want, out.encodeToJsonElement(parseM3u(fixture(file))))
    }

    @Test
    fun streamedPlaylistMatchesText() {
        val text = fixture("edge.m3u")
        assertEquals(parseM3u(text), readPlaylist(ByteArrayInputStream(text.toByteArray())))
    }

    @Test
    fun guideWhole() = checkGuide { c -> c.parser.push(fixture("guide.xml")) }

    @Test
    fun guideInTinyChunks() = checkGuide { c -> fixture("guide.xml").chunked(7).forEach(c.parser::push) }

    @Test
    fun guideGzipped() {
        val gz = ByteArrayOutputStream().also { b -> GZIPOutputStream(b).use { it.write(File(dir, "guide.xml").readBytes()) } }.toByteArray()
        assertEquals(0x1f, gz[0].toInt() and 0xff)
        checkGuide { c -> feedGuide(ByteArrayInputStream(gz), c.parser, chunkChars = 13) }
    }

    @Test
    fun guidePlainThroughFeed() = checkGuide { c -> feedGuide(ByteArrayInputStream(File(dir, "guide.xml").readBytes()), c.parser, chunkChars = 5) }

    private fun checkGuide(feed: (GuideCollector) -> Unit) {
        val exp = expected("guide.expected.json")
        val channels = parseM3u(fixture(exp.str("playlist"))).channels
        val c = collectGuide(channels, parseServerDate(exp.str("from"))!!, parseServerDate(exp.str("to"))!!)
        feed(c)
        val got = c.finish()
        assertEquals("channels", exp.num("channels"), c.parser.channels)
        assertEquals("seen", exp.num("seen"), c.parser.programmes)
        assertEquals("kept", exp.num("kept"), c.parser.kept)
        assertEquals("skipped", exp.num("skipped"), c.parser.skipped)
        val progs = buildJsonObject {
            for ((id, list) in got) put(
                id,
                buildJsonArray {
                    for (p in list) add(
                        buildJsonObject {
                            put("start", Civil.isoUtc(p.start))
                            put("stop", Civil.isoUtc(p.stop))
                            put("title", p.title)
                            p.subTitle?.let { put("subTitle", it) }
                            p.desc?.let { put("desc", it) }
                            p.categories?.let { cs -> put("categories", buildJsonArray { cs.forEach { add(JsonPrimitive(it)) } }) }
                            p.episode?.let { put("episode", it) }
                        },
                    )
                },
            )
        }
        assertEquals(exp.getValue("programmes"), progs)
    }

    @Test
    fun units() {
        assertEquals(parseXmltvDate("20261014120000 +0200"), parseServerDate("2026-10-14T10:00:00Z"))
        assertEquals(parseXmltvDate("202610141500"), parseServerDate("2026-10-14T15:00:00Z"))
        assertEquals(null, parseXmltvDate("2026-10-14 12:00"))
        assertEquals(null, parseXmltvDate("20261314120000"))
        assertEquals("a & <b> &lt;", decodeXml("<![CDATA[a & <b> &lt;]]>"))
        assertEquals("é —", decodeXml("&#233;   &#x2014;"))
        assertEquals("plain", decodeUriComponent("plain"))
        assertEquals("é a+b", decodeUriComponent("%C3%A9%20a+b"))
        assertEquals(null, decodeUriComponent("%E9"))
        assertEquals(null, decodeUriComponent("%zz"))
        assertTrue(isWebUrl("https://x.example/a?b=c") && !isWebUrl("udp://@1.2.3.4:1") && !isWebUrl("http://a b"))
        assertEquals(16, stableId("").length)
    }

    @Test
    fun oversizedElementIsSkippedNotBuffered() {
        val c = collectGuide(emptyList(), 0, Long.MAX_VALUE)
        c.parser.push("<tv><programme start=\"20261014120000\" channel=\"x\"><title>" + "a".repeat(MAX_ELEMENT + 10))
        c.parser.push("</title></programme></tv>")
        c.finish()
        assertEquals(1, c.parser.skipped)
    }

    private fun JsonObject.str(k: String) = getValue(k).jsonPrimitive.content
    private fun JsonObject.num(k: String) = getValue(k).jsonPrimitive.int

    private companion object {
        const val FIXTURES = "tools/checks/fixtures/iptv"
    }
}
