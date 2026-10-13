package com.wika.wicaby.core.livetv

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files

// LivePrefs (spec §5.4): read-modify-write of lt.* keys only, the 2 s debounce, one serialized
// queue, refuse-to-write while the document failed to load, and the DataStore mirror.
class LivePrefsTest {
    private lateinit var dir: File
    private lateinit var scope: CoroutineScope

    /** A fake server document. */
    private var doc = JsonObject(mapOf("Id" to JsonPrimitive(PREFS_ID), "SortBy" to JsonPrimitive("SortName"), "CustomPrefs" to custom("other.app" to "keep", "lt.sort" to "name")))
    private var readFails = false
    private var writeFails = false
    private val posts = mutableListOf<JsonObject>()

    private fun custom(vararg kv: Pair<String, String>) = JsonObject(kv.associate { it.first to JsonPrimitive(it.second) })

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("prefs").toFile()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }

    @After
    fun tearDown() {
        scope.cancel()
        dir.deleteRecursively()
    }

    private val store by lazy { PreferenceDataStoreFactory.create(scope = scope) { File(dir, "live.preferences_pb") } }

    private fun prefs(debounceMs: Long = 50) = LivePrefs(
        read = { if (readFails) throw IOException("offline") else doc },
        write = { body ->
            if (writeFails) throw IOException("500")
            synchronized(posts) { posts.add(body) }
            doc = body
        },
        scope = scope,
        mirror = store,
        mirrorKey = "srv.user",
        debounceMs = debounceMs,
    )

    private fun customOf(o: JsonObject) = customPrefsOf(o)

    private suspend fun awaitPosts(n: Int) = withTimeout(5_000) { while (synchronized(posts) { posts.size } < n) delay(10) }

    @Test
    fun loadsAndWritesOnlyLtKeys() = runBlocking {
        val p = prefs()
        p.load()
        assertEquals(PrefsLoad.OK, p.load.value)
        assertEquals(SortMode.NAME, p.prefs.value.sort)
        p.update(PrefField.FAV_FIRST, p.prefs.value.copy(favFirst = true))
        assertTrue("applied at once", p.prefs.value.favFirst)
        awaitPosts(1)
        val body = posts.single()
        val c = customOf(body)
        assertEquals("keep", c["other.app"])
        assertEquals("1", c["lt.favFirst"])
        assertEquals("name", c["lt.sort"])
        assertEquals(PREFS_VERSION, c["lt.v"])
        assertEquals(JsonPrimitive("wicaby"), body["Client"])
        assertEquals(JsonPrimitive("SortName"), body["SortBy"]) // the rest of the DTO goes back whole
    }

    @Test
    fun debounceMergesChangesIntoOneWrite() = runBlocking {
        val p = prefs(debounceMs = 200)
        p.load()
        p.update(PrefField.SORT, p.prefs.value.copy(sort = SortMode.NUMBER))
        p.update(PrefField.RECENTS, p.prefs.value.copy(recents = listOf("a")))
        p.update(PrefField.RECENTS, p.prefs.value.copy(recents = listOf("b", "a")))
        awaitPosts(1)
        delay(400)
        assertEquals(1, posts.size)
        val c = customOf(posts.single())
        assertEquals("number", c["lt.sort"])
        assertEquals("[\"b\",\"a\"]", c["lt.recents"])
    }

    @Test
    fun readModifyWriteKeepsAnotherDevicesChange() = runBlocking {
        val p = prefs()
        p.load()
        // Another device writes lt.hidden after our load.
        doc = JsonObject(doc + ("CustomPrefs" to custom("other.app" to "keep", "lt.sort" to "name", "lt.hidden.0" to "[\"x\"]")))
        p.update(PrefField.FAV, p.prefs.value.copy(fav = listOf("f1")))
        awaitPosts(1)
        val c = customOf(posts.single())
        assertEquals("[\"x\"]", c["lt.hidden.0"])
        assertEquals("[\"f1\"]", c["lt.fav.0"])
    }

    @Test
    fun refusesToWriteUntilTheDocumentLoaded() = runBlocking {
        readFails = true
        val p = prefs()
        p.load()
        assertEquals(PrefsLoad.FAILED, p.load.value)
        assertFalse(p.canEditFavorites(true))
        p.update(PrefField.SORT, p.prefs.value.copy(sort = SortMode.SERVER))
        assertEquals(SortMode.SERVER, p.prefs.value.sort)
        p.flush()
        delay(200)
        assertTrue("no empty overwrite", posts.isEmpty())
        // The server answers again: the queued change is written over the real document.
        readFails = false
        p.load()
        assertEquals(SortMode.SERVER, p.prefs.value.sort) // the queued change wins over the loaded value
        awaitPosts(1)
        val c = customOf(posts.single())
        assertEquals("server", c["lt.sort"])
        assertEquals("keep", c["other.app"])
        assertTrue(p.canEditFavorites(true))
    }

    @Test
    fun failedWriteIsQueuedAgain() = runBlocking {
        val p = prefs()
        p.load()
        writeFails = true
        p.update(PrefField.FAV_FIRST, p.prefs.value.copy(favFirst = true))
        withTimeout(5_000) { while (!p.syncFailed.value) delay(10) }
        writeFails = false
        p.flush()
        assertEquals("1", customOf(posts.single())["lt.favFirst"])
        assertFalse(p.syncFailed.value)
    }

    @Test
    fun mirrorShowsTheLastDocumentOffline() = runBlocking {
        prefs().apply {
            load()
            update(PrefField.LENS, prefs.value.copy(lens = LensRef.Favorites))
            flush()
        }
        readFails = true
        val offline = prefs()
        offline.load()
        assertEquals(PrefsLoad.FAILED, offline.load.value)
        assertEquals(LensRef.Favorites, offline.prefs.value.lens)
        assertEquals(SortMode.NAME, offline.prefs.value.sort)
    }
}
