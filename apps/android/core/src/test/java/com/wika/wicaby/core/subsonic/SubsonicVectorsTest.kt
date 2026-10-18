package com.wika.wicaby.core.subsonic

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// MU-N3: the Kotlin Subsonic dialect against the vectors the desktop's subsonic-check.mjs reads too
// (tools/checks/fixtures/subsonic/vectors.json, read in place). Same cases, same outputs.
class SubsonicVectorsTest {
    private val v = Json.parseToJsonElement(File("../../../tools/checks/fixtures/subsonic/vectors.json").readText()).jsonObject
    private fun list(k: String) = v.getValue(k).jsonArray.map { it.jsonObject }
    private fun JsonObject.s(k: String) = this[k]?.jsonPrimitive?.contentOrNull

    @Test
    fun tokenAuth() {
        for (c in list("auth")) assertEquals(c.s("name"), c.s("token"), SubsonicMap.token(c.s("password")!!, c.s("salt")!!))
        val a = SubsonicApi.salt()
        assertTrue(a.length == 16 && a != SubsonicApi.salt())
    }

    @Test
    fun ids() {
        for (c in list("ids")) {
            assertEquals(c.s("raw"), c.s("id"), SubsonicMap.encodeId(c.s("kind")!!, c.s("raw")!!))
            assertEquals(c.s("id"), SubsonicMap.Id(c.s("kind")!!, c.s("raw")!!), SubsonicMap.decodeId(c.s("id")))
            assertTrue(Regex("^[A-Za-z0-9_-]{1,64}$").matches(c.s("id")!!))
        }
        for (bad in v.getValue("badIds").jsonArray) assertNull(bad.toString(), SubsonicMap.decodeId(bad.jsonPrimitive.content))
    }

    @Test
    fun albumListArgs() {
        for (c in list("albumList")) {
            val q = c.getValue("query").jsonObject.mapValues { it.value.jsonPrimitive.content }
            assertEquals(q.toString(), c.getValue("args").jsonObject.mapValues { it.value.jsonPrimitive.content }, SubsonicMap.albumListArgs(q))
        }
    }

    @Test
    fun musicSource() {
        val views = list("musicSourceViews")
        for (c in list("musicSource")) {
            val got = com.wika.wicaby.core.music.MusicSource.filter(views, c.s("source")!!, { it.s("ServerId") }, { it.s("CollectionType") }).map { it.s("Id") }
            assertEquals(c.s("name"), c.getValue("expected").jsonArray.map { it.jsonPrimitive.content }, got)
        }
    }

    @Test
    fun scrobbleThreshold() {
        for (c in list("scrobble")) {
            val pos = c.getValue("positionS").jsonPrimitive.long * 10_000_000
            val run = c.getValue("runTimeS").jsonPrimitive.long * 10_000_000
            assertEquals(c.toString(), c.getValue("due").jsonPrimitive.content == "true", SubsonicMap.scrobbleDue(pos, run))
        }
    }

    @Test
    fun lyrics() {
        for (c in list("lyrics")) {
            val got = SubsonicMap.lyricsToJellyfin(c["structured"]?.jsonArray?.map { it.jsonObject }, c.s("legacy"))
            val want = c.getValue("expected")
            if (want is JsonNull) assertNull(c.s("name"), got) else assertEquals(c.s("name"), want, got)
        }
    }

    @Test
    fun songRecord() {
        val song = v.getValue("song").jsonObject
        val s = SubsonicMap.song(song.getValue("record"))
        val e = song.getValue("expected").jsonObject
        for (k in listOf("Id", "Name", "Type", "MediaType", "Album", "AlbumId", "IndexNumber", "ParentIndexNumber", "RunTimeTicks", "Container", "NormalizationGain")) {
            assertEquals(k, (e.getValue(k) as JsonPrimitive).content, (s.getValue(k) as JsonPrimitive).content)
        }
        assertEquals(e.s("Primary"), s["ImageTags"]!!.jsonObject.s("Primary"))
        assertEquals(e.s("IsFavorite"), s["UserData"]!!.jsonObject.s("IsFavorite"))
        assertEquals(e.s("PlayCount"), s["UserData"]!!.jsonObject.s("PlayCount"))
        assertEquals(e.s("ArtistId"), s["ArtistItems"]!!.jsonArray[0].jsonObject.s("Id"))
        assertEquals(s.s("Id"), s["MediaSources"]!!.jsonArray[0].jsonObject.s("Id"))
    }
}
