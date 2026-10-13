package com.wika.wicaby.core.files

import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.ItemsResult
import com.wika.wicaby.core.data.PlaybackInfo
import com.wika.wicaby.core.data.json
import com.wika.wicaby.core.files.FilesTestKit.MemoryBackend
import com.wika.wicaby.core.files.FilesTestKit.dir
import com.wika.wicaby.core.files.FilesTestKit.file
import com.wika.wicaby.core.files.pure.Ids
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File

// FS-08: FilesApi's route table over the WebDAV backend (MockWebServer replaying PROPFIND replies, the vectors' own
// hostile one included), the per-source certificate pin, and the sealed credentials.
class FilesApiTest {
    private lateinit var srv: MockWebServer
    private lateinit var tmp: File
    private val creds = FileCredentials("demo", "demo")

    @Before
    fun setUp() {
        srv = MockWebServer()
        tmp = FilesTestKit.tempDir()
    }

    @After
    fun tearDown() {
        srv.close()
        tmp.deleteRecursively()
    }

    private fun base() = srv.url("/media").toString().trimEnd('/')

    private fun webDav(tls: TlsPolicy? = null): WebDav {
        val s = FilesTestKit.source(base(), tls = tls)
        return WebDav(s, davClient(OkHttpClient(), s, creds))
    }

    private fun api(backend: FileBackend, source: FileSource = FilesTestKit.source(base())) =
        FilesApi(source, backend, FileProgress(File(tmp, "progress.json")), "dev")

    private fun res(path: String, dir: Boolean, size: Long = 0) =
        "<D:response><D:href>$path</D:href><D:propstat><D:prop><D:resourcetype>${if (dir) "<D:collection/>" else ""}</D:resourcetype>" +
            "<D:getcontentlength>$size</D:getcontentlength><D:getlastmodified>Tue, 01 Oct 2024 10:00:00 GMT</D:getlastmodified></D:prop>" +
            "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"

    private fun multistatus(vararg r: String) = MockResponse.Builder().code(207).body("""<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${r.joinToString("")}</D:multistatus>""").build()

    @Test
    fun aFolderListsNaturallyWithFoldersFirstAndNothingHidden() = runBlocking {
        srv.start()
        val folder = "/media/Shows/Example%20Show/Season%201/"
        srv.enqueue(
            multistatus(
                res(folder, true), res("${folder}Example.Show.S01E10.720p.mkv", false, 10), res("${folder}Example.Show.S01E02.720p.mkv", false, 2),
                res("${folder}Example.Show.S01E01.720p.mkv", false, 1), res("${folder}%40eaDir/", true), res("${folder}.DS_Store", false),
                res("${folder}Extras/", true), res("${folder}poster.jpg", false), res("${folder}notes.txt", false),
            ),
        )
        val api = api(webDav())
        val r = api.items("ParentId" to Ids.encode("Shows/Example Show/Season 1"))
        assertEquals(listOf("Extras", "Example.Show.S01E01.720p", "Example.Show.S01E02.720p", "Example.Show.S01E10.720p"), r.items.map { it.name })
        assertEquals(4, r.totalRecordCount)
        val ep = r.items[2]
        assertEquals("Episode", ep.type)
        assertEquals("Example Show", ep.seriesName)
        assertEquals(1 to 2, ep.parentIndexNumber to ep.indexNumber)
        // The folder's poster.jpg is every video's poster here, through the backend's own URL.
        assertEquals(base() + "/Shows/Example%20Show/Season%201/poster.jpg", api.image(ep.id, "Primary", ep.imageTags["Primary"]))
        val req = srv.takeRequest()
        assertEquals("PROPFIND", req.method)
        assertEquals("1", req.headers["Depth"])
        assertEquals(folder, req.url.encodedPath)
        assertEquals(okhttp3.Credentials.basic("demo", "demo"), req.headers["Authorization"])
        assertFalse("credentials in the URL", req.url.toString().contains("demo"))
    }

    @Test
    fun theVectorsHostileHrefsAreDropped() = runBlocking {
        srv.start()
        val pf = Json.parseToJsonElement(FilesTestKit.resource("/files/propfind.json").decodeToString()).jsonObject
        val xml = pf.getValue("cases").jsonArray[2].jsonObject.getValue("xml").jsonPrimitive.content
        srv.enqueue(MockResponse.Builder().code(207).body(xml).build())
        assertEquals(listOf("ok.mkv"), api(webDav()).visible("").map { it.name })
    }

