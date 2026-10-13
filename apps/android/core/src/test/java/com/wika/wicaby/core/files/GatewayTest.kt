package com.wika.wicaby.core.files

import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

// FS-13 GatewayTest: the Kotlin side of SMB speaks only the gateway's loopback HTTP contract (packages/mesh files.go):
// a fake gateway on MockWebServer serves the ls JSON and Range; the share's address and the credentials go to
// OpenFiles once and never into a URL.
class GatewayTest {
    private lateinit var gw: MockWebServer
    private val opened = mutableListOf<List<Any>>()
    private val closed = mutableListOf<String>()

    @Before
    fun setUp() {
        gw = MockWebServer().apply { start() }
    }

    @After
    fun tearDown() = gw.close()

    private val opener = object : Gateway.Opener {
        override fun open(host: String, port: Int, share: String, user: String, pass: String, domain: String): String {
            opened += listOf(host, port, share, user, pass, domain)
            return gw.url("/0123456789abcdef0123456789abcdef").toString().trimEnd('/')
        }

        override fun close(base: String) {
            closed += base
        }
    }

    private fun gateway(url: String = "smb://STORAGE/media/sub%20dir") =
        Gateway(FilesTestKit.source(url, FileSource.SMB), FileCredentials("demo", "demo", "WORKGROUP"), OkHttpClient(), opener)

    @Test
    fun listsThroughTheLsRouteAndPlaysThroughF() = runBlocking {
        gw.enqueue(MockResponse.Builder().code(200).body("""[{"name":"Films","dir":true,"size":0,"mtime":1727776800},{"name":"a b.mkv","dir":false,"size":42,"mtime":1727776801},{"name":"..","dir":true},{"name":"x:y","dir":false}]""").build())
        val g = gateway()
        val entries = g.list("Films")
        assertEquals(listOf(FileEntry("Films", true, 0, 1_727_776_800_000), FileEntry("a b.mkv", false, 42, 1_727_776_801_000)), entries)
        assertEquals(listOf<List<Any>>(listOf("STORAGE", 445, "media", "demo", "demo", "WORKGROUP")), opened)
        val ls = gw.takeRequest()
        assertEquals("/0123456789abcdef0123456789abcdef/ls/sub%20dir/Films", ls.url.encodedPath)
        assertNull(ls.headers["Authorization"])
        assertFalse(ls.url.toString().contains("demo"))
        assertEquals(gw.url("/0123456789abcdef0123456789abcdef/f/sub%20dir/Films/a%20b.mkv").toString(), g.uri("Films/a b.mkv", entries[1]))

        gw.enqueue(MockResponse.Builder().code(206).addHeader("Content-Range", "bytes 0-3/42").body("abcd").build())
        assertEquals("abcd", g.read("Films/a b.mkv", entries[1], 4).decodeToString())
        assertEquals("bytes=0-3", gw.takeRequest().headers["Range"])
        // One open for the share, closed with the backend.
        assertEquals(1, opened.size)
        g.close()
        assertEquals(1, closed.size)
    }

    @Test
    fun theGatewayNamesTheSmbFailure() = runBlocking {
        for ((body, kind) in listOf("auth: logon failure" to FileError.Kind.AUTH, "smb1: dialect" to FileError.Kind.SMB1, "offline: dial" to FileError.Kind.OFFLINE, "notfound: share" to FileError.Kind.NOT_FOUND)) {
            gw.enqueue(MockResponse.Builder().code(502).body(body).build())
            try {
                gateway().list("")
                fail("$body must fail")
            } catch (e: FileError) {
                assertEquals(body, kind, e.kind)
            }
        }
    }

    @Test
    fun smbUrlsParseAsUrlsWritesThem() {
        assertEquals(SmbUrl("STORAGE", 445, "media", "sub dir/x"), SmbUrl.parse("smb://STORAGE/media/sub%20dir/x"))
        assertEquals(SmbUrl("192.0.2.10", 445, "media", ""), SmbUrl.parse("smb://192.0.2.10/media"))
        assertNull(SmbUrl.parse("smb://STORAGE"))
        assertNull(SmbUrl.parse("smb://user@STORAGE/media"))
        assertNull(SmbUrl.parse("smb://STORAGE/media/%2e%2e/x"))
        assertNull(SmbUrl.parse("https://dav.example/media"))
    }
}
