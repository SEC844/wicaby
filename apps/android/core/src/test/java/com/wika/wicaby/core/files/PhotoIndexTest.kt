package com.wika.wicaby.core.files

import com.wika.wicaby.core.data.ItemsResult
import com.wika.wicaby.core.data.json
import com.wika.wicaby.core.files.pure.Ids
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.URLDecoder
import java.util.Base64

// Photo file sources: the index over a temp folder of generated photos (the shared EXIF vectors' bytes, never a real
// photo), its incremental rescans and favourites, the photo routes the photo screens call, and the same tree through
// a fake SMB gateway (the loopback contract of packages/mesh files.go, Range reads only).
class PhotoIndexTest {
    private val vectors = json.parseToJsonElement(File("../../../tools/checks/fixtures/photos/exif-vectors.json").readText()).jsonObject["vectors"]!!.jsonArray.map { it.jsonObject }
        .associateBy { it["name"]!!.jsonPrimitive.content }

    private fun bytes(name: String) = Base64.getDecoder().decode(vectors.getValue(name)["b64"]!!.jsonPrimitive.content)

    // The HEIC whose Exif item lies past the first 64 KB, rebuilt from the vector's head and item.
    private fun farHeic(): ByteArray {
        val v = vectors.getValue("HEIC Exif item past the head")
        val more = v["expected"]!!.jsonObject["more"]!!.jsonObject
        val at = more["at"]!!.jsonPrimitive.content.toInt()
        val item = Base64.getDecoder().decode(v["item"]!!.jsonPrimitive.content)
        return ByteArray(at + item.size).also { bytes("HEIC Exif item past the head").copyInto(it); item.copyInto(it, at) }
    }

    private val mtime = 1_592_215_200_000L // 2020-06-15T10:00:00Z

    private fun tree(): File {
        val root = FilesTestKit.tempDir()
        fun put(rel: String, b: ByteArray) = File(root, rel).also { it.parentFile.mkdirs(); it.writeBytes(b); it.setLastModified(mtime) }
        put("IMG_A.jpg", bytes("DateTimeOriginal with OffsetTimeOriginal"))
        put("Album/IMG_B.jpg", bytes("jpeg orientation 6 (Motorola)"))
        put("Album/Sub/IMG_C.png", bytes("PNG eXIf"))
        put("Album/Sub/clip.mp4", "WICABY TEST STUB: not a video\n".toByteArray())
        put("noexif.jpg", bytes("missing EXIF"))
        put("Far/far.heic", farHeic())
        put(".hidden.jpg", bytes("missing EXIF"))
        put("@eaDir/IMG_X.jpg", bytes("missing EXIF"))
        put("notes.txt", "not a photo\n".toByteArray())
        return root
    }

    // A folder of this machine as a backend; reads counted.
    private class DirBackend(val root: File) : FileBackend {
        var reads = 0
        override suspend fun list(rel: String) = (File(root, rel).listFiles() ?: throw FileError(FileError.Kind.NOT_FOUND)).map { FileEntry(it.name, it.isDirectory, if (it.isFile) it.length() else 0, it.lastModified()) }
        override fun uri(rel: String, entry: FileEntry?) = File(root, rel).toURI().toString()
        override suspend fun read(rel: String, entry: FileEntry?, maxBytes: Int): ByteArray {
            reads++
            return File(root, rel).readBytes().let { it.copyOf(minOf(it.size, maxBytes)) }
        }
    }

    private fun api(backend: FileBackend, dir: File = FilesTestKit.tempDir()) =
        FilesApi(FilesTestKit.source(), backend, FileProgress(File(dir, "p.json")), "dev", photos = PhotoIndex(backend, File(dir, "photo-index.json")))

    private suspend fun FilesApi.timeline(vararg q: Pair<String, Any?>): ItemsResult =
        items("ParentId" to Ids.ROOT, "Recursive" to true, "IncludeItemTypes" to "Photo,Video", "SortBy" to "DateCreated,SortName", "SortOrder" to "Descending", *q)

