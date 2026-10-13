package com.wika.wicaby.core.player

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Jellyfin trickplay: manifest shapes, width choice, and index -> sheet/x/y (same geometry as
// tools/mock-server/mock-jellyfin.mjs: 320x180 tiles, 10x10 per sheet, one every 10 s).
class TrickplayTilesTest {
    private val info = """{"Width":320,"Height":180,"TileWidth":10,"TileHeight":10,"ThumbnailCount":250,"Interval":10000,"Bandwidth":1}"""

    private fun obj(s: String) = Json.parseToJsonElement(s).jsonObject

    @Test
    fun perSourceAndFlatShapes() {
        val perSource = obj("""{"ms1":{"320":$info}}""")
        assertEquals(320, JellyfinTiles.pick(perSource, "ms1")?.width)
        // Another source id falls back to the only one listed.
        assertEquals(320, JellyfinTiles.pick(perSource, "other")?.width)
        assertEquals(250, JellyfinTiles.pick(obj("""{"320":$info}"""), "ms1")?.thumbnailCount)
        assertNull(JellyfinTiles.pick(null, "ms1"))
        assertNull(JellyfinTiles.pick(obj("{}"), "ms1"))
    }

    @Test
    fun smallestWidthOfAtLeast320ElseLargest() {
        val i = { w: Int -> info.replace("\"Width\":320", "\"Width\":$w") }
        assertEquals(480, JellyfinTiles.pick(obj("""{"ms":{"160":${i(160)},"640":${i(640)},"480":${i(480)}}}"""), "ms")?.width)
        assertEquals(240, JellyfinTiles.pick(obj("""{"ms":{"160":${i(160)},"240":${i(240)}}}"""), "ms")?.width)
    }

    @Test
    fun tilesMapAtFirstLastAndAcrossSheets() {
        val t = JellyfinTiles(JellyfinTiles.pick(obj("""{"320":$info}"""), "x")!!)
        assertEquals(3, t.sheets)
        assertEquals(Tile(0, 0, 0, 0), t.at(0))
        assertEquals(Tile(0, 0, 0, 0), t.at(9_999))
        assertEquals(Tile(11, 0, 320, 180), t.at(110_000))
        // Last tile of sheet 0, then first of sheet 1.
        assertEquals(Tile(99, 0, 9 * 320, 9 * 180), t.at(990_000))
        assertEquals(Tile(100, 1, 0, 0), t.at(1_000_000))
        // The last index, and past the end clamps to it.
        assertEquals(Tile(249, 2, 9 * 320, 4 * 180), t.at(2_490_000))
        assertEquals(Tile(249, 2, 9 * 320, 4 * 180), t.at(99_000_000))
        assertEquals(Tile(0, 0, 0, 0), t.at(-5))
    }
}
