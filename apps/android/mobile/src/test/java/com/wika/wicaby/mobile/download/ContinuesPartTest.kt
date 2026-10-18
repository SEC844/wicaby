package com.wika.wicaby.mobile.download

import com.wika.wicaby.core.data.Item
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// A Range resume appends to the .part only when the 206 is the same file; anything else restarts from 0.
class ContinuesPartTest {
    @Test
    fun sameFileContinues() {
        assertTrue(continuesPart(500, "bytes 500-999/1000", "\"v1\"", "\"v1\"", 1000))
        // Only the size was recorded (no ETag/Last-Modified from the server).
        assertTrue(continuesPart(500, "bytes 500-999/1000", null, null, 1000))
        // Only the validator was recorded (size unknown).
        assertTrue(continuesPart(500, "bytes 500-999/*", "\"v1\"", "\"v1\"", 0))
    }

    @Test
    fun changedSourceRestarts() {
        assertFalse(continuesPart(500, "bytes 500-1199/1200", "\"v2\"", "\"v1\"", 1000))
        assertFalse(continuesPart(500, "bytes 500-999/1000", "\"v2\"", "\"v1\"", 1000))
        assertFalse(continuesPart(500, "bytes 500-1199/1200", null, null, 1000))
        assertFalse(continuesPart(500, "bytes 500-999/1000", null, "\"v1\"", 1000))
    }

    @Test
    fun unprovableRestarts() {
        // Wrong offset, missing or malformed Content-Range, nothing recorded to compare with.
        assertFalse(continuesPart(500, "bytes 0-999/1000", "\"v1\"", "\"v1\"", 1000))
        assertFalse(continuesPart(500, null, "\"v1\"", "\"v1\"", 1000))
        assertFalse(continuesPart(500, "garbage", "\"v1\"", "\"v1\"", 1000))
        assertFalse(continuesPart(500, "bytes 500-999/1000", "\"v1\"", null, 0))
        assertFalse(continuesPart(500, "bytes 500-999/*", null, null, 1000))
    }

    @Test
    fun reDownloadKeepsWhatThePartWasCheckedAgainst() {
        // enqueue() keeps the old validator only for the same file and version; otherwise it deletes the .part.
        val old = DownloadEntry("a", "s", "u", Item("a"), "/d/a.mkv", total = 1000, sourceId = "v1", validator = "\"e1\"")
        assertTrue(keepsPart(old, "/d/a.mkv", "v1"))
        assertFalse(keepsPart(old, "/d/a.mkv", "v2"))
        assertFalse(keepsPart(old, "/d/a.mp4", "v1"))
        // Kept validator: a same-size source edited in place no longer splices.
        assertFalse(continuesPart(500, "bytes 500-999/1000", "\"e2\"", old.validator, old.total))
    }

    // A failed copy from a released build ("<id>.mkv" + its .part) re-downloads into the same file, so it resumes.
    @Test
    fun legacyFileNameIsKeptOnReDownload() {
        assertEquals("/d/4512.mkv", targetPath("/d/4512.mkv", "/d/4512.mkv", "/d/srvA-4512.mkv"))
        assertEquals("/d/srvA-4512.mkv", targetPath(null, "/d/4512.mkv", "/d/srvA-4512.mkv"))
        // Another version (other extension): the new name.
        assertEquals("/d/srvA-4512.mp4", targetPath("/d/4512.mkv", "/d/4512.mp4", "/d/srvA-4512.mp4"))
    }

    // Two Emby servers both have an item "4512": each copy is its server's, never the other's.
    @Test
    fun copiesAreKeyedByServerAndId() {
        val a = DownloadEntry("4512", "srvA", "u", Item("4512"), "/d/srvA-4512.mkv")
        assertTrue(a.isOf("srvA", "4512"))
        assertFalse(a.isOf("srvB", "4512"))
        assertFalse(workName("srvA", "4512") == workName("srvB", "4512"))
    }

    // Released builds queued "dl-<id>": the startup check and delete() must still find that job.
    @Test
    fun legacyWorkNameMatchesReleasedBuilds() {
        assertEquals("dl-4512", legacyWorkName("4512"))
        assertFalse(legacyWorkName("4512") == workName("srvA", "4512"))
    }
}
