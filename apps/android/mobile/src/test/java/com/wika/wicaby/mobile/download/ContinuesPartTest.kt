package com.wika.wicaby.mobile.download

import com.wika.wicaby.core.data.Item
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
}
