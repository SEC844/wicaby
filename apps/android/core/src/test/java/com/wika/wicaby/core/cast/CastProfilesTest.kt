package com.wika.wicaby.core.cast

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.kxml2.io.KXmlParser

// cast/CastProfiles.kt (cast spec §2.6.5–6) on the recorded Sinks of CK/fixtures/cast/: the same rules as the
// desktop's D/main/cast/profiles.ts, of which it is a port, and its goldens.
class CastProfilesTest {
    // CK/fixtures/cast/, copied onto the test classpath by :core's copyCastFixtures (processTestResources).
    private fun fx(name: String) = javaClass.getResource("/cast/$name")!!.readText()

    @Before
    fun parser() {
        newXmlParser = { KXmlParser() }
    }

    private fun sink(profile: String) = Dlna.soapValues(fx("dlna-protocolinfo-$profile.xml"))["Sink"]!!

    private fun JsonObject.list(key: String) = getValue(key).jsonArray.map { it.jsonObject }
    private fun JsonObject.str(key: String) = get(key)?.jsonPrimitive?.content

    private fun directPlay(p: JsonObject) = p.list("DirectPlayProfiles").map { it.str("Type") + ":" + it.str("Container") }
    private fun subs(p: JsonObject) = p.list("SubtitleProfiles").map { listOfNotNull(it.str("Format"), it.str("Method"), it.str("Container")).joinToString("/") }

    // The desktop's goldens (CA-07, CK/fixtures/cast/profiles.json): both apps ask the server for the same streams.
    @Test
    fun goldensSharedWithDesktop() {
        val g = Json.parseToJsonElement(fx("profiles.json")).jsonObject
        fun sinkOf(c: JsonObject) = c["sinkFixture"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotEmpty)?.let { sink(it.removePrefix("dlna-protocolinfo-").removeSuffix(".xml")) }.orEmpty()
        val dlna = g.getValue("dlna").jsonArray.map { it.jsonObject }
        assertTrue(dlna.size >= 3)
        for (c in dlna) assertEquals(c.str("name"), c.getValue("expected"), CastProfiles.dlna(sinkOf(c), c.str("model").orEmpty()))
        for (c in g.getValue("mimes").jsonArray.map { it.jsonObject }) {
            assertEquals(c.toString(), c.str("expected"), CastProfiles.mime(c.str("container")!!, c.getValue("audio").jsonPrimitive.boolean, sinkOf(c)))
        }
        for (c in g.getValue("cast").jsonArray.map { it.jsonObject }) {
            val prefs = c["prefs"]?.jsonObject
            fun pref(k: String) = prefs?.get(k)?.jsonPrimitive?.boolean == true
            assertEquals(c.toString(), c.getValue("expected"), CastProfiles.cast(c.str("model").orEmpty(), c.str("server") == "jellyfin", pref("allowHevc"), pref("dolby")))
        }
    }

    @Test
    fun dlnaFromSinks() {
        val generic = CastProfiles.dlna(sink("generic"), "Generic Renderer")
        assertEquals("Wicaby DLNA (Generic Renderer)", generic.str("Name"))
        assertEquals("40000000", generic.str("MaxStreamingBitrate"))
        assertEquals(listOf("Video:mp4,m4v,mkv,ts,avi", "Audio:mp3", "Audio:flac", "Audio:m4a"), directPlay(generic))
        val video = generic.list("DirectPlayProfiles")[0]
        assertEquals("h264,hevc", video.str("VideoCodec"))
        assertEquals("aac,ac3,eac3,mp3", video.str("AudioCodec"))
        assertEquals(listOf("srt/External", "pgs/Encode", "pgssub/Encode", "dvdsub/Encode", "dvbsub/Encode", "vobsub/Encode"), subs(generic))

        // Sony: no avi in its Sink; subtitles burnt in unless embedded in a direct-streamed MKV.
        val sony = CastProfiles.dlna(sink("sony"), "BRAVIA (mock profile)")
        assertEquals(listOf("Video:mp4,m4v,mkv,ts", "Audio:mp3", "Audio:flac", "Audio:m4a"), directPlay(sony))
        val s = subs(sony)
        assertTrue(s.containsAll(listOf("srt/Embed/mkv", "pgs/Embed/mkv", "srt/Encode", "ass/Encode")))
        assertFalse(s.any { it.contains("External") })
        // The manufacturer alone also makes it a Sony (real model names are "KD-65X80K").
        assertTrue(subs(CastProfiles.dlna(sink("sony"), "KD-65X80K", sony = true)).contains("srt/Encode"))

        // No Sink (no ConnectionManager): the common four.
        assertEquals(listOf("Video:mp4,m4v,ts", "Audio:mp3", "Audio:m4a"), directPlay(CastProfiles.dlna("", "")))
        assertEquals("Wicaby DLNA", CastProfiles.dlna("", "").str("Name"))
    }

