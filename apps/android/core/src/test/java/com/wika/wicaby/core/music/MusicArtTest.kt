package com.wika.wicaby.core.music

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.json
import com.wika.wicaby.core.data.posterArt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

// Music covers (music-feishin-navidrome spec §4.A): the vectors desktop's tools/checks/music-art-check.mjs runs, through
// MusicArt.kt, then the owner's field bug against a mock Emby: an album without a Primary whose tracks have their own.
class MusicArtTest {
    private val v = json.parseToJsonElement(File("../../../tools/checks/fixtures/music/cover-vectors.json").readText()).jsonObject
    private fun section(name: String) = v[name]!!.jsonArray.map { it.jsonObject }
    private lateinit var srv: MockWebServer

    @Before
    fun setUp() {
        MusicArt.clear()
        srv = MockWebServer().apply { start() }
    }

    @After
    fun tearDown() = srv.close()

    private fun api(kind: String) = Api(Server("srv", "Server", srv.url("/").toString().trimEnd('/'), kind), "dev", "tok", "u1")

    @Test
    fun coverVectors() {
        for (c in section("art")) {
            val item = json.decodeFromJsonElement(Item.serializer(), c["item"]!!)
            val want = c["expect"]!!
            val got = MusicArt.plan(item)
            val name = c["name"]!!.jsonPrimitive.content
            when {
                want is JsonNull -> assertNull(name, got)
                "ref" in want.jsonObject -> want.jsonObject["ref"]!!.jsonObject.let { assertEquals(name, MusicArt.Plan.Image(MusicArt.Ref(it["id"]!!.jsonPrimitive.content, it["tag"]!!.jsonPrimitive.content)), got) }
                else -> assertEquals(name, MusicArt.Plan.Lookup(want.jsonObject["lookup"]!!.jsonPrimitive.content), got)
            }
        }
        for (c in section("queries")) {
            val got = MusicArt.lookupQuery(c["kind"]!!.jsonPrimitive.content, c["id"]!!.jsonPrimitive.content, c["emby"]!!.jsonPrimitive.boolean).associate { (k, x) -> k to x.toString() }
            assertEquals(c.toString(), c["query"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }, got)
        }
        for (c in section("placeholder")) {
            val name = c["name"]!!.jsonPrimitive.content
            assertEquals("initials of \"$name\"", c["initials"]!!.jsonPrimitive.content, MusicArt.initials(name))
            assertEquals("hue of \"$name\"", c["hue"]!!.jsonPrimitive.int, MusicArt.hue(name))
        }
        for (c in section("tile")) {
            val rgb = c["rgb"]!!.jsonArray.map { it.jsonPrimitive.int }
            assertEquals("tile ${c["hue"]}", (rgb[0] shl 16) or (rgb[1] shl 8) or rgb[2], MusicArt.tileRgb(c["hue"]!!.jsonPrimitive.int))
        }
        for (c in section("size")) {
            val css = c["css"]!!.jsonPrimitive.content.toFloat()
            val dpr = c["dpr"]!!.jsonPrimitive.content.toFloat()
            assertEquals(c.toString(), c["px"]!!.jsonPrimitive.int, MusicArt.size(css * dpr))
        }
        for (c in section("colour")) {
            val px = c["runs"]!!.jsonArray.flatMap { run ->
                val (r, g, b, a, n) = (run as JsonArray).map { it.jsonPrimitive.int }
                List(n) { (a shl 24) or (r shl 16) or (g shl 8) or b }
            }.toIntArray()
            val want = c["colour"]!!.let { if (it is JsonNull) null else it.jsonPrimitive.content }
            assertEquals(c["name"]!!.jsonPrimitive.content, want, MusicArt.dominant(px)?.let { "#%06x".format(it) })
        }
    }

