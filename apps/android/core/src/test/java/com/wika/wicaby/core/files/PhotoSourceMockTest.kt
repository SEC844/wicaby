package com.wika.wicaby.core.files

import com.wika.wicaby.core.data.json
import com.wika.wicaby.core.files.pure.Ids
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.TimeUnit

// A photo source over WebDAV: the index against the repository's WebDAV mock (loopback only, demo/demo) serving the
// generated photo tree of tools/mock-server/photo-files-fixture.mjs (gradients and made-up EXIF, never a real photo).
// Skipped when node is not on the PATH.
class PhotoSourceMockTest {
    private val repo = File("../../..").canonicalFile

    private fun node(): String? = listOf("node", "node.exe").firstOrNull { n ->
        runCatching { ProcessBuilder(n, "--version").redirectErrorStream(true).start().let { it.waitFor(10, TimeUnit.SECONDS) && it.exitValue() == 0 } }.getOrDefault(false)
    }

    @Test
    fun indexesThePhotoTreeOverWebDav() = runBlocking {
        val n = node()
        val dav = File(repo, "tools/mock-server/mock-webdav.mjs")
        val fixture = File(repo, "tools/mock-server/photo-files-fixture.mjs")
        assumeTrue("node is not on the PATH", n != null && dav.isFile && fixture.isFile)
        val dir = FilesTestKit.tempDir()
        val script = File(dir, "start-photo-mock.mjs")
        script.writeText(
            listOf(
                "import { startMockWebdav } from '${dav.toURI()}';",
                "import { buildPhotoTree } from '${fixture.toURI()}';",
                "const t = buildPhotoTree(${kotlinx.serialization.json.JsonPrimitive(File(dir, "tree").absolutePath)});",
                "const m = await startMockWebdav({ root: t.dir, port: 0 });",
                "console.log('BASE ' + m.base);",
                "console.log('TREE ' + JSON.stringify(t));",
                "process.stdin.on('end', () => process.exit(0));",
                "process.stdin.resume();",
            ).joinToString("\n"),
        )
        val p = ProcessBuilder(n, script.absolutePath).redirectError(ProcessBuilder.Redirect.INHERIT).start()
        try {
            val out = p.inputStream.bufferedReader()
            val base = out.readLine().removePrefix("BASE ").trim()
            val tree = json.parseToJsonElement(out.readLine().removePrefix("TREE ")).jsonObject
            val photos = tree["photos"]!!.jsonArray.map { it.jsonObject }
            val s = FilesTestKit.source(base)
            val backend = WebDav(s, davClient(OkHttpClient(), s, FileCredentials("demo", "demo")))
            val api = FilesApi(s, backend, FileProgress(File(dir, "p.json")), "dev", photos = PhotoIndex(backend, File(dir, "photo-index.json")))
            val all = api.items("ParentId" to Ids.ROOT, "Recursive" to true, "IncludeItemTypes" to "Photo,Video").items
            assertEquals("every photo and the clip, hidden ones left out", photos.size + tree["videos"]!!.jsonArray.size, all.size)
            for (ph in photos) {
                val rel = ph["rel"]!!.jsonPrimitive.content
                val it = all.single { x -> x.id == Ids.encode(rel) }
                val taken = ph["takenAt"]?.jsonPrimitive?.content
                if (taken == null) assertNull(rel, it.premiereDate) else assertEquals(rel, taken, it.premiereDate)
                assertEquals(rel, listOf(ph["w"]!!.jsonPrimitive.content.toInt(), ph["h"]!!.jsonPrimitive.content.toInt()), listOf(it.width, it.height))
            }
            val albums = api.items("ParentId" to Ids.ROOT, "IncludeItemTypes" to "PhotoAlbum").items.map { it.name }
            assertEquals(listOf("Famille › Anniversaires", "Montagne", "Vacances 2019"), albums)
            assertTrue(api.image(all.first { it.type == "Photo" }.id, "Primary", null).startsWith(base))
        } finally {
            p.destroy()
            p.waitFor(5, TimeUnit.SECONDS)
        }
    }
}