    @Test
    fun dlnaTranscodeIsNeverHls() {
        for (profile in listOf("generic", "sony", "samsung")) {
            val t = CastProfiles.dlna(sink(profile), profile).list("TranscodingProfiles")
            assertEquals(listOf("ts", "mp3"), t.map { it.str("Container") })
            assertTrue(t.all { it.str("Protocol") == "http" && it.str("Context") == "Streaming" })
            assertEquals("aac,ac3", t[0].str("AudioCodec"))
        }
    }

    @Test
    fun mimeInTheRenderersSpelling() {
        assertEquals("video/x-mkv", CastProfiles.mime("mkv", false, sink("samsung")))
        assertEquals("video/x-matroska", CastProfiles.mime("mkv", false, sink("generic")))
        assertEquals("video/mpeg", CastProfiles.mime("ts", false, sink("sony")))
        assertEquals("video/mpeg", CastProfiles.mime("mpegts", false, ""))
        assertEquals("audio/x-flac", CastProfiles.mime("flac", true, sink("sony")))
        assertEquals("audio/flac", CastProfiles.mime("flac", true, ""))
        assertEquals("video/mp4", CastProfiles.mime("mp4,m4v", false, sink("generic")))
        assertTrue(CastProfiles.known("mp4") && CastProfiles.known("m4v") && !CastProfiles.known("mov"))
        assertEquals(listOf("video/mp4", "video/x-mkv", "video/x-matroska"), CastProfiles.sinkMimes(sink("samsung")).take(3))
    }

    @Test
    fun castPerModel() {
        fun level(p: JsonObject) = p.list("CodecProfiles")[0].list("Conditions")[0].str("Value")
        fun video(p: JsonObject) = p.list("DirectPlayProfiles")[0].str("VideoCodec")

        val hd = CastProfiles.cast("Chromecast", jellyfin = false)
        assertEquals("41", level(hd))
        assertEquals("h264,vp8,vp9", video(hd))
        assertEquals("aac,mp3,opus,vorbis,flac", hd.list("DirectPlayProfiles")[0].str("AudioCodec"))
        assertFalse(directPlay(hd).any { it.contains("mkv") })
        assertEquals(listOf("ts", "mp3"), hd.list("TranscodingProfiles").map { it.str("Container") })
        assertEquals("hls", hd.list("TranscodingProfiles")[0].str("Protocol"))
        assertEquals("vtt/External", subs(hd)[0])

        val ultra = CastProfiles.cast("Chromecast Ultra", jellyfin = true)
        assertEquals("51", level(ultra))
        assertEquals("h264,hevc,vp8,vp9", video(ultra))
        // HEVC in fMP4 segments on Jellyfin first; Emby transcodes it to h264.
        assertEquals(listOf("mp4", "ts", "mp3"), ultra.list("TranscodingProfiles").map { it.str("Container") })
        assertEquals(listOf("ts", "mp3"), CastProfiles.cast("Chromecast Ultra", jellyfin = false).list("TranscodingProfiles").map { it.str("Container") })

        assertEquals("h264,hevc,av1,vp8,vp9", video(CastProfiles.cast("Google TV Streamer", jellyfin = false)))
        assertEquals("h264,hevc,vp8,vp9", video(CastProfiles.cast("Chromecast", jellyfin = false, allowHevc = true)))
        assertTrue(CastProfiles.cast("Chromecast", false, dolby = true).list("DirectPlayProfiles")[0].str("AudioCodec")!!.endsWith(",ac3,eac3"))
    }
}