    @Test
    fun indexesTheTreeAndAnswersThePhotoScreens() = runBlocking {
        val backend = DirBackend(tree())
        val api = api(backend)
        assertEquals("photos", api.views().single().collectionType)
        val all = api.timeline().items
        assertEquals(listOf("IMG_A.jpg", "IMG_B.jpg", "IMG_C.png", "clip.mp4", "far.heic", "noexif.jpg"), all.map { it.name }.sorted())
        val by = all.associateBy { it.name }
        assertEquals("2019-10-12T14:30:05+02:00", by.getValue("IMG_A.jpg").premiereDate)
        assertEquals("RightTop", by.getValue("IMG_B.jpg").imageOrientation)
        assertEquals("LeftBottom", by.getValue("IMG_C.png").imageOrientation)
        assertEquals("the Exif item past the head: a second read", "2023-04-02T11:00:00", by.getValue("far.heic").premiereDate)
        assertNull("no EXIF: the mtime dates it", by.getValue("noexif.jpg").premiereDate)
        assertEquals("2020-06-15T10:00:00.000Z", by.getValue("noexif.jpg").dateCreated)
        assertEquals(listOf(800, 600), listOf(by.getValue("noexif.jpg").width, by.getValue("noexif.jpg").height))
        assertEquals("Video", by.getValue("clip.mp4").type)
        assertTrue(by.getValue("clip.mp4").imageTags.isEmpty())
        assertTrue(all.filter { it.type == "Photo" }.all { it.imageTags["Primary"] != null && it.latitude == null })
        // Newest first.
        assertEquals("far.heic", all.first().name)

        // Albums are folders; a nested one names its path; its timeline is the folder recursively.
        val albums = api.items("ParentId" to Ids.ROOT, "IncludeItemTypes" to "PhotoAlbum", "Recursive" to false).items
        assertEquals(listOf("Album", "Album › Sub", "Far"), albums.map { it.name })
        assertTrue(api.image(albums[0].id, "Primary", albums[0].imageTags["Primary"]).endsWith("Album/IMG_B.jpg"))
        assertEquals(3, api.items("ParentId" to albums[0].id, "Recursive" to true, "IncludeItemTypes" to "Photo,Video").totalRecordCount)

        // The info panel's item, the thumbnail, favourites, /Years and a memories range.
        val b = api.item(by.getValue("IMG_B.jpg").id)
        assertEquals("Photo", b.type)
        // A tile gets a cached thumbnail by bucket; past the last bucket (the viewer's zoom) the file itself.
        assertEquals("wicaby-photo://${api.source.id}/720/${b.imageTags["Primary"]}/${b.id}", api.image(b.id, "Primary", b.imageTags["Primary"], maxHeight = 400))
        assertTrue(api.image(b.id, "Primary", b.imageTags["Primary"], maxWidth = 4096).endsWith("Album/IMG_B.jpg"))
        api.setFavorite(b.id, true)
        assertEquals(listOf("IMG_B.jpg"), api.timeline("Filters" to "IsFavorite").items.map { it.name })
        assertTrue(api.timeline("Filters" to "IsFavorite").items.single().userData!!.isFavorite)
        val years = api.get<ItemsResult>("/Years", "Recursive" to true).items.map { it.productionYear }
        assertEquals(listOf(2023, 2021, 2020, 2019, 2015), years)
        val day = api.timeline("MinPremiereDate" to "2021-07-13T00:00:00", "MaxPremiereDate" to "2021-07-15T23:59:59").items
        assertEquals(listOf("IMG_B.jpg"), day.map { it.name })
        val status = api.photos!!.status.value
        assertEquals(6, status.count)
        assertFalse(status.scanning)
        assertTrue(status.scannedAt > 0)
    }

