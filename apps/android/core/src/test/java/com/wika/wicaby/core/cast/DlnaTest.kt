package com.wika.wicaby.core.cast

import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.kxml2.io.KXmlParser
import java.util.concurrent.CopyOnWriteArrayList

// cast/Dlna.kt and cast/Ssdp.kt (cast spec CA-08 checks) on the recorded renderer XML of CK/fixtures/cast/ (the files
// mock-dlna.mjs serves and the desktop's dlna.ts parses), plus the SOAP client against a fake renderer.
class DlnaTest {
    private val location = "http://127.0.0.1:8970/desc.xml"
    // CK/fixtures/cast/, copied onto the test classpath by :core's copyCastFixtures (processTestResources).
    private fun fx(name: String) = javaClass.getResource("/cast/$name")!!.readText()

    @Before
    fun parser() {
        newXmlParser = { KXmlParser() }
    }

    @Test
    fun descriptions() {
        val expected = mapOf(
            "generic" to Triple("Mock Renderer", "uuid:5f9ec1b4-0c6a-4d5e-9a10-000000000001", false),
            "sony" to Triple("Mock BRAVIA", "uuid:5f9ec1b4-0c6a-4d5e-9a10-000000000002", true),
            "samsung" to Triple("[TV] Mock Samsung", "uuid:5f9ec1b4-0c6a-4d5e-9a10-000000000003", false),
        )
        for ((profile, e) in expected) {
            val r = Dlna.parseDescription(fx("dlna-desc-$profile.xml"), location)
            assertNotNull(profile, r)
            r!!
            assertEquals(e.first, r.name)
            assertEquals(e.second, r.udn)
            assertEquals(profile, e.third, r.sony)
            // controlURL against URLBase (generic) or LOCATION (sony, samsung: no URLBase).
            assertEquals("http://127.0.0.1:8970/ctl/avt", r.avTransport)
            assertEquals("http://127.0.0.1:8970/ctl/rc", r.renderingControl)
            assertEquals("http://127.0.0.1:8970/ctl/cm", r.connectionManager)
            assertEquals("d:" + e.second.removePrefix("uuid:"), r.key)
            val t = r.target()
            assertEquals(CastTarget.Kind.Dlna, t.kind)
            assertTrue(t.supports("setvolume") && t.supports("SetSubtitleStreamIndex"))
        }
    }

    @Test
    fun forgedDescriptionsAreRefused() {
        val generic = fx("dlna-desc-generic.xml")
        // URLBase or an absolute controlURL on another host (SSRF through a forged reply, §6).
        assertNull(Dlna.parseDescription(generic.replace("http://127.0.0.1:8970/", "http://8.8.8.8/"), location))
        assertNull(Dlna.parseDescription(generic.replace("<controlURL>ctl/avt</controlURL>", "<controlURL>http://127.0.0.1:9999/ctl/avt</controlURL>"), location))
        // No DTD, no entities.
        val dtd = """<?xml version="1.0"?><!DOCTYPE root [<!ENTITY x SYSTEM "file:///etc/passwd">]>""" + generic.substringAfter("?>")
        assertNull(Dlna.parseDescription(dtd, location))
        // Not a MediaRenderer.
        assertNull(Dlna.parseDescription(generic.replace("device:MediaRenderer:1", "device:MediaServer:1"), location))
        // A renderer without RenderingControl loses the volume commands only.
        val noRc = Dlna.parseDescription(generic.replace("service:RenderingControl:1", "service:Other:1"), location)!!
        assertNull(noRc.renderingControl)
        assertFalse(noRc.target().supports("SetVolume"))
    }

    @Test
    fun soapReplies() {
        for (code in listOf(701, 714, 716)) {
            try {
                Dlna.soapValues(fx("dlna-fault-$code.xml"))
                fail("fault $code")
            } catch (e: UpnpException) {
                assertEquals(code, e.code)
            }
        }
        val sink = Dlna.soapValues(fx("dlna-protocolinfo-samsung.xml"))["Sink"]!!
        assertTrue(sink.startsWith("http-get:*:video/mp4:*,"))
        // Escaped DIDL inside TrackMetaData comes back as text.
        val pos = Dlna.soapValues(
            """<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">""" +
                "<Track>1</Track><TrackMetaData>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</TrackMetaData><TrackURI>http://h/a?x=1&amp;y=2</TrackURI><RelTime>0:01:02</RelTime>" +
                "</u:GetPositionInfoResponse></s:Body></s:Envelope>",
        )
        assertEquals("<DIDL-Lite></DIDL-Lite>", pos["TrackMetaData"])
        assertEquals("http://h/a?x=1&y=2", pos["TrackURI"])
        assertEquals(62_000L, Dlna.parseHms(pos["RelTime"]))
    }

