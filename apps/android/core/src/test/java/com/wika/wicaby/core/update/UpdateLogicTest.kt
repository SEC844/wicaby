package com.wika.wicaby.core.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateLogicTest {
    @Test
    fun versionNames() {
        assertTrue(UpdateLogic.compareVersionNames("0.4.0", "0.3.10") > 0)
        assertTrue(UpdateLogic.compareVersionNames("0.3.10", "0.3.9") > 0)
        assertEquals(0, UpdateLogic.compareVersionNames("1.0", "1.0.0"))
        assertEquals(0, UpdateLogic.compareVersionNames("v0.4.0-beta", "0.4.0"))
        assertTrue(UpdateLogic.compareVersionNames("0.2.0", "0.10.0") < 0)
    }

    @Test
    fun newerByCodeThenName() {
        assertTrue(UpdateLogic.isNewer(Release(versionCode = 6, versionName = "0.4.0"), 5, "0.3.1"))
        assertFalse(UpdateLogic.isNewer(Release(versionCode = 6, versionName = "0.4.0"), 6, "0.4.0"))
        // The code decides even when the name looks older.
        assertFalse(UpdateLogic.isNewer(Release(versionCode = 4, versionName = "9.9.9"), 6, "0.4.0"))
        assertTrue(UpdateLogic.isNewer(Release(versionName = "0.4.1"), 6, "0.4.0"))
    }

    @Test
    fun abiChoice() {
        val all = mapOf("arm64-v8a" to ApkRef("a64.apk", "1"), "armeabi-v7a" to ApkRef("a7.apk", "2"), "universal" to ApkRef("u.apk", "3"))
        assertEquals("arm64-v8a", UpdateLogic.pickApk(all, listOf("arm64-v8a", "armeabi-v7a"))?.first)
        assertEquals("armeabi-v7a", UpdateLogic.pickApk(all, listOf("armeabi-v7a", "armeabi"))?.first)
        // An x86_64 emulator (or anything not built) gets the universal APK.
        assertEquals("universal", UpdateLogic.pickApk(all, listOf("x86_64", "arm64-v8a"))?.first)
        // No universal: another ABI the device runs.
        assertEquals("armeabi-v7a", UpdateLogic.pickApk(all - "universal" - "arm64-v8a", listOf("arm64-v8a", "armeabi-v7a"))?.first)
        assertNull(UpdateLogic.pickApk(mapOf("arm64-v8a" to ApkRef("a.apk")), listOf("x86")))
    }

    @Test
    fun manifest() {
        val m = UpdateLogic.parse(
            """{ "tv": { "versionCode": 6, "versionName": "0.4.0", "notes": {"fr":"Nouveau","en":"New"},
                 "apks": { "universal": {"url": "tv/Wicaby-TV-0.4.0-universal.apk", "sha256": "AB"} } }, "mobile": {} }""",
        )
        val tv = m.getValue("tv")
        assertEquals(6, tv.versionCode)
        assertEquals("New", UpdateLogic.notes(tv, "en"))
        assertEquals("New", UpdateLogic.notes(tv, "de"))
        assertEquals("Nouveau", UpdateLogic.notes(tv, "fr"))
        assertEquals(
            "http://10.0.2.2:8600/release/tv/Wicaby-TV-0.4.0-universal.apk",
            UpdateLogic.resolve("http://10.0.2.2:8600/release/update.json", tv.apks.getValue("universal").url),
        )
        assertEquals("https://x.y/a.apk", UpdateLogic.resolve("http://10.0.2.2/update.json", "https://x.y/a.apk"))
    }

    private val sha = "a".repeat(64)

    @Test
    fun httpsOnly() {
        assertTrue(UpdateLogic.isAllowedUrl("https://example.org/update.json"))
        assertFalse(UpdateLogic.isAllowedUrl("http://example.org/update.json"))
        assertFalse(UpdateLogic.isAllowedUrl("ftp://example.org/update.json"))
        assertFalse(UpdateLogic.isAllowedUrl("not a url"))
        // Debug builds may test against the emulator's http server.
        assertTrue(UpdateLogic.isAllowedUrl("http://10.0.2.2:8600/update.json", allowCleartext = true))
    }

    @Test
    fun sha256Required() {
        assertTrue(UpdateLogic.isValidSha256(sha))
        assertTrue(UpdateLogic.isValidSha256(sha.uppercase()))
        assertFalse(UpdateLogic.isValidSha256(""))
        assertFalse(UpdateLogic.isValidSha256("AB"))
        assertFalse(UpdateLogic.isValidSha256("g".repeat(64)))
    }

    @Test
    fun usableApk() {
        val m = "https://x.y/release/update.json"
        assertEquals(ApkRef("https://x.y/release/tv/a.apk", sha), UpdateLogic.usableApk(m, ApkRef("tv/a.apk", sha.uppercase())))
        assertNull(UpdateLogic.usableApk(m, ApkRef("tv/a.apk", "")))
        assertNull(UpdateLogic.usableApk(m, ApkRef("tv/a.apk")))
        // An absolute http APK URL in an https manifest is refused too.
        assertNull(UpdateLogic.usableApk(m, ApkRef("http://evil.example/a.apk", sha)))
        assertNull(UpdateLogic.usableApk("http://x.y/update.json", ApkRef("a.apk", sha)))
    }

    @Test
    fun archiveGate() {
        val mine = setOf("c1")
        fun ok(pkg: String? = "com.wika.wicaby.tv", code: Long = 7, expected: Long = 7, signers: Set<String> = mine, installed: Set<String> = mine) =
            UpdateLogic.archiveAcceptable("com.wika.wicaby.tv", pkg, 6, code, expected, installed, signers)
        assertTrue(ok())
        // Rotated key: the archive's lineage still contains the installed certificate.
        assertTrue(ok(signers = setOf("c1", "c2")))
        assertTrue(ok(expected = 0))
        assertFalse(ok(pkg = "com.evil"))
        assertFalse(ok(pkg = null))
        assertFalse(ok(code = 6, expected = 6))
        assertFalse(ok(code = 5, expected = 0))
        assertFalse(ok(code = 8))
        assertFalse(ok(signers = setOf("c2")))
        assertFalse(ok(signers = emptySet()))
        assertFalse(ok(installed = emptySet(), signers = emptySet()))
    }
}
