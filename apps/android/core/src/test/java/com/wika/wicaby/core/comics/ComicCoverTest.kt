package com.wika.wicaby.core.comics

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Server
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.atomic.AtomicLong
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.random.Random

class ComicCoverTest {
    private val page1 = ByteArray(5000) { (it % 7).toByte() }
    private val page2 = ByteArray(3000) { (it % 5).toByte() }
    private val filler = Random(1).nextBytes(400 * 1024)
    private val archive = zip(
        "Tome/10.png" to filler, // the biggest page, last in reading order
        "Tome/2.png" to page2,
        "__MACOSX/Tome/._1.png" to byteArrayOf(1),
        "Tome/1.png" to page1,
        "ComicInfo.xml" to "<ComicInfo/>".toByteArray(),
    )
    private val served = AtomicLong()
    private val requests = mutableListOf<String?>()
    private var honourRange = true
    private val server = MockWebServer()
    private val http = OkHttpClient()

    private fun zip(vararg files: Pair<String, ByteArray>): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { z ->
            files.forEachIndexed { i, (name, data) ->
                val e = ZipEntry(name)
                if (i % 2 == 1) { // every other entry stored, the rest deflated
                    e.method = ZipEntry.STORED
                    e.size = data.size.toLong()
                    e.crc = CRC32().apply { update(data) }.value
                }
                z.putNextEntry(e)
                z.write(data)
                z.closeEntry()
            }
        }
        return out.toByteArray()
    }

    @Before
    fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val range = request.headers["Range"]
                synchronized(requests) { requests += range }
                if (!request.url.encodedPath.endsWith("/File")) return MockResponse.Builder().code(404).build()
                val m = Regex("^bytes=(\\d*)-(\\d*)$").find(range.orEmpty())
                if (!honourRange || m == null) {
                    served.addAndGet(archive.size.toLong())
                    return MockResponse.Builder().body(Buffer().write(archive)).build()
                }
                val (a, b) = m.destructured
                val start = if (a.isEmpty()) maxOf(0, archive.size - b.toInt()) else a.toInt()
                val end = if (a.isNotEmpty() && b.isNotEmpty()) minOf(b.toInt(), archive.size - 1) else archive.size - 1
                val body = archive.copyOfRange(start, end + 1)
                served.addAndGet(body.size.toLong())
                return MockResponse.Builder().code(206).addHeader("Content-Range", "bytes $start-$end/${archive.size}").body(Buffer().write(body)).build()
            }
        }
        server.start()
    }

    @After
    fun stop() = server.close()

    private fun url() = server.url("/emby/Items/b1/File").toString()

    @Test
    fun coverEntryOrderSkipsAndPreference() {
        assertEquals("b/1.jpg", ComicCovers.entry(listOf("b/10.jpg", "b/2.jpg", "b/1.jpg")))
        assertEquals("p/02.jpg", ComicCovers.entry(listOf("__MACOSX/._01.jpg", ".thumb.jpg", "x/.DS_Store.png", "p/02.jpg", "p/03.jpg")))
        assertEquals("p/01.webp", ComicCovers.entry(listOf("ComicInfo.xml", "p/", "p/notes.txt", "p/01.webp")))
        assertEquals("p/Cover.JPG", ComicCovers.entry(listOf("p/01.jpg", "p/02.jpg", "p/Cover.JPG")))
        assertEquals("p/cover_front.png", ComicCovers.entry(listOf("p/01.jpg", "p/cover_front.png")))
        assertEquals("p/000.jpg", ComicCovers.entry(listOf("p/001.jpg", "p/000.jpg", "p/002.jpg")))
        assertEquals("p/01.jpg", ComicCovers.entry(listOf("p/01.jpg", "p/coverage.jpg")))
        assertNull(ComicCovers.entry(listOf("ComicInfo.xml")))
    }

    @Test
    fun firstPageReadsTheTailAndOneEntryOnly() = runBlocking {
        val bytes = ComicCovers.firstPage(http, url())
        assertArrayEquals(page1, bytes)
        assertTrue("only Range requests: $requests", requests.all { it != null })
        assertTrue("${requests.size} requests", requests.size <= 3)
        assertTrue("served ${served.get()} of ${archive.size}", served.get() < archive.size / 3)
    }

    @Test
    fun theFieldLogNeverNamesTheUrlTheBookOrTheToken() = runBlocking {
        honourRange = false
        val url = server.url("/emby/Items/b1/File?api_key=s3cr3tT0ken").toString()
        val steps = mutableListOf<String>()
        val refused = try {
            ComicCovers.firstPage(http, url, steps)
            null
        } catch (e: IOException) {
            e
        }!!
        val host = server.url("/").host
        val logs = listOf(
            ComicCovers.diagnostic(refused, steps, url),
            // OkHttp's own messages can carry the address.
            ComicCovers.diagnostic(IOException("unexpected end of stream on $url"), steps, url),
            ComicCovers.diagnostic(IOException("Failed to connect to /$host:${server.port} for b1 s3cr3tT0ken"), listOf("206 0-9/10 read 10"), url),
        )
        assertTrue(logs[0], logs[0].contains("Refused") && logs[0].contains("HTTP 200") && logs[0].contains("200 no Content-Range"))
        for (log in logs) {
            for (secret in listOf(url, "s3cr3tT0ken", "api_key=", host, "b1", "http://", "/Items/")) assertTrue("$secret in: $log", secret !in log)
        }
    }

    @Test
    fun aServerIgnoringRangeIsRefused() = runBlocking {
        honourRange = false
        try {
            ComicCovers.firstPage(http, url())
            fail("a 200 answer must be refused")
        } catch (_: IOException) {
        }
        assertEquals(1, requests.size)
    }

    @Test
    fun keyAndEligibility() {
        val api = Api(Server("srv1", "NAS", server.url("/").toString().trimEnd('/'), "emby"), "phone", "token", "u1")
        val book = Item(id = "b1", name = "B", type = "Book", container = "cbz", dateCreated = "d1")
        val cover = ComicCovers.of(api, book)!!
        assertTrue(cover.url.endsWith("/emby/Items/b1/File"))
        assertEquals("d1", cover.version)
        assertEquals("e1", ComicCovers.of(api, book.copy(etag = "e1"))!!.version)
        assertNull("the server cover wins", ComicCovers.of(api, book.copy(imageTags = mapOf("Primary" to "t"))))
        assertNull("not a CBZ", ComicCovers.of(api, book.copy(container = "epub")))
        assertNull(ComicCovers.of(api, book.copy(type = "Movie")))
        // The cache key changes with the server, the item and the version.
        val key = ComicCoverKeyer.key(cover)
        assertNotEquals(key, ComicCoverKeyer.key(cover.copy(version = "d2")))
        assertNotEquals(key, ComicCoverKeyer.key(ComicCovers.of(api, book.copy(id = "b2"))!!))
        assertTrue(key.contains(server.url("/").host))
    }
}
