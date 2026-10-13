package com.wika.wicaby.core.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// FS-00: caps(kind) against tools/checks/fixtures/server-caps.json, the table the desktop's caps-check.mjs reads too.
class ServerCapsTest {
    private val table = Json.parseToJsonElement(checkNotNull(javaClass.getResourceAsStream("/server-caps.json")).readBytes().decodeToString()).jsonObject

    private fun row(c: ServerCaps) = mapOf(
        "admin" to c.admin, "liveTv" to c.liveTv, "sessionsRemote" to c.sessionsRemote, "castReceiver" to c.castReceiver, "favorites" to c.favorites,
        "serverHubs" to c.serverHubs, "hideFromResume" to c.hideFromResume, "subtitleSearch" to c.subtitleSearch, "comics" to c.comics,
        "localUserData" to c.localUserData, "transcode" to c.transcode, "castSend" to c.castSend, "homeOptIn" to c.homeOptIn,
    )

    @Test
    fun everyKindMatchesTheSharedTable() {
        val kinds = table.keys.filterNot { it.startsWith("$") || it.startsWith("_") }
        assertEquals(setOf("emby", "jellyfin", "plex", "files"), kinds.toSet())
        for (kind in kinds) {
            val expect = table.getValue(kind).jsonObject
            for (probed in listOf(false, true)) {
                val got = row(caps(kind, liveTv = probed))
                assertEquals("$kind: flags", expect.keys, got.keys)
                for ((flag, v) in expect) {
                    val want = (v as JsonPrimitive).booleanOrNull ?: run {
                        assertEquals("$kind.$flag", "probed", v.content)
                        probed
                    }
                    assertEquals("$kind.$flag (live TV probed: $probed)", want, got[flag])
                }
            }
        }
    }

    // The same answer as the desktop's caps-check: an unknown kind gets the row "$unknownKind" names.
    @Test
    fun anUnknownKindGetsTheRowTheTableNames() {
        val want = table.getValue("\$unknownKind").let { (it as JsonPrimitive).content }
        for (kind in listOf("unknown", "")) {
            for (probed in listOf(false, true)) assertEquals(kind, caps(want, liveTv = probed), caps(kind, liveTv = probed))
        }
    }

    @Test
    fun aFileSourceNeverFallsIntoTheJellyfinBranch() {
        val s = Server("0123456789abcdef0123456789abcdef", "Films", "files:x", "files")
        assertTrue(s.isFiles)
        assertFalse(s.isEmby)
        assertFalse(s.caps.admin || s.caps.castSend || s.caps.transcode || s.caps.favorites)
        assertTrue(s.caps.localUserData && s.caps.homeOptIn)
    }
}