    @Test
    fun aPinMismatchFailsBeforeAnyRequest() = runBlocking {
        srv.useHttps(FilesTestKit.serverTls(1).socketFactory)
        srv.start()
        val wrong = TlsPolicy(TlsPolicy.PIN, TlsPin.sha256(FilesTestKit.cert(2)))
        try {
            webDav(wrong).list("")
            fail("a changed certificate must fail")
        } catch (e: FileError) {
            assertEquals(e.cause?.toString() + " / " + e.cause?.cause, FileError.Kind.CERT_CHANGED, e.kind)
        }
        assertEquals("no request reached the server", 0, srv.requestCount)
        // Without a pin the self-signed certificate is not trusted either, and nothing is sent.
        try {
            webDav().list("")
            fail("an untrusted certificate must fail")
        } catch (e: FileError) {
            assertEquals(FileError.Kind.CERT_UNTRUSTED, e.kind)
        }
        assertEquals(0, srv.requestCount)
        // The right pin opens it (host name checks are the pin's job then).
        srv.enqueue(multistatus(res("/media/", true), res("/media/a.mkv", false, 3)))
        assertEquals(listOf("a.mkv"), webDav(TlsPolicy(TlsPolicy.PIN, TlsPin.sha256(FilesTestKit.cert(1)))).list("").map { it.name })
        assertEquals(1, srv.requestCount)
    }

    @Test
    fun theProbeReadsTheLeafCertificateWithoutARequest() {
        srv.useHttps(FilesTestKit.serverTls(1).socketFactory)
        srv.start()
        val info = TlsPin.probe(srv.hostName, srv.port)!!
        assertEquals(TlsPin.sha256(FilesTestKit.cert(1)), info.sha256)
        assertTrue(info.subject.contains("dav.example"))
        assertEquals(0, srv.requestCount)
    }

    @Test
    fun aCredentialThatNoLongerOpensKeepsItsSource() {
        val s = FilesTestKit.source()
        val broken = SourceStore(tmp, seal = { "sealed:" + it.reversed() }, open = { null })
        broken.add(s, creds)
        assertEquals(listOf(s.id), broken.list().map { it.id })
        assertTrue(broken.needsSignIn(broken.list().single()))
        assertNull(broken.credentials(s.id))
        // With a key that opens, they come back; the password never lands in sources.json.
        val ok = SourceStore(tmp, seal = { "sealed:" + it.reversed() }, open = { it.removePrefix("sealed:").reversed() })
        ok.setCredentials(s.id, creds)
        assertEquals(creds, ok.credentials(s.id))
        assertFalse(ok.needsSignIn(ok.list().single()))
        assertFalse(File(tmp, "sources.json").readText().contains("demo"))
        assertFalse(File(tmp, "credentials.json").readText().contains("\"demo\""))
        // Removing the source takes its credentials and progress with it.
        File(tmp, "progress-${s.id}.json").writeText("{}")
        ok.remove(s.id)
        assertTrue(ok.list().isEmpty())
        assertNull(ok.credentials(s.id))
        assertFalse(File(tmp, "progress-${s.id}.json").exists())
    }

    private val film = "Films/Example Movie (2019)"
    private fun movieTree() = MemoryBackend(
        mapOf(
            "" to listOf(dir("Films")),
            "Films" to listOf(dir("Example Movie (2019)")),
            film to listOf(
                file("Example.Movie.2019.1080p.mkv"), file("poster.jpg"), file("movie.nfo"),
                file("Example.Movie.2019.1080p.fr.srt"), file("Example.Movie.2019.1080p.en.forced.srt"),
            ),
        ),
        mapOf("$film/movie.nfo" to "<movie><title>Example Movie &amp; Friends</title><year>2019</year><plot>Only in tests.</plot></movie>".toByteArray()),
    )

    @Test
    fun theItemPageReadsTheNfoAndItsSidecars() = runBlocking {
        val api = api(movieTree(), FilesTestKit.source())
        val id = Ids.encode("$film/Example.Movie.2019.1080p.mkv")!!
        val item = api.item(id)
        assertEquals("Example Movie & Friends", item.name)
        assertEquals("Only in tests.", item.overview)
        assertEquals("Movie", item.type)
        val subs = item.mediaSources.single().mediaStreams
        assertEquals(listOf("en", "fr"), subs.map { it.language })
        assertTrue(subs.all { it.isExternal && it.deliveryMethod == "External" && it.deliveryUrl!!.startsWith("mem://$film/") })
        assertEquals("mem://$film/poster.jpg", api.image(id, "Primary", item.imageTags["Primary"]))
        val info = json.decodeFromString<PlaybackInfo>(api.raw("POST", "/Items/$id/PlaybackInfo", "{}"))
        assertTrue(info.mediaSources.single().supportsDirectPlay)
        assertEquals("mem://$film/Example.Movie.2019.1080p.mkv", api.url("/Videos/$id/stream", "static" to true))
    }

    @Test
    fun theRootIsTheOnlyViewAndUnknownRoutesAreUnmapped() = runBlocking {
        val api = api(movieTree(), FilesTestKit.source())
        assertEquals(listOf(Ids.ROOT), api.views().map { it.id })
        assertEquals(emptyList<Any>(), api.items("SearchTerm" to "Example").items)
        assertEquals(emptyList<Any>(), api.latest())
        for (path in listOf("/LiveTv/Channels", "/Items/x/RemoteSearch/Subtitles/fre", "/Plugins")) {
            try {
                api.raw("GET", path)
                fail("$path must be unmapped")
            } catch (e: ApiException) {
                assertEquals(404, e.status)
                assertTrue(e.message!!.startsWith("FILES-UNMAPPED"))
            }
        }
        // A forged id never reaches the backend.
        try {
            api.raw("GET", "/Items/p.Li4vZXRj")
            fail("a hostile id must be refused")
        } catch (e: ApiException) {
            assertEquals(404, e.status)
        }
        val listed = json.decodeFromString<ItemsResult>(api.raw("GET", "/Items", null, "ParentId" to Ids.encode("Films")))
        // A film folder lists as its film (§4.3).
        assertEquals(listOf("Example Movie"), listed.items.map { it.name })
    }