    // The field bug: Emby keeps no Primary on the album, its tracks have theirs. The card used to get null (no cover);
    // it now gets a MusicCover, which one lookup turns into the first track's image.
    @Test
    fun albumWithoutPrimaryBorrowsItsFirstTrack() = runBlocking {
        val emby = api("emby")
        val album = Item("al1", "Brume", "MusicAlbum")
        assertTrue(emby.posterArt(album, 300) is MusicCover)
        srv.enqueue(MockResponse.Builder().body("""{"Items":[{"Id":"t1","Type":"Audio","ImageTags":{"Primary":"tt"}}],"TotalRecordCount":1}""").build())
        assertEquals(MusicArt.Ref("t1", "tt"), MusicArt.resolve(emby, album))
        srv.takeRequest().let {
            assertEquals("/emby/Users/u1/Items", it.url.encodedPath)
            assertEquals("al1", it.url.queryParameter("ParentId"))
            assertEquals("Audio", it.url.queryParameter("IncludeItemTypes"))
            assertEquals("Primary", it.url.queryParameter("ImageTypes"))
            assertEquals("1", it.url.queryParameter("Limit"))
        }
        // Cached: a second card asks nothing (no response queued: a request would hang).
        assertEquals(MusicArt.Ref("t1", "tt"), MusicArt.resolve(emby, album))
        assertEquals(1, srv.requestCount)
        // An album with its own cover never looks anything up; a track is sized from the buckets, square.
        val own = emby.posterArt(album.copy(imageTags = mapOf("Primary" to "p")), 300) as String
        assertTrue(own, own.contains("/Items/al1/Images/Primary") && own.contains("maxWidth=320") && own.contains("maxHeight=320"))
        assertEquals(1, srv.requestCount)
    }

    @Test
    fun artistWithoutImageShowsItsFirstAlbum() = runBlocking {
        val jf = api("jellyfin")
        srv.enqueue(MockResponse.Builder().body("""{"Items":[{"Id":"al9","Type":"MusicAlbum","ImageTags":{"Primary":"a9"}}],"TotalRecordCount":1}""").build())
        assertEquals(MusicArt.Ref("al9", "a9"), MusicArt.resolve(jf, Item("ar1", "Night Arcade", "MusicArtist")))
        srv.takeRequest().let {
            assertEquals("ar1", it.url.queryParameter("AlbumArtistIds"))
            assertEquals("MusicAlbum", it.url.queryParameter("IncludeItemTypes"))
            assertEquals("Descending", it.url.queryParameter("SortOrder"))
        }
    }

    @Test
    fun lookupsAreCachedNegativesKeptFailuresRetriedThreeAtATime() = runBlocking {
        val calls = AtomicInteger()
        val live = AtomicInteger()
        var peak = 0
        var fail = true
        val api = api("emby")
        val lookup: suspend (String, Item) -> Item? = { _, it ->
            calls.incrementAndGet()
            synchronized(this@MusicArtTest) { peak = maxOf(peak, live.incrementAndGet()) }
            delay(20)
            live.decrementAndGet()
            when {
                it.id == "flaky" && fail -> throw java.io.IOException("offline")
                it.id == "empty" -> null
                it.type == "MusicArtist" -> Item("of-${it.id}", type = "MusicAlbum")
                else -> Item("t-${it.id}", type = "Audio", imageTags = mapOf("Primary" to "x"))
            }
        }
        val albums = List(10) { Item("al$it", type = "MusicAlbum") }
        repeat(2) { albums.map { a -> async(Dispatchers.Default) { MusicArt.resolve(api, a, lookup) } }.awaitAll() }
        assertEquals(10, calls.get())
        assertTrue("at most 3 lookups in flight ($peak)", peak <= 3)
        assertNull(MusicArt.resolve(api, Item("empty", type = "MusicAlbum"), lookup))
        assertNull(MusicArt.resolve(api, Item("empty", type = "MusicAlbum"), lookup))
        assertEquals(11, calls.get())
        assertNull(MusicArt.resolve(api, Item("flaky", type = "MusicAlbum"), lookup))
        fail = false
        assertEquals(MusicArt.Ref("t-flaky", "x"), MusicArt.resolve(api, Item("flaky", type = "MusicAlbum"), lookup))
        // Artist → its first album, which has no Primary → that album's first track.
        assertEquals(MusicArt.Ref("t-of-ar", "x"), MusicArt.resolve(api, Item("ar", type = "MusicArtist"), lookup))
    }
}
