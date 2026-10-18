package com.wika.wicaby.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class SafeNamesTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun ids() {
        assertTrue(SafeNames.isValidId("12345"))
        assertTrue(SafeNames.isValidId("a1b2c3d4-e5f6-7890-abcd-ef0123456789"))
        assertTrue(SafeNames.isValidId("tr_3f9a")) // Navidrome typed ids (SubsonicMap)
        assertTrue(SafeNames.isValidId("al__YS9i"))
        assertFalse(SafeNames.isValidId(null))
        assertFalse(SafeNames.isValidId(""))
        assertFalse(SafeNames.isValidId("../index"))
        assertFalse(SafeNames.isValidId("a/b"))
        assertFalse(SafeNames.isValidId("a.b"))
        assertFalse(SafeNames.isValidId("a%2F"))
        assertFalse(SafeNames.isValidId("x".repeat(65)))
    }

    @Test
    fun extensions() {
        assertEquals("mkv", SafeNames.extension("mkv"))
        assertEquals("mp4", SafeNames.extension("mp4,m4v"))
        assertEquals("mp4", SafeNames.extension("MP4"))
        assertEquals("mkv", SafeNames.extension(null))
        assertEquals("mkv", SafeNames.extension(""))
        assertEquals("mkv", SafeNames.extension("../../x"))
        assertEquals("mkv", SafeNames.extension("a/b"))
        assertEquals("mkv", SafeNames.extension("toolongext"))
    }

    @Test
    fun containment() {
        val dir = tmp.newFolder("downloads")
        assertTrue(SafeNames.isInside(dir, File(dir, "123.mkv")))
        assertFalse(SafeNames.isInside(dir, File(dir, "../index.json")))
        assertFalse(SafeNames.isInside(dir, dir))
        // A sibling whose name starts with the same prefix is outside.
        assertFalse(SafeNames.isInside(dir, File(dir.parentFile, "downloads-evil/x")))
    }
}
