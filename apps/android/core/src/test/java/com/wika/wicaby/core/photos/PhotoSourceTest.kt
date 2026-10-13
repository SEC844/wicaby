package com.wika.wicaby.core.photos

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.json
import com.wika.wicaby.core.livetv.DeviceClass
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ItemsResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Locale

// Photos spec PH-05 AC1: PhotoSource pages the skeleton query the way the desktop does, so a MockWebServer replay of
// the shared "skeleton" pages (photo-fixtures.json, checked on desktop by photos-check.mjs) gives the same order and
// month buckets. Plus the queries and image sizes the mobile and TV screens send (PH-06 AC3, PH-07 AC1).
class PhotoSourceTest {
    private val f = json.parseToJsonElement(File("../../../tools/checks/fixtures/photos/photo-fixtures.json").readText()).jsonObject
    private val server = MockWebServer()
    private val seen = mutableListOf<RecordedRequest>()

    @After
    fun tearDown() = server.close()

    private fun serve(answer: (RecordedRequest) -> String) {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                synchronized(seen) { seen += request }
                return MockResponse.Builder().addHeader("Content-Type", "application/json").body(answer(request)).build()
            }
        }
        server.start()
    }

    private fun api(kind: String) = Api(Server("s1", "Test", server.url("/").toString().trimEnd('/'), kind), "dev", "tok", "u1")
    private fun RecordedRequest.q(name: String) = url.queryParameter(name)

    @Test
    fun skeletonPagesGiveTheDesktopsOrderAndBuckets() = runBlocking {
        f.getValue("skeleton").jsonArray.first().jsonObject.let { c ->
            val pages = c.getValue("pages").jsonArray.map { it.jsonObject }
            val size = c.getValue("pageSize").jsonPrimitive.int
            serve { r -> pages[(r.q("StartIndex")?.toInt() ?: 0) / size].toString() }
            val api = api("jellyfin")
            var calls = 0
            val got = PhotoSource(api.timelineQuery("lib-photos"), size, c.getValue("offsetMin").jsonPrimitive.int).load { _, total -> calls++; assertEquals(12, total) }
            val e = c.getValue("expected").jsonObject
            assertEquals(e.getValue("ids").jsonArray.map { it.jsonPrimitive.content }, got.map { it.asset.id })
            assertEquals(e.getValue("takenAt").jsonArray.map { it.jsonPrimitive.content }, got.map { it.asset.takenAt })
            val want = e.getValue("buckets").jsonArray.map { it.jsonObject }.map { Bucket(it.getValue("key").jsonPrimitive.content, it.getValue("count").jsonPrimitive.int, it.getValue("firstIndex").jsonPrimitive.int) }
            assertEquals(want, buckets(got.map { it.asset.takenAt }))
            assertEquals(pages.size, calls)
            // The skeleton query of spec §3.1, newest DateCreated first, with the layout's size fields.
            val r = seen.first()
            assertEquals("/Items", r.url.encodedPath)
            assertEquals("lib-photos", r.q("ParentId"))
            assertEquals("true", r.q("Recursive"))
            assertEquals("Photo,Video", r.q("IncludeItemTypes"))
            assertEquals("DateCreated,SortName", r.q("SortBy"))
            assertEquals("Descending", r.q("SortOrder"))
            assertTrue(r.q("Fields")!!.split(',').containsAll(listOf("Width", "Height", "PrimaryImageAspectRatio", "DateCreated")))
            assertNull(r.q("Filters"))
        }
    }

    @Test
    fun favouritesAlbumsAndTheScreensaverAskForTheRightItems() = runBlocking {
        serve { JsonObject(emptyMap()).toString() }
        val api = api("emby")
        PhotoSource(api.timelineQuery("lib-photos", favorites = true)).load()
        api.photoAlbums("lib-photos")
        api.randomPhotos("photo-album-1")
        val (fav, albums, saver) = seen
        // Emby: the per-user route.
        assertEquals("/emby/Users/u1/Items", fav.url.encodedPath)
        assertEquals("IsFavorite", fav.q("Filters"))
        assertEquals("PhotoAlbum", albums.q("IncludeItemTypes"))
        assertEquals("false", albums.q("Recursive"))
        assertEquals("SortName", albums.q("SortBy"))
        // Spec PH-07 AC1: the photo screensaver's query.
        assertEquals("Photo", saver.q("IncludeItemTypes"))
        assertEquals("photo-album-1", saver.q("ParentId"))
        assertEquals("Random", saver.q("SortBy"))
        assertEquals("true", saver.q("Recursive"))
    }

    @Test
    fun imageSizesFollowTheDeviceClass() {
        // Spec §3.1/§4.4 and PH-06 AC3: viewer caps, the tv-low grid at 240 px at most.
        assertEquals(1280, PhotoSizes.viewerCap(DeviceClass.TV_LOW))
        assertEquals(1920, PhotoSizes.viewerCap(DeviceClass.TV))
        assertEquals(1600, PhotoSizes.viewerCap(DeviceClass.MOBILE_LOW))
        assertEquals(2560, PhotoSizes.viewerCap(DeviceClass.MOBILE))
        assertEquals(240, PhotoSizes.tvTile(DeviceClass.TV_LOW, 400))
        assertEquals(400, PhotoSizes.tvTile(DeviceClass.TV, 400))
        val asset = PhotoAsset("p1", "s1", "photo", "2019-10-12T10:00:00", 1.5, thumbTag = "t1")
        // Emby turns the pixels on request; Jellyfin has no such parameter (the client turns them).
        val emby = Api(Server("e", "E", "http://127.0.0.1:8096", "emby"), "dev").photoImage(asset, maxWidth = 1280).toHttpUrl()
        assertEquals("/emby/Items/p1/Images/Primary", emby.encodedPath)
        assertEquals("1280", emby.queryParameter("maxWidth"))
        assertEquals("t1", emby.queryParameter("tag"))
        assertEquals("true", emby.queryParameter("AutoOrient"))
        val jf = Api(Server("j", "J", "http://127.0.0.1:8096", "jellyfin"), "dev").photoImage(asset, maxHeight = 240).toHttpUrl()
        assertEquals("240", jf.queryParameter("maxHeight"))
        assertNull(jf.queryParameter("AutoOrient"))
    }

    @Test
    fun datesAreWallClock() {
        assertEquals("12 octobre 2019", photoDate("2019-10-12T23:59:00", Locale.FRENCH))
        assertEquals("12 October 2019", photoDate("2019-10-12T00:10:00", Locale.ENGLISH))
        assertEquals("Octobre 2019", photoDate("2019-10-01", Locale.FRENCH, "LLLL yyyy"))
    }

    // A load cut short (the screen left mid-paging) is not taken for the whole library: the next visit pages again.
    @Test
    fun aTimelineCutShortLoadsAgain() = runBlocking {
        fun item(i: Int) = Item(id = "p$i", type = "Photo", premiereDate = "2024-01-${(28 - i).toString().padStart(2, '0')}T12:00:00", imageTags = mapOf("Primary" to "t"))
        val t = TimelineState()
        val firstPage = CompletableDeferred<Unit>()
        val job = launch {
            t.load(PhotoSource({ start, _ ->
                if (start > 0) awaitCancellation()
                ItemsResult(listOf(item(0), item(1)), 4).also { firstPage.complete(Unit) }
            }, pageSize = 2))
        }
        firstPage.await()
        job.cancel()
        job.join()
        assertEquals(2, t.photos.size)
        assertFalse(t.complete)
        val full = PhotoSource({ start, _ -> ItemsResult(listOf(item(start), item(start + 1)), 4) }, pageSize = 2)
        t.load(full)
        assertTrue(t.complete)
        assertEquals(listOf("p0", "p1", "p2", "p3"), t.photos.map { it.asset.id })
        // Complete: a later visit does not page again unless forced.
        var calls = 0
        t.load(PhotoSource({ _, _ -> calls++; ItemsResult() }))
        assertEquals(0, calls)
    }

    // Spec PH-07 AC2: "on this day" asks /Years once and one premiere-date range per earlier year, shows only that
    // day's stills, and falls back to random stills when there are none.
    @Test
    fun memoriesShowTodayOrFallBackToRandom() = runBlocking {
        var ranges = true
        serve { r ->
            when {
                r.url.encodedPath.endsWith("/Years") -> """{"Items":[{"Id":"y2026","Name":"2026","ProductionYear":2026},{"Id":"y2025","Name":"2025","ProductionYear":2025},{"Id":"y2019","Name":"2019","ProductionYear":2019}]}"""
                r.q("SortBy") == "Random" -> """{"Items":[{"Id":"r1","Type":"Photo","ImageTags":{"Primary":"t"}}],"TotalRecordCount":1}"""
                !ranges -> """{"Items":[],"TotalRecordCount":0}"""
                r.q("MinPremiereDate")!!.startsWith("2025") -> """{"Items":[{"Id":"m1","Type":"Photo","PremiereDate":"2025-03-15T09:00:00","ImageTags":{"Primary":"t"}}],"TotalRecordCount":1}"""
                else -> """{"Items":[{"Id":"m7","Type":"Photo","PremiereDate":"2019-03-15T18:00:00","ImageTags":{"Primary":"t"}}],"TotalRecordCount":1}"""
            }
        }
        val api = api("jellyfin")
        assertEquals(listOf("m1", "m7"), api.memoryPhotos("lib-photos", "2026-03-15").map { it.id })
        val years = seen.filter { it.url.encodedPath == "/Years" }
        val range = seen.filter { it.q("MinPremiereDate") != null }
        assertEquals(1, years.size)
        assertEquals("Photo", years[0].q("IncludeItemTypes"))
        // Spec §3.1 step 2: that year's today ±1 day, filtered client-side.
        assertEquals(listOf("2025-03-14T00:00:00", "2019-03-14T00:00:00"), range.map { it.q("MinPremiereDate") })
        assertEquals(listOf("2025-03-16T23:59:59", "2019-03-16T23:59:59"), range.map { it.q("MaxPremiereDate") })
        assertTrue(range.all { it.q("ParentId") == "lib-photos" && it.q("IncludeItemTypes") == "Photo" && it.q("Limit") == "30" })
        assertTrue(seen.none { it.q("SortBy") == "Random" })
        ranges = false
        assertEquals(listOf("r1"), api.memoryPhotos("lib-photos", "2026-03-15").map { it.id })
        assertTrue(seen.last().q("SortBy") == "Random")
    }
}
