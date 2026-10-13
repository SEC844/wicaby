package com.wika.wicaby.core.cast

import android.util.Xml
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.xmlpull.v1.XmlPullParser
import java.io.IOException
import java.io.StringReader
import java.util.Locale
import java.util.concurrent.TimeUnit

// A DLNA/UPnP MediaRenderer found by SSDP or the debug seed (cast spec CA-08). Control URLs are resolved and
// checked to stay on the description's host and port.
data class Renderer(
    val udn: String,
    val name: String,
    val model: String,
    val manufacturer: String,
    val location: String,
    val avTransport: String,
    val renderingControl: String?,
    val connectionManager: String?,
) {
    val key get() = "d:" + udn.removePrefix("uuid:")
    val sony get() = CastProfiles.isSony("$manufacturer $model")

    // §2.3 synthetic commands: transport is never gated; tracks restart the stream; volume needs RenderingControl.
    fun target() = CastTarget(
        key, CastTarget.Kind.Dlna, name, model, deviceId = udn.removePrefix("uuid:"),
        commands = setOf("SetAudioStreamIndex", "SetSubtitleStreamIndex") + if (renderingControl != null) setOf("SetVolume", "Mute", "Unmute", "ToggleMute") else emptySet(),
        mediaTypes = setOf("Audio", "Video"),
    )
}

class UpnpException(val code: Int, message: String) : IOException("UPnP $code: $message")

// android.util.Xml on the device; the JVM tests swap in kxml2 (the same parser Android ships).
internal var newXmlParser: () -> XmlPullParser = { Xml.newPullParser() }

object Dlna {
    const val AVT = "AVTransport"
    const val RC = "RenderingControl"
    const val CM = "ConnectionManager"
    const val DESC_CAP = 64 * 1024
    const val SOAP_CAP = 16 * 1024
    const val FLAGS_DIRECT = "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"
    const val FLAGS_TRANSCODE = "DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=01700000000000000000000000000000"

    // Pull parsing with no DTD at all (§6): a document that declares one is refused before parsing.
    private fun parser(xml: String): XmlPullParser {
        if (xml.contains("<!DOCTYPE", true) || xml.contains("<!ENTITY", true)) throw IOException("DTD refused")
        return newXmlParser().apply {
            runCatching { setFeature(XmlPullParser.FEATURE_PROCESS_DOCDECL, false) }
            setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
            setInput(StringReader(xml))
        }
    }

    // Leaf texts by local name (the first of each), and the (serviceType, controlURL) of every <service>.
    private fun walk(xml: String): Pair<Map<String, String>, List<Pair<String, String>>> {
        val p = parser(xml)
        val first = HashMap<String, String>()
        val services = ArrayList<Pair<String, String>>()
        var type: String? = null
        var control: String? = null
        var tag = ""
        while (true) {
            when (p.next()) {
                XmlPullParser.START_TAG -> {
                    tag = p.name
                    if (tag == "service") { type = null; control = null }
                }
                XmlPullParser.TEXT -> {
                    val t = p.text.trim()
                    if (t.isNotEmpty()) when (tag) {
                        "serviceType" -> type = t
                        "controlURL" -> control = t
                        else -> if (tag !in first) first[tag] = t
                    }
                }
                XmlPullParser.END_TAG -> {
                    val t = type
                    val c = control
                    if (p.name == "service" && t != null && c != null) services += t to c
                    tag = ""
                }
                XmlPullParser.END_DOCUMENT -> return first to services
            }
        }
    }

    // The description at [location]: a MediaRenderer with an AVTransport, every control URL on LOCATION's host and port
    // (resolved against URLBase, else LOCATION). null for anything else (a forged reply cannot point the sender elsewhere).
    fun parseDescription(xml: String, location: String): Renderer? {
        val loc = location.toHttpUrlOrNull() ?: return null
        val (first, services) = runCatching { walk(xml) }.getOrNull() ?: return null
        if (first["deviceType"]?.contains(":device:MediaRenderer:") != true) return null
        val base = first["URLBase"]?.toHttpUrlOrNull() ?: loc
        fun control(name: String): String? {
            val raw = services.firstOrNull { it.first.contains(":service:$name:") }?.second ?: return null
            val u = base.resolve(raw) ?: return null
            return u.toString().takeIf { u.host == loc.host && u.port == loc.port && u.scheme == "http" }
        }
        return Renderer(
            udn = first["UDN"] ?: return null,
            name = first["friendlyName"] ?: return null,
            model = first["modelName"].orEmpty(),
            manufacturer = first["manufacturer"].orEmpty(),
            location = location,
            avTransport = control(AVT) ?: return null,
            renderingControl = control(RC),
            connectionManager = control(CM),
        )
    }

