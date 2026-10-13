package com.wika.wicaby.core.torrents

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MainDataTest {
    private fun obj(s: String): JsonObject = Json.parseToJsonElement(s).jsonObject

    private val full = obj(
        """
        {"rid":1,"full_update":true,
         "torrents":{
           "aaa":{"name":"Alpha","size":1000,"progress":0.5,"dlspeed":2048,"upspeed":0,"eta":120,"state":"downloading","category":"films","added_on":10},
           "bbb":{"name":"Bravo","size":500,"progress":1,"dlspeed":0,"upspeed":512,"eta":8640000,"state":"stalledUP","category":"","added_on":20}
         },
         "categories":{"films":{"name":"films","savePath":"/data/films"},"series":{"name":"series","savePath":"/data/tv"}},
         "tags":["hd","fr"],
         "server_state":{"dl_info_speed":2048,"up_info_speed":512,"use_alt_speed_limits":false,"free_space_on_disk":1000000,"connection_status":"connected"}}
        """,
    )

    @Test
    fun fullUpdateFillsEverything() {
        val d = MainData().merge(full)
        assertEquals(1L, d.rid)
        val list = d.torrentList().associateBy { it.hash }
        assertEquals(setOf("aaa", "bbb"), list.keys)
        val a = list.getValue("aaa")
        assertEquals("Alpha", a.name)
        assertEquals(0.5f, a.progress, 0f)
        assertEquals(2048L, a.dlSpeed)
        assertEquals(TorrentStatus.Downloading, a.status)
        assertTrue(a.hasEta)
        val b = list.getValue("bbb")
        assertEquals(TorrentStatus.Seeding, b.status)
        assertFalse(b.hasEta)
        assertTrue(b.isComplete)
        assertEquals(listOf("films", "series"), d.categories.keys.toList())
        assertEquals("/data/tv", d.categories.getValue("series").savePath)
        assertEquals(listOf("hd", "fr"), d.tags)
        val s = d.serverState()
        assertEquals(2048L, s.dlSpeed)
        assertEquals("connected", s.connection)
        assertFalse(s.altSpeed)
    }

    @Test
    fun partialUpdatePatchesOnlyChangedFields() {
        val d = MainData().merge(full).merge(
            obj(
                """
                {"rid":2,
                 "torrents":{"aaa":{"progress":0.75,"dlspeed":4096},"ccc":{"name":"Charlie","state":"pausedDL","added_on":30}},
                 "torrents_removed":["bbb"],
                 "categories":{"docs":{"name":"docs","savePath":"/data/docs"}},
                 "categories_removed":["series"],
                 "tags":["4k"],"tags_removed":["fr"],
                 "server_state":{"use_alt_speed_limits":true,"dl_info_speed":4096}}
                """,
            ),
        )
        assertEquals(2L, d.rid)
        val list = d.torrentList().associateBy { it.hash }
        assertEquals(setOf("aaa", "ccc"), list.keys)
        val a = list.getValue("aaa")
        // Untouched fields survive the patch.
        assertEquals("Alpha", a.name)
        assertEquals("films", a.category)
        assertEquals(120L, a.eta)
        assertEquals(0.75f, a.progress, 0f)
        assertEquals(4096L, a.dlSpeed)
        val c = list.getValue("ccc")
        assertTrue(c.isPaused)
        assertEquals(TorrentStatus.Paused, c.status)
        assertEquals(listOf("films", "docs"), d.categories.keys.toList())
        assertEquals(listOf("hd", "4k"), d.tags)
        val s = d.serverState()
        assertTrue(s.altSpeed)
        assertEquals(4096L, s.dlSpeed)
        assertEquals(512L, s.upSpeed)
        assertEquals("connected", s.connection)
    }

    @Test
    fun emptyPartialUpdateKeepsState() {
        val a = MainData().merge(full)
        val b = a.merge(obj("""{"rid":3}"""))
        assertEquals(3L, b.rid)
        assertEquals(a.torrents, b.torrents)
        assertEquals(a.categories, b.categories)
        assertEquals(a.server, b.server)
    }

    @Test
    fun fullUpdateReplacesEverything() {
        val d = MainData().merge(full).merge(
            obj("""{"rid":9,"full_update":true,"torrents":{"zzz":{"name":"Zulu","state":"stoppedUP","progress":1}},"server_state":{"dl_info_speed":1}}"""),
        )
        assertEquals(listOf("zzz"), d.torrentList().map { it.hash })
        assertTrue(d.categories.isEmpty())
        assertTrue(d.tags.isEmpty())
        val z = d.torrentList().single()
        assertTrue(z.isPaused)
        assertEquals(TorrentStatus.Completed, z.status)
        assertEquals(0L, d.serverState().upSpeed)
    }

    @Test
    fun categoryPatchKeepsSavePath() {
        val d = MainData().merge(full).merge(obj("""{"rid":2,"categories":{"films":{"name":"films"}}}"""))
        assertEquals("/data/films", d.categories.getValue("films").savePath)
    }

    @Test
    fun fractionalByteCountsAreTruncated() {
        val d = MainData().merge(obj("""{"rid":1,"full_update":true,"torrents":{"aaa":{"name":"A","size":6657199308.8,"progress":0.81,"dlspeed":1.5e3,"ratio":2.456}}}"""))
        val a = d.torrentList().single()
        assertEquals("A", a.name)
        assertEquals(6657199308L, a.size)
        assertEquals(1500L, a.dlSpeed)
        assertEquals(0.81f, a.progress, 0.0001f)
        assertEquals(2.456, a.ratio, 0.0)
    }

    @Test
    fun statusMapping() {
        assertEquals(TorrentStatus.Paused, TorrentStatus.of("pausedDL"))
        assertEquals(TorrentStatus.Paused, TorrentStatus.of("stoppedDL"))
        assertEquals(TorrentStatus.Completed, TorrentStatus.of("pausedUP"))
        assertEquals(TorrentStatus.Completed, TorrentStatus.of("stoppedUP"))
        assertEquals(TorrentStatus.Stalled, TorrentStatus.of("stalledDL"))
        assertEquals(TorrentStatus.Metadata, TorrentStatus.of("metaDL"))
        assertEquals(TorrentStatus.Error, TorrentStatus.of("missingFiles"))
        assertEquals(TorrentStatus.Checking, TorrentStatus.of("checkingResumeData"))
    }

    @Test
    fun helpers() {
        assertEquals(true, usesStopStart("v5.0.2"))
        assertEquals(false, usesStopStart("v4.6.7"))
        assertEquals(true, usesStopStart(null, "2.11.2"))
        assertEquals(false, usesStopStart(null, "2.9.3"))
        assertEquals(true, usesStopStart("garbage", "3"))
        assertNull(usesStopStart(null, null))

        assertEquals("http://192.168.1.5:8080/", normalizeQbitUrl("192.168.1.5:8080").toString())
        assertEquals("https://nas.lan/qbit/", normalizeQbitUrl(" https://nas.lan/qbit/ ").toString())
        assertNull(normalizeQbitUrl(""))
        assertNull(normalizeQbitUrl("ftp://x"))

        val hash = "0123456789abcdef0123456789abcdef01234567"
        assertEquals(
            listOf("magnet:?xt=urn:btih:abc&dn=x", "https://x.org/a.torrent", "magnet:?xt=urn:btih:$hash"),
            parseLinks("magnet:?xt=urn:btih:abc&dn=x\nhttps://x.org/a.torrent\n  $hash \nnot a link"),
        )
        assertTrue(parseLinks("hello").isEmpty())

        assertNull(formatEta(ETA_INFINITE))
    }
}