    @Test
    fun rescansOnlyWhatChanged() = runBlocking {
        val root = tree()
        val dir = FilesTestKit.tempDir()
        val backend = DirBackend(root)
        val index = PhotoIndex(backend, File(dir, "photo-index.json"))
        index.scan()
        val first = backend.reads
        assertEquals("five photo heads, one HEIC second read; no read for the clip", 6, first)
        index.setFavorite("Album/IMG_B.jpg", true)
        index.setFavorite("noexif.jpg", true)
        // A fresh open (next session) answers from the cache file, then refreshes in the background.
        val again = PhotoIndex(backend, File(dir, "photo-index.json"))
        assertEquals(6, again.records().size)
        again.rescan().join()
        assertEquals("nothing changed: nothing read", first, backend.reads)
        File(root, "Album/IMG_B.jpg").apply { writeBytes(bytes("jpeg orientation 3 (Intel)")); setLastModified(mtime + 60_000) }
        File(root, "noexif.jpg").delete()
        again.scan()
        assertEquals("one changed file read again", first + 1, backend.reads)
        assertEquals(3, again.records()["Album/IMG_B.jpg"]!!.o)
        assertFalse("a removed file goes", "noexif.jpg" in again.records())
        assertEquals("favourites kept across rescans, the removed one dropped", setOf("Album/IMG_B.jpg"), again.favorites())
    }

    @Test
    fun aRootThatCannotBeListedKeepsTheIndex() = runBlocking {
        val root = tree()
        val dir = FilesTestKit.tempDir()
        val backend = DirBackend(root)
        val index = PhotoIndex(backend, File(dir, "photo-index.json"))
        index.scan()
        root.deleteRecursively()
        index.scan()
        assertEquals(6, index.records().size)
        assertTrue(index.status.value.error is FileError)
    }

    // The same tree behind a fake SMB gateway (GET <base>/ls/<rel> as JSON, GET <base>/f/<rel> with Range): the index
    // reads 64 KB heads, never whole files, and no credential reaches a URL.
    @Test
    fun throughTheSmbGateway() = runBlocking {
        val root = tree()
        val ranges = mutableListOf<String?>()
        MockWebServer().use { gw ->
            gw.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.url.encodedPath.removePrefix("/tok/")
                    val rel = URLDecoder.decode(path.substringAfter('/'), "UTF-8").replace("+", " ")
                    val f = File(root, rel)
                    return when (path.substringBefore('/')) {
                        "ls" -> MockResponse.Builder().body(
                            (f.listFiles() ?: emptyArray()).joinToString(",", "[", "]") { """{"name":"${it.name}","dir":${it.isDirectory},"size":${it.length()},"mtime":${it.lastModified() / 1000}}""" },
                        ).build()
                        "f" -> {
                            val range = request.headers["Range"].also { ranges += it }
                            val all = f.readBytes()
                            val end = range?.substringAfter("bytes=0-")?.toIntOrNull()?.let { minOf(it, all.size - 1) } ?: (all.size - 1)
                            MockResponse.Builder().code(206).body(Buffer().write(all.copyOfRange(0, end + 1))).build()
                        }
                        else -> MockResponse.Builder().code(404).body("notfound").build()
                    }
                }
            }
            gw.start()
            val opener = object : Gateway.Opener {
                override fun open(host: String, port: Int, share: String, user: String, pass: String, domain: String) = gw.url("/tok").toString().trimEnd('/')
            }
            val s = FilesTestKit.source("smb://STORAGE/photos", FileSource.SMB)
            val g = Gateway(s, FileCredentials("demo", "demo"), OkHttpClient(), opener)
            val api = api(g)
            val all = api.timeline().items
            assertEquals(6, all.size)
            assertEquals("2023-04-02T11:00:00", all.first { it.name == "far.heic" }.premiereDate)
            assertTrue("heads only", ranges.all { it != null && it.startsWith("bytes=0-") })
            assertTrue(ranges.count { it == "bytes=0-${com.wika.wicaby.core.files.pure.ExifReader.HEAD_BYTES - 1}" } >= 5)
            assertFalse(api.image(all.first { it.name == "IMG_A.jpg" }.id, "Primary", null).contains("demo"))
            // The thumbnail's address (Coil's key, the cache file's name) holds no gateway token: stable across runs.
            val thumb = api.image(all.first { it.name == "IMG_A.jpg" }.id, "Primary", null, maxHeight = 300)
            assertTrue(thumb.startsWith("wicaby-photo://") && "tok" !in thumb && "demo" !in thumb)
        }
    }
}