    // A SOAP reply's output arguments by name; a fault throws its UPnPError code.
    fun soapValues(xml: String): Map<String, String> {
        val values = walk(xml).first
        values["errorCode"]?.let { throw UpnpException(it.toIntOrNull() ?: 0, values["errorDescription"].orEmpty()) }
        return values
    }

    fun envelope(service: String, action: String, args: List<Pair<String, String>>): String = buildString {
        append("""<?xml version="1.0" encoding="utf-8"?>""").append('\n')
        append("""<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>""")
        append("""<u:$action xmlns:u="urn:schemas-upnp-org:service:$service:1">""")
        for ((k, v) in args) append("<$k>").append(escape(v)).append("</$k>")
        append("</u:$action></s:Body></s:Envelope>")
    }

    fun escape(s: String) = buildString(s.length) {
        for (c in s) when (c) {
            '&' -> append("&amp;"); '<' -> append("&lt;"); '>' -> append("&gt;"); '"' -> append("&quot;"); '\'' -> append("&apos;")
            else -> append(c)
        }
    }

    // DIDL-Lite for one item. Every value is escaped here; the whole document is escaped again inside the envelope.
    // A text subtitle goes three ways at once (Samsung sec:CaptionInfoEx right after <res>, a text/srt <res>, and
    // pv:subtitleFileUri); renderers ignore the ones they do not know.
    fun didl(title: String, audio: Boolean, url: String, mime: String, flags: String?, durationMs: Long?, subtitleUrl: String? = null): String = buildString {
        append("""<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" """)
        append("""xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:sec="http://www.sec.co.kr/" xmlns:pv="http://www.pv.com/pvns/">""")
        append("""<item id="0" parentID="-1" restricted="1">""")
        append("<dc:title>").append(escape(title)).append("</dc:title>")
        append("<upnp:class>").append(if (audio) "object.item.audioItem.musicTrack" else "object.item.videoItem").append("</upnp:class>")
        append("""<res protocolInfo="http-get:*:""").append(escape(mime)).append(':').append(escape(flags ?: "*")).append('"')
        // Whole seconds, ".000" (the desktop's goldens, CK/fixtures/cast/dlna-didl.json).
        durationMs?.takeIf { it > 0 }?.let { append(""" duration="""").append(hms(it / 1000 * 1000, millis = true)).append('"') }
        subtitleUrl?.let { append(""" pv:subtitleFileUri="""").append(escape(it)).append("""" pv:subtitleFileType="srt"""") }
        append('>').append(escape(url)).append("</res>")
        subtitleUrl?.let {
            append("""<sec:CaptionInfoEx sec:type="srt">""").append(escape(it)).append("</sec:CaptionInfoEx>")
            append("""<res protocolInfo="http-get:*:text/srt:*">""").append(escape(it)).append("</res>")
        }
        append("</item></DIDL-Lite>")
    }

    // "h:mm:ss.000" (DIDL duration) or "hh:mm:ss" (Seek target).
    fun hms(ms: Long, millis: Boolean = false): String {
        val t = ms.coerceAtLeast(0)
        val s = t / 1000
        return if (millis) "%d:%02d:%02d.%03d".format(Locale.ROOT, s / 3600, s / 60 % 60, s % 60, t % 1000)
        else "%02d:%02d:%02d".format(Locale.ROOT, s / 3600, s / 60 % 60, s % 60)
    }

    // "0:01:02", "00:01:02.500" -> ms; null for NOT_IMPLEMENTED and the like.
    fun parseHms(s: String?): Long? {
        val m = Regex("""^(\d+):([0-5]?\d):([0-5]?\d)(\.\d+)?$""").find(s?.trim() ?: return null) ?: return null
        val (h, mi, se, frac) = m.destructured
        return ((h.toLong() * 3600 + mi.toLong() * 60 + se.toLong()) * 1000) + (frac.drop(1).take(3).padEnd(3, '0').toIntOrNull() ?: 0)
    }
}

// SOAP and descriptions on the renderer. Its own OkHttpClient, never derived from Core.http: renderers must never
// get the server's Authorization header (cast spec CA-08), and nothing here follows redirects.
class DlnaClient(private val http: OkHttpClient = rendererHttp) {
    companion object {
        val rendererHttp: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .followRedirects(false).followSslRedirects(false)
                .connectTimeout(3, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS).callTimeout(5, TimeUnit.SECONDS)
                .build()
        }
        private val XML = "text/xml; charset=\"utf-8\"".toMediaType()
    }

    private fun Response.capped(cap: Int): String {
        val src = body.source()
        if (src.request(cap + 1L)) throw IOException("reply over $cap bytes")
        return src.buffer.readUtf8()
    }

    suspend fun describe(location: String): Renderer? = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(location).header("Accept", "text/xml").build()
        val call = http.newCall(req).apply { timeout().timeout(3, TimeUnit.SECONDS) }
        call.execute().use { res -> if (res.isSuccessful) Dlna.parseDescription(res.capped(Dlna.DESC_CAP), location) else null }
    }

    suspend fun call(url: String, service: String, action: String, vararg args: Pair<String, String>): Map<String, String> = withContext(Dispatchers.IO) {
        val instance = if (service == Dlna.CM) emptyList() else listOf("InstanceID" to "0")
        val req = Request.Builder().url(url)
            .header("SOAPACTION", "\"urn:schemas-upnp-org:service:$service:1#$action\"")
            .header("Pragma", "no-cache")
            .post(Dlna.envelope(service, action, instance + args).toRequestBody(XML))
            .build()
        http.newCall(req).execute().use { res ->
            val text = res.capped(Dlna.SOAP_CAP)
            // A fault comes with 500 and an UPnPError body.
            val values = Dlna.soapValues(text)
            if (!res.isSuccessful) throw IOException("HTTP ${res.code} on $service#$action")
            values
        }
    }

    suspend fun sink(r: Renderer): String =
        r.connectionManager?.let { runCatching { call(it, Dlna.CM, "GetProtocolInfo")["Sink"] }.getOrNull() }.orEmpty()

    suspend fun transportState(r: Renderer): String = call(r.avTransport, Dlna.AVT, "GetTransportInfo")["CurrentTransportState"].orEmpty()

    suspend fun position(r: Renderer): Map<String, String> = call(r.avTransport, Dlna.AVT, "GetPositionInfo")

    suspend fun play(r: Renderer) = call(r.avTransport, Dlna.AVT, "Play", "Speed" to "1")

    suspend fun pause(r: Renderer) = call(r.avTransport, Dlna.AVT, "Pause")

    suspend fun stop(r: Renderer) = call(r.avTransport, Dlna.AVT, "Stop")

    suspend fun seek(r: Renderer, ms: Long) = call(r.avTransport, Dlna.AVT, "Seek", "Unit" to "REL_TIME", "Target" to Dlna.hms(ms))

    suspend fun setVolume(r: Renderer, v: Int) =
        call(r.renderingControl ?: throw UpnpException(401, "no RenderingControl"), Dlna.RC, "SetVolume", "Channel" to "Master", "DesiredVolume" to v.coerceIn(0, 100).toString())

    suspend fun setMute(r: Renderer, on: Boolean) =
        call(r.renderingControl ?: throw UpnpException(401, "no RenderingControl"), Dlna.RC, "SetMute", "Channel" to "Master", "DesiredMute" to if (on) "1" else "0")

    // (volume, muted), or null without RenderingControl.
    suspend fun volume(r: Renderer): Pair<Int?, Boolean>? {
        val rc = r.renderingControl ?: return null
        val v = runCatching { call(rc, Dlna.RC, "GetVolume", "Channel" to "Master")["CurrentVolume"]?.toIntOrNull() }.getOrNull()
        val m = runCatching { call(rc, Dlna.RC, "GetMute", "Channel" to "Master")["CurrentMute"] }.getOrNull()
        return v to (m == "1" || m.equals("true", true))
    }

    // Stop if busy, SetAVTransportURI, Play. 714/716 (MIME or resource refused): once more with the DLNA.ORG flags;
    // 701 (transition not available): Stop, then once more. [didl] builds the metadata with or without the flags.
    suspend fun load(r: Renderer, url: String, didl: (flagged: Boolean) -> String) {
        val state = runCatching { transportState(r) }.getOrDefault("")
        if (state == "PLAYING" || state == "PAUSED_PLAYBACK" || state == "TRANSITIONING") runCatching { stop(r) }
        suspend fun set(flagged: Boolean) = call(r.avTransport, Dlna.AVT, "SetAVTransportURI", "CurrentURI" to url, "CurrentURIMetaData" to didl(flagged))
        try {
            set(false)
        } catch (e: UpnpException) {
            when (e.code) {
                714, 716 -> set(true)
                701 -> { runCatching { stop(r) }; set(false) }
                else -> throw e
            }
        }
        play(r)
    }
}