    @Test
    fun times() {
        assertEquals("01:02:03", Dlna.hms(3_723_400))
        assertEquals("1:02:03.400", Dlna.hms(3_723_400, millis = true))
        assertEquals(3_723_400L, Dlna.parseHms("01:02:03.4"))
        assertNull(Dlna.parseHms("NOT_IMPLEMENTED"))
    }

    @Test
    fun didlGolden() {
        val didl = Dlna.didl("Tom & Jerry <1>", false, "http://192.168.1.5:8096/Videos/1/stream.mkv?Static=true&ApiKey=t", "video/x-matroska", null, 600_000, "http://192.168.1.5:8096/s.srt?a=1&b=2")
        assertEquals(
            """<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:sec="http://www.sec.co.kr/" xmlns:pv="http://www.pv.com/pvns/">""" +
                """<item id="0" parentID="-1" restricted="1"><dc:title>Tom &amp; Jerry &lt;1&gt;</dc:title><upnp:class>object.item.videoItem</upnp:class>""" +
                """<res protocolInfo="http-get:*:video/x-matroska:*" duration="0:10:00.000" pv:subtitleFileUri="http://192.168.1.5:8096/s.srt?a=1&amp;b=2" pv:subtitleFileType="srt">http://192.168.1.5:8096/Videos/1/stream.mkv?Static=true&amp;ApiKey=t</res>""" +
                """<sec:CaptionInfoEx sec:type="srt">http://192.168.1.5:8096/s.srt?a=1&amp;b=2</sec:CaptionInfoEx><res protocolInfo="http-get:*:text/srt:*">http://192.168.1.5:8096/s.srt?a=1&amp;b=2</res>""" +
                "</item></DIDL-Lite>",
            didl,
        )
        val audio = Dlna.didl("Song", true, "http://h/a.mp3", "audio/mpeg", Dlna.FLAGS_DIRECT, null)
        assertTrue(audio.contains("<upnp:class>object.item.audioItem.musicTrack</upnp:class>"))
        assertTrue(audio.contains("""protocolInfo="http-get:*:audio/mpeg:${Dlna.FLAGS_DIRECT}">"""))
        // The envelope escapes the whole document once more (CurrentURIMetaData).
        val env = Dlna.envelope(Dlna.AVT, "SetAVTransportURI", listOf("InstanceID" to "0", "CurrentURIMetaData" to "<a>&amp;</a>"))
        assertTrue(env.contains("<CurrentURIMetaData>&lt;a&gt;&amp;amp;&lt;/a&gt;</CurrentURIMetaData>"))
    }

    // The desktop's DIDL goldens (CA-07, CK/fixtures/cast/dlna-didl.json): same metadata and envelope on both apps.
    @Test
    fun didlGoldensSharedWithDesktop() {
        val cases = Json.parseToJsonElement(fx("dlna-didl.json")).jsonObject.getValue("cases").jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        for (c in cases) {
            val i = c.getValue("input").jsonObject
            fun str(k: String) = i[k]?.jsonPrimitive?.contentOrNull
            val url = str("url")!!
            val didl = Dlna.didl(
                str("title")!!, i.getValue("audio").jsonPrimitive.boolean, url, str("mime")!!, str("flags"),
                i["durationSec"]?.jsonPrimitive?.double?.let { (it * 1000).toLong() }, str("subtitleUrl"),
            )
            val name = c.getValue("name").jsonPrimitive.content
            assertEquals(name, c.getValue("didl").jsonPrimitive.content, didl)
            val env = Dlna.envelope(Dlna.AVT, "SetAVTransportURI", listOf("InstanceID" to "0", "CurrentURI" to url, "CurrentURIMetaData" to didl))
            assertEquals(name, c.getValue("setAVTransportURI").jsonPrimitive.content, env)
        }
    }

    @Test
    fun ssdpReplies() {
        val ok = "HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: http://192.168.1.20:8080/desc.xml\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n"
        assertEquals("http://192.168.1.20:8080/desc.xml", Ssdp.location(ok, "192.168.1.20"))
        // LOCATION on another host than the reply's source, off the LAN, or not a 200: ignored.
        assertNull(Ssdp.location(ok, "192.168.1.21"))
        assertNull(Ssdp.location(ok.replace("192.168.1.20", "8.8.8.8"), "8.8.8.8"))
        assertNull(Ssdp.location(ok.replace("192.168.1.20", "100.100.1.1"), "100.100.1.1"))
        assertNull(Ssdp.location(ok.replace("HTTP/1.1 200 OK", "NOTIFY * HTTP/1.1"), "192.168.1.20"))
        assertTrue(Ssdp.M_SEARCH.contains("MAN: \"ssdp:discover\"") && Ssdp.M_SEARCH.endsWith("\r\n\r\n"))
    }