    // §6.1: user:pass@ leaves the address field as soon as it is read (Test, Save) and fills the empty credential fields.
    @Test
    fun theAddressFieldDropsItsUserInfo() {
        val dav = FileSourceDraft().apply { url = "https://demo:secret@dav.example/media" }
        dav.absorbUserInfo()
        assertEquals(Triple("https://dav.example/media", "demo", "secret"), Triple(dav.url, dav.user, dav.pass))
        val smb = FileSourceDraft(FileSource.SMB).apply { url = "smb://demo:secret@STORAGE/media"; user = "kept" }
        smb.absorbUserInfo()
        assertEquals(Triple("smb://STORAGE/media", "kept", "secret"), Triple(smb.url, smb.user, smb.pass))
        val plain = FileSourceDraft().apply { url = "dav.example/media" }
        plain.absorbUserInfo()
        assertEquals("dav.example/media", plain.url)
    }

    // §4.2, §4.3: a folder card carries its shape and its poster; a film folder's card is its film; seasons sort as
    // seasons and episodes by SxxEyy; looking into child folders never marks the folder on screen as cut.
    @Test
    fun folderCardsCarryTheirShapeAndPoster() = runBlocking {
        val tree = MemoryBackend(
            mapOf(
                "" to listOf(dir("Films"), dir("Shows")),
                "Films" to listOf(dir("Example Movie (2019)")),
                film to listOf(file("Example.Movie.2019.1080p.mkv"), file("poster.jpg"), file("Example.Movie.2019-trailer.mkv")),
                "Shows" to listOf(dir("Misc"), dir("Example Show")),
                "Shows/Example Show" to listOf(dir("Season 10"), dir("Season 2"), file("folder.jpg"), file("fanart.jpg")),
                "Shows/Example Show/Season 2" to listOf(file("Example.Show.S02E10.mkv"), file("Bonus.mkv"), file("Example.Show.S02E02.mkv")),
                "Shows/Example Show/Season 10" to emptyList(),
                "Shows/Misc" to listOf(file("a.mkv"), file("b.mkv")),
            ),
        )
        val api = api(tree, FilesTestKit.source())
        val movie = api.items("ParentId" to Ids.encode("Films")).items.single()
        assertEquals(Ids.encode("$film/Example.Movie.2019.1080p.mkv"), movie.id)
        assertFalse(movie.isFolder)
        assertEquals(Triple("Movie", "Example Movie", 2019), Triple(movie.type, movie.name, movie.productionYear))
        assertEquals("mem://$film/poster.jpg", api.image(movie.id, "Primary", movie.imageTags["Primary"]))
        val shows = api.items("ParentId" to Ids.encode("Shows")).items
        assertEquals(listOf("Series" to "Example Show", "Folder" to "Misc"), shows.map { it.type to it.name })
        assertEquals("mem://Shows/Example Show/folder.jpg", api.image(shows[0].id, "Primary", shows[0].imageTags["Primary"]))
        assertEquals("mem://Shows/Example Show/fanart.jpg", api.image(shows[0].id, "Backdrop", shows[0].backdropImageTags.single()))
        assertTrue(shows[1].imageTags.isEmpty())
        val seasons = api.items("ParentId" to Ids.encode("Shows/Example Show")).items
        assertEquals(listOf("Season" to 2, "Season" to 10), seasons.map { it.type to it.indexNumber })
        val eps = api.items("ParentId" to Ids.encode("Shows/Example Show/Season 2")).items
        assertEquals(listOf(2, 10, null), eps.map { it.indexNumber })
        assertFalse(api.truncated)
        // The folder's own page keeps its id (a film folder stays a folder there).
        assertEquals(Ids.encode(film), api.item(Ids.encode(film)!!).id)
    }

    // FS-10: what decides the admin, Live TV, cast, quality and subtitle-search entries for a file source.
    @Test
    fun aFileSourceOffersNoAdminLiveTvCastOrConversion() = runBlocking {
        val api = api(movieTree(), FilesTestKit.source())
        assertTrue(api.views().none { it.collectionType == "livetv" })
        val caps = com.wika.wicaby.core.data.caps(api.server.kind)
        assertFalse(caps.admin || caps.liveTv || caps.castSend || caps.castReceiver || caps.sessionsRemote || caps.transcode || caps.subtitleSearch || caps.favorites)
        assertFalse(com.wika.wicaby.core.player.SubtitleSearch.allowed(api))
        val user = Json.parseToJsonElement(api.raw("GET", "/Users/${api.userId}")).jsonObject
        assertEquals("false", user.getValue("Policy").jsonObject.getValue("IsAdministrator").jsonPrimitive.content)
    }
}
