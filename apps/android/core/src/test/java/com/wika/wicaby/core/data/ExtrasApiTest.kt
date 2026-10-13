package com.wika.wicaby.core.data

import com.wika.wicaby.core.player.ExternalPlayer
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

// Api.specialFeatures (Bonus row) and mediaSegments on both flavours, ExternalPlayer.streamUrl and progress.
class ExtrasApiTest {
    private lateinit var srv: MockWebServer

    @Before
    fun setUp() {
        srv = MockWebServer().apply { start() }
    }

    @After
    fun tearDown() = srv.close()

    private fun api(kind: String) = Api(Server("srv", "Server", srv.url("/").toString().trimEnd('/'), kind), "dev", "tok", "u1")

    private fun reply(code: Int, body: String = "") = srv.enqueue(MockResponse.Builder().code(code).body(body).build())

    @Test
    fun jellyfinBonusFallsBackToTheOldRoute() = runBlocking {
        reply(404)
        reply(200, """[{"Id":"x1","Name":"Making-of","Type":"Video"}]""")
        assertEquals(listOf("x1"), api("jellyfin").specialFeatures("m1").map { it.id })
        val modern = srv.takeRequest().url
        assertEquals("/Items/m1/SpecialFeatures", modern.encodedPath)
        assertEquals("u1", modern.queryParameter("userId"))
        assertEquals("/Users/u1/Items/m1/SpecialFeatures", srv.takeRequest().url.encodedPath)
    }

    @Test
    fun embyWithoutTheRouteHasNoBonus() = runBlocking {
        reply(404)
        assertEquals(emptyList<Item>(), api("emby").specialFeatures("m1"))
        assertEquals("/emby/Users/u1/Items/m1/SpecialFeatures", srv.takeRequest().url.encodedPath)
    }

    @Test
    fun mediaSegmentsAsksForEverySkippableType() = runBlocking {
        reply(200, """{"Items":[{"Type":"Recap","StartTicks":0,"EndTicks":10}]}""")
        assertEquals("Recap", api("jellyfin").mediaSegments("e1").single().type)
        val types = srv.takeRequest().url.queryParameterValues("includeSegmentTypes")
        assertEquals(listOf("Intro", "Outro", "Recap", "Preview", "Commercial"), types)
    }

    @Test
    fun externalStreamCarriesTheFlavoursKey() {
        val emby = ExternalPlayer.streamUrl(api("emby"), "m1", "src2").toHttpUrl()
        assertEquals("/emby/Videos/m1/stream", emby.encodedPath)
        assertEquals("tok", emby.queryParameter("api_key"))
        assertEquals("src2", emby.queryParameter("MediaSourceId"))
        assertEquals("true", emby.queryParameter("static"))
        // Jellyfin 10.11+ rejects api_key unless legacy authorization is on.
        val jf = ExternalPlayer.streamUrl(api("jellyfin"), "m1", null).toHttpUrl()
        assertEquals("tok", jf.queryParameter("ApiKey"))
        assertNull(jf.queryParameter("api_key"))
        assertNull(jf.queryParameter("MediaSourceId"))
    }

    @Test
    fun externalPlayerGetsTheExternalTextSubtitles() {
        val src = MediaSource(
            id = "src2", defaultSubtitleStreamIndex = 4,
            mediaStreams = listOf(
                MediaStream(index = 2, type = "Subtitle", codec = "subrip"), // embedded: already in the file
                MediaStream(index = 3, type = "Subtitle", codec = "pgssub", isExternal = true), // image: left out
                MediaStream(index = 4, type = "Subtitle", codec = "SubRip", isExternal = true, displayTitle = "Français"),
                MediaStream(index = 5, type = "Subtitle", codec = "ass", isExternal = true, language = "eng"),
                MediaStream(index = 6, type = "Audio", codec = "aac", isExternal = true),
            ),
        )
        val subs = ExternalPlayer.subtitles(api("emby"), "m1", src)
        assertEquals(listOf("Français", "eng"), subs.map { it.name })
        assertEquals(listOf(true, false), subs.map { it.default })
        val u = subs[0].url.toHttpUrl()
        assertEquals("/emby/Videos/m1/src2/Subtitles/4/Stream.srt", u.encodedPath)
        assertEquals("tok", u.queryParameter("api_key"))
        val jf = ExternalPlayer.subtitles(api("jellyfin"), "m1", src)[1].url.toHttpUrl()
        assertEquals("/Videos/m1/src2/Subtitles/5/Stream.ass", jf.encodedPath)
        assertEquals("tok", jf.queryParameter("ApiKey"))
        assertEquals(0, ExternalPlayer.subtitles(api("emby"), "m1", null).size)
    }

    @Test
    fun externalPlayerProgress() {
        // MX Player "played to the end", even far from 90 %.
        assertEquals(0L to true, ExternalPlayer.progress(10_000, 100_000, 0, completed = true))
        // 90 % rule: watched, no resume point.
        assertEquals(0L to true, ExternalPlayer.progress(95_000, 100_000, 0, completed = false))
        // Mid-file: resume where it stopped.
        assertEquals(40_000L to false, ExternalPlayer.progress(40_000, 100_000, 0, completed = false))
        // No returned duration: the item's runtime decides (95 s of 100 s is watched; of 1000 s it resumes).
        assertEquals(0L to true, ExternalPlayer.progress(95_000, null, 100_000, completed = false))
        assertEquals(95_000L to false, ExternalPlayer.progress(95_000, 0, 1_000_000, completed = false))
    }
}
