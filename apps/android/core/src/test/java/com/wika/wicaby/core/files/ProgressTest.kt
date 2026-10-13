package com.wika.wicaby.core.files

import com.wika.wicaby.core.files.FilesTestKit.MemoryBackend
import com.wika.wicaby.core.files.FilesTestKit.dir
import com.wika.wicaby.core.files.FilesTestKit.file
import com.wika.wicaby.core.files.pure.Ids
import com.wika.wicaby.core.files.pure.ProgressDoc
import com.wika.wicaby.core.files.pure.ProgressRecord
import com.wika.wicaby.core.files.pure.ProgressRules
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// FS-08 ProgressTest: the local watch state through FilesApi (thresholds, a replaced file starting over, Continue and
// "next in folder", played and hidden) and the store's LRU cap at 10,000 records.
class ProgressTest {
    private val tmp = FilesTestKit.tempDir()
    private var clock = 1_000_000L
    private val season = "Shows/Example Show/Season 1"
    private fun ep(n: Int) = "Example.Show.S01E%02d.mkv".format(n)
    private fun id(n: Int) = Ids.encode("$season/${ep(n)}")!!

    @After
    fun tearDown() {
        tmp.deleteRecursively()
    }

    private fun tree(size1: Long = 1_000) = MemoryBackend(
        mapOf(
            "" to listOf(dir("Shows")),
            "Shows" to listOf(dir("Example Show")),
            "Shows/Example Show" to listOf(dir("Season 1")),
            season to (1..3).map { file(ep(it), size = if (it == 1) size1 else 1_000) },
        ),
    )

    private fun api(backend: FileBackend, progress: FileProgress = FileProgress(File(tmp, "progress.json"))) =
        FilesApi(FilesTestKit.source(), backend, progress, "dev") { clock }

    private suspend fun FilesApi.play(id: String, positionMs: Long, durationMs: Long) {
        item(id)
        tags(id, durationMs, null)
        raw("POST", "/Sessions/Playing", """{"ItemId":"$id","PositionTicks":0}""")
        clock += 60_000
        raw("POST", "/Sessions/Playing/Stopped", """{"ItemId":"$id","PositionTicks":${positionMs * 10_000}}""")
    }

    @Test
    fun thresholdsDecideResumeAndPlayed() = runBlocking {
        val api = api(tree())
        api.play(id(1), 20_000, 600_000) // 3 %: no resume point
        assertEquals(0L, api.item(id(1)).userData!!.playbackPositionTicks)
        api.play(id(1), 300_000, 600_000)
        assertEquals(300_000L * 10_000, api.item(id(1)).userData!!.playbackPositionTicks)
        assertEquals(listOf(id(1)), api.resume().map { it.id })
        api.play(id(1), 545_000, 600_000) // 90 % or more: played, position cleared
        val done = api.item(id(1)).userData!!
        assertTrue(done.played)
        assertEquals(0L, done.playbackPositionTicks)
        // Played E01: Continue offers the next file in the folder (no scan), not E01.
        assertEquals(listOf(id(2)), api.resume().map { it.id })
    }

    @Test
    fun aReplacedFileStartsOver() = runBlocking {
        val progress = FileProgress(File(tmp, "progress.json"))
        val first = api(tree(), progress)
        first.play(id(1), 300_000, 600_000)
        // The same path, another size: the old position does not apply, and the player is told why (once).
        val second = api(tree(size1 = 2_000), progress)
        val item = second.item(id(1))
        assertNull(item.userData)
        assertTrue(second.changed(id(1)))
        assertFalse(second.changed(id(1)))
    }

    @Test
    fun playedAndHiddenAreLocal() = runBlocking {
        val api = api(tree())
        api.setPlayed(id(3), true)
        assertTrue(api.item(id(3)).userData!!.played)
        api.setPlayed(id(3), false)
        assertFalse(api.item(id(3)).userData!!.played)
        api.play(id(2), 300_000, 600_000)
        api.hideFromResume(id(2), true)
        assertTrue(api.resume().none { it.id == id(2) })
        api.play(id(2), 310_000, 600_000) // watched again: back in Continue
        assertEquals(id(2), api.resume().first().id)
    }

    @Test
    fun theStoreKeepsTheTenThousandMostRecent() {
        val f = File(tmp, "progress-big.json")
        val seeded = (0 until ProgressRules.MAX_RECORDS).associate { i -> "f$i.mkv" to ProgressRecord(1, 1, lastPlayedAt = 10L + i) }
        SourceStore.writeAtomic(f, filesJson.encodeToString(ProgressDoc.serializer(), ProgressDoc(1, seeded)))
        val store = FileProgress(f)
        store.update("new.mkv") { ProgressRecord(1, 1, positionMs = 5, lastPlayedAt = 1_000_000) }
        val all = FileProgress(f).all()
        assertEquals(ProgressRules.MAX_RECORDS, all.size)
        assertTrue("new.mkv" in all)
        assertFalse("the oldest goes", "f0.mkv" in all)
        assertTrue("f1.mkv" in all)
        assertEquals(1, store.writes)
    }
}