    // A renderer answering SOAP like mock-dlna.mjs: sony (701 while PLAYING) and samsung (716 without DLNA.ORG flags).
    private lateinit var srv: MockWebServer
    private val calls = CopyOnWriteArrayList<RecordedRequest>()
    private var state = "PLAYING"
    private var profile = "generic"
    private var lying = false

    private fun reply(action: String, values: String = "") =
        """<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">$values</u:${action}Response></s:Body></s:Envelope>"""

    private fun startRenderer() {
        srv = MockWebServer()
        srv.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                calls += request
                if (request.method == "GET") return MockResponse.Builder().body(fx("dlna-desc-$profile.xml")).build()
                val action = request.headers["SOAPACTION"].orEmpty().substringAfter('#').trim('"')
                val body = request.body?.utf8().orEmpty()
                fun fault(code: Int) = MockResponse.Builder().code(500).body(fx("dlna-fault-$code.xml")).build()
                return when (action) {
                    "GetTransportInfo" -> MockResponse.Builder().body(reply(action, "<CurrentTransportState>${if (lying) "STOPPED" else state}</CurrentTransportState>")).build()
                    "Stop" -> { state = "STOPPED"; MockResponse.Builder().body(reply(action)).build() }
                    "SetAVTransportURI" -> when {
                        profile == "sony" && state == "PLAYING" -> fault(701)
                        profile == "samsung" && !body.contains("DLNA.ORG_OP") -> fault(716)
                        else -> MockResponse.Builder().body(reply(action)).build()
                    }
                    "Play" -> { state = "PLAYING"; MockResponse.Builder().body(reply(action)).build() }
                    else -> MockResponse.Builder().body(reply(action)).build()
                }
            }
        }
        srv.start()
    }

    @After
    fun tearDown() {
        if (::srv.isInitialized) srv.close()
        Core.api = null
    }

    private fun renderer() = runBlocking { DlnaClient().describe(srv.url("/desc.xml").toString())!! }

    private fun actions() = calls.mapNotNull { it.headers["SOAPACTION"]?.substringAfter('#')?.trim('"') }

    @Test
    fun loadRecoversFrom716WithFlagsAndNeverSendsServerAuth() = runBlocking {
        profile = "samsung"
        startRenderer()
        // Worst case: the active server shares the renderer's origin. The renderer client still adds no auth.
        Core.api = Api(Server("s", "S", srv.url("/").toString().trimEnd('/'), "jellyfin"), "phone", "secret-token", "u1")
        val r = renderer()
        DlnaClient().load(r, "http://192.168.1.5/v.mp4") { flagged -> Dlna.didl("T", false, "http://192.168.1.5/v.mp4", "video/mp4", Dlna.FLAGS_DIRECT.takeIf { flagged }, null) }
        assertEquals(listOf("GetTransportInfo", "Stop", "SetAVTransportURI", "SetAVTransportURI", "Play"), actions())
        assertTrue(calls.filter { it.headers["SOAPACTION"] != null }.last { it.headers["SOAPACTION"]!!.contains("SetAVTransportURI") }.body!!.utf8().contains("DLNA.ORG_OP=01"))
        for (c in calls) {
            assertNull(c.headers["Authorization"])
            assertNull(c.headers["X-Emby-Authorization"])
            assertNull(c.headers["X-Emby-Token"])
        }
        val soap = calls.first { it.headers["SOAPACTION"] != null }
        assertEquals("\"urn:schemas-upnp-org:service:AVTransport:1#GetTransportInfo\"", soap.headers["SOAPACTION"])
        assertTrue(soap.headers["Content-Type"]!!.startsWith("text/xml"))
        assertTrue(soap.body!!.utf8().contains("<InstanceID>0</InstanceID>"))
    }

    @Test
    fun loadRecoversFrom701() = runBlocking {
        profile = "sony"
        startRenderer()
        val r = renderer()
        // A renderer that says STOPPED while it still plays: no Stop first, so SetAVTransportURI gets 701.
        lying = true
        DlnaClient().load(r, "http://192.168.1.5/v.mkv") { "<DIDL-Lite/>" }
        assertEquals(listOf("GetTransportInfo", "SetAVTransportURI", "Stop", "SetAVTransportURI", "Play"), actions())
    }
}
