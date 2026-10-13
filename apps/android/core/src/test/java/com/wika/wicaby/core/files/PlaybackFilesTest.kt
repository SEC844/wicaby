package com.wika.wicaby.core.files

import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.files.FilesTestKit.MemoryBackend
import com.wika.wicaby.core.files.FilesTestKit.dir
import com.wika.wicaby.core.files.FilesTestKit.file
import com.wika.wicaby.core.files.pure.Ids
import com.wika.wicaby.core.player.SessionReporter
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// FS-09 PlaybackFilesTest: Playback's /Sessions/Playing reports, built by the real SessionReporter, become local
// writes: one per pause and one per stop, at most one per 30 s in between, none at start; the duration learnt at play
// (tags) decides "played".
class PlaybackFilesTest {
    private val tmp = FilesTestKit.tempDir()
    private var clock = 0L
    private val rel = "Films/Example.Movie.2019.mkv"
    private val id = Ids.encode(rel)!!
    private val progress = FileProgress(File(tmp, "progress.json"))
    private val api = FilesApi(
        FilesTestKit.source(), MemoryBackend(mapOf("" to listOf(dir("Films")), "Films" to listOf(file("Example.Movie.2019.mkv")))), progress, "dev",
    ) { clock }
    private val reporter = SessionReporter(api)

    @After
    fun tearDown() {
        tmp.deleteRecursively()
    }

    private fun body(posMs: Long, paused: Boolean, event: String?) = reporter.body(
        SessionReporter.State(id, id, "files-$id", posMs * 10_000, paused, muted = false, volume = null, playMethod = "DirectPlay", canSeek = true),
        event,
    ).toString()

    private suspend fun at(ms: Long, path: String, posMs: Long, event: String? = null, paused: Boolean = false) {
        clock = ms
        api.raw("POST", path, body(posMs, paused, event))
    }

    @Test
    fun oneWritePerPauseAndStop() = runBlocking {
        val item: Item = api.item(id)
        assertEquals("Movie", item.type)
        api.tags(id, 600_000, "Example Tag Title")
        at(0, "/Sessions/Playing", 0)
        at(10_000, "/Sessions/Playing/Progress", 10_000, "TimeUpdate")
        at(20_000, "/Sessions/Playing/Progress", 20_000, "TimeUpdate")
        assertEquals("nothing written in the first 30 s", 0, progress.writes)
        at(25_000, "/Sessions/Playing/Progress", 25_000, "Pause", paused = true)
        assertEquals(1, progress.writes)
        at(40_000, "/Sessions/Playing/Progress", 25_000, "Unpause")
        at(50_000, "/Sessions/Playing/Progress", 35_000, "TimeUpdate")
        assertEquals(1, progress.writes)
        at(60_000, "/Sessions/Playing/Progress", 45_000, "TimeUpdate") // 35 s after the pause write
        assertEquals(2, progress.writes)
        at(70_000, "/Sessions/Playing/Ping", 0)
        at(75_000, "/Sessions/Playing/Stopped", 300_000)
        assertEquals(3, progress.writes)
        val r = progress.get(rel)!!
        assertEquals(300_000L, r.positionMs)
        assertEquals(600_000L, r.durationMs)
        assertEquals("Example Tag Title", r.title)
        assertEquals(75_000L, r.lastPlayedAt)
        // Stopped at 95 %: played, no resume point.
        at(100_000, "/Sessions/Playing", 0)
        at(160_000, "/Sessions/Playing/Stopped", 570_000)
        assertTrue(progress.get(rel)!!.played)
        assertEquals(0L, progress.get(rel)!!.positionMs)
        assertEquals(4, progress.writes)
    }
}
