package com.wika.wicaby.core.files

import com.wika.wicaby.core.files.pure.Ids
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.TimeUnit

// The Android WebDAV backend against the repository's own mock (tools/mock-server/mock-webdav.mjs, loopback only,
// demo/demo, the files-fixture.mjs tree): natural order, hidden entries, NFO and sidecars, Range, the Digest-only and
// hostile-href modes, and the certificate pin across a certificate change. Skipped when node is not on the PATH.
class FilesMockTest {
    private val repo = File("../../..").canonicalFile
    private val mockScript = File(repo, "tools/mock-server/mock-webdav.mjs")
    private val creds = FileCredentials("demo", "demo")

    private class Mock(val process: Process, val base: String) : AutoCloseable {
        override fun close() {
            process.destroy()
            process.waitFor(5, TimeUnit.SECONDS)
        }
    }

    private fun node(): String? = listOf("node", "node.exe").firstOrNull { n ->
        runCatching { ProcessBuilder(n, "--version").redirectErrorStream(true).start().let { it.waitFor(10, TimeUnit.SECONDS) && it.exitValue() == 0 } }.getOrDefault(false)
    }

    private fun start(env: Map<String, String> = emptyMap()): Mock {
        val n = node()
        assumeTrue("node is not on the PATH", n != null && mockScript.isFile)
        // A script file, not -e: Windows command lines lose the quotes inside an argument. The mode goes in the environment.
        val script = File(FilesTestKit.tempDir(), "start-mock.mjs")
        script.writeText(
            listOf(
                "import { startMockWebdav } from '${mockScript.toURI()}';",
                "const m = await startMockWebdav({ port: 0 });",
                "console.log('BASE ' + m.base);",
                "process.stdin.on('end', () => process.exit(0));",
                "process.stdin.resume();",
            ).joinToString("\n"),
        )
        val pb = ProcessBuilder(n, script.absolutePath).redirectError(ProcessBuilder.Redirect.INHERIT)
        pb.environment().putAll(env)
        val p = pb.start()
        val line = p.inputStream.bufferedReader().readLine() ?: run { p.destroy(); error("mock-webdav did not start") }
        return Mock(p, line.removePrefix("BASE ").trim())
    }

    private fun source(m: Mock, tls: TlsPolicy? = null) = FilesTestKit.source(m.base, tls = tls)

    private fun api(m: Mock, c: FileCredentials = creds, tls: TlsPolicy? = null): Pair<FilesApi, OkHttpClient> {
        val s = source(m, tls)
        val client = davClient(OkHttpClient(), s, c)
        return FilesApi(s, WebDav(s, client), FileProgress(File(FilesTestKit.tempDir(), "p.json")), "dev") to client
    }

    private fun state(m: Mock, client: OkHttpClient = OkHttpClient()): JsonObject =
        client.newCall(Request.Builder().url(m.base.substringBefore("/media") + "/Mock/State").build()).execute().use { Json.parseToJsonElement(it.body.string()).jsonObject }

    @Test
    fun browsesTheFixtureTree() = runBlocking {
        start().use { m ->
            val (api, client) = api(m)
            assertEquals(listOf("Films", "Shows"), api.visible("").map { it.name })
            val seasons = api.items("ParentId" to Ids.encode("Shows/Example Show")).items.map { it.name }
            assertEquals(listOf("Season 1", "Season 2", "Season 10"), seasons)
            val eps = api.items("ParentId" to Ids.encode("Shows/Example Show/Season 1")).items
            assertEquals((1..10).map { "Example.Show.S01E%02d.720p".format(it) }, eps.map { it.name })
            assertTrue(eps.all { it.type == "Episode" && it.seriesName == "Example Show" })

            val film = Ids.encode("Films/Example Movie (2019)/Example.Movie.2019.1080p.mkv")!!
            val item = api.item(film)
            assertEquals("the NFO title wins over the file name", "Example Movie & Friends", item.name)
            assertEquals(listOf("en", "fr"), item.mediaSources.single().mediaStreams.filter { it.isExternal }.map { it.language })
            val poster = api.image(film, "Primary", item.imageTags["Primary"])
            client.newCall(Request.Builder().url(poster).build()).execute().use { assertEquals(200, it.code) }
            val video = api.url("/Videos/$film/stream")
            client.newCall(Request.Builder().url(video).header("Range", "bytes=0-15").build()).execute().use {
                assertEquals(206, it.code)
                assertEquals(16, it.body.bytes().size)
            }
            val st = state(m)
            assertTrue(st.getValue("authSeen").jsonPrimitive.boolean)
            val tags = st.getValue("tags").jsonArray.map { it.jsonPrimitive.content }
            assertFalse("AUTH-IN-URL", "AUTH-IN-URL" in tags)
            assertFalse("never Depth: infinity", "DEPTH-INFINITY" in tags)
            assertTrue(st.getValue("ranges").jsonArray.any { it.jsonObject.getValue("status").jsonPrimitive.content == "206" })
        }
    }

    private suspend fun failsWith(kind: FileError.Kind, block: suspend () -> Unit) {
        try {
            block()
            fail("expected $kind")
        } catch (e: FileError) {
            assertEquals(kind, e.kind)
        }
    }

    @Test
    fun aWrongPasswordAndDigestOnlyAreTold() = runBlocking {
        start().use { m -> failsWith(FileError.Kind.AUTH) { api(m, FileCredentials("demo", "wrong")).first.listing("") } }
        start(mapOf("MOCK_DAV_DIGEST" to "1")).use { m -> failsWith(FileError.Kind.DIGEST_ONLY) { api(m).first.listing("") } }
    }

    @Test
    fun hostileHrefsAreDropped() = runBlocking {
        start(mapOf("MOCK_DAV_EVIL" to "1")).use { m ->
            assertEquals(listOf("Films", "Shows"), api(m).first.visible("").map { it.name })
            assertTrue("HREF-ESCAPE" in state(m).getValue("tags").jsonArray.map { it.jsonPrimitive.content })
        }
    }

    @Test
    fun thePinHoldsAcrossACertificateChange() = runBlocking {
        start(mapOf("MOCK_DAV_TLS" to "1")).use { m ->
            failsWith(FileError.Kind.CERT_UNTRUSTED) { api(m).first.listing("") }
            val pin = TlsPolicy(TlsPolicy.PIN, TlsPin.sha256(FilesTestKit.cert(1)))
            val (api, client) = api(m, tls = pin)
            assertEquals(listOf("Films", "Shows"), api.visible("").map { it.name })
            client.newCall(Request.Builder().url(m.base.substringBefore("/media") + "/Mock/RotateCert").post(ByteArray(0).toRequestBody()).build()).execute().use { assertEquals(204, it.code) }
            val before = state(m, davClient(OkHttpClient(), source(m, TlsPolicy(TlsPolicy.PIN, TlsPin.sha256(FilesTestKit.cert(2)))), null)).getValue("calls").jsonArray.size
            api.refresh()
            // A connection opened before the change stays the trusted one; a new one meets the new certificate.
            client.connectionPool.evictAll()
            failsWith(FileError.Kind.CERT_CHANGED) { api.listing("") }
            val after = state(m, davClient(OkHttpClient(), source(m, TlsPolicy(TlsPolicy.PIN, TlsPin.sha256(FilesTestKit.cert(2)))), null)).getValue("calls").jsonArray.size
            assertEquals("nothing reached the mock after the handshake", before, after)
        }
    }
}
