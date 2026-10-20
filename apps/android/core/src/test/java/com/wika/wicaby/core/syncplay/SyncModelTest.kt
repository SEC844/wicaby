package com.wika.wicaby.core.syncplay

import com.wika.wicaby.core.livetv.parseServerDate
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncModelTest {
    private fun at(iso: String) = parseServerDate(iso)!!

    @Test
    fun offsetFromASymmetricRoundTrip() {
        val s = TimeSync()
        // Server 5 s ahead, 100 ms each way, 10 ms on the server.
        s.add(sent = 1_000, serverIn = 6_100, serverOut = 6_110, received = 1_210)
        assertEquals(5_000L, s.offsetMs)
        assertEquals(200L, s.pingMs)
        assertEquals(6_000L, s.toServer(1_000))
        assertEquals(1_000L, s.toLocal(6_000))
    }

    @Test
    fun shortestRoundTripWins() {
        val s = TimeSync(keep = 3)
        s.add(0, 5_400, 5_400, 1_000) // slow and lopsided: offset 4 900
        s.add(2_000, 7_050, 7_050, 2_100) // fast: offset 5 000
        s.add(3_000, 8_300, 8_300, 3_800)
        assertEquals(5_000L, s.offsetMs)
        // The fast one falls out of the window of 3.
        s.add(4_000, 9_200, 9_200, 4_500)
        s.add(5_000, 10_200, 10_200, 5_500)
        s.add(6_000, 11_300, 11_300, 6_700)
        assertEquals(4_950L, s.offsetMs)
    }

    private fun cmd(command: String, whenMs: Long, pos: Long) = SyncCommand(command, whenMs, pos, "p1")

    @Test
    fun unpauseWaitsForItsTime() {
        val s = TimeSync().apply { add(0, 10_000, 10_000, 0) } // server = local + 10 s
        val c = cmd("Unpause", whenMs = 11_500, pos = 60_000)
        assertEquals(1_500L, SyncPlan.delayMs(c, nowLocal = 0, sync = s))
        // On time, already there: no seek.
        assertNull(SyncPlan.seekTo(c, nowLocal = 1_500, sync = s, currentMs = 60_000))
    }

    @Test
    fun lateUnpauseCatchesUpPastTheDrift() {
        val s = TimeSync().apply { add(0, 10_000, 10_000, 0) }
        val c = cmd("Unpause", whenMs = 11_000, pos = 60_000)
        // Arrived 3 s late: no wait, and the group is 3 s further on.
        assertEquals(0L, SyncPlan.delayMs(c, nowLocal = 4_000, sync = s))
        assertEquals(63_000L, SyncPlan.groupPositionMs(c, 4_000, s))
        assertEquals(63_000L, SyncPlan.seekTo(c, 4_000, s, currentMs = 60_000))
        // 1.5 s off stays put (under DRIFT_MS).
        assertNull(SyncPlan.seekTo(c, 2_500, s, currentMs = 60_000))
    }

    @Test
    fun pauseHoldsAndSeekAlwaysMoves() {
        val s = TimeSync()
        assertNull(SyncPlan.seekTo(cmd("Pause", 0, 60_000), 5_000, s, currentMs = 61_000))
        assertEquals(60_000L, SyncPlan.seekTo(cmd("Pause", 0, 60_000), 5_000, s, currentMs = 65_000))
        assertEquals(60_000L, SyncPlan.seekTo(cmd("Seek", 0, 60_000), 5_000, s, currentMs = 60_100))
    }

    @Test
    fun parsesServerMessages() {
        val c = SyncCommand.parse(Json.parseToJsonElement("""{"GroupId":"g","PlaylistItemId":"p1","When":"2026-10-20T12:00:01.5000000Z","PositionTicks":600000000,"Command":"Unpause","EmittedAt":"2026-10-20T12:00:00Z"}"""))!!
        assertEquals("Unpause", c.command)
        assertEquals(60_000L, c.positionMs)
        assertEquals(at("2026-10-20T12:00:01.500Z"), c.whenMs)

        val q = SyncQueue.parse(
            Json.parseToJsonElement(
                """{"Reason":"NewPlaylist","Playlist":[{"ItemId":"a1b2","PlaylistItemId":"x"},{"ItemId":"c3d4","PlaylistItemId":"y"}],"PlayingItemIndex":1,"StartPositionTicks":50000000,"IsPlaying":true}""",
            ),
        )
        assertEquals(SyncQueue("c3d4", "y", 5_000, true, "NewPlaylist"), q)
        // Only a new item (or one of these reasons) reloads the players; a queue edit keeps them playing.
        assertTrue(q!!.reloads(null))
        assertTrue(q.reloads(q))
        assertTrue(q.copy(reason = "RemoveItems").reloads(q.copy(playlistItemId = "x")))
        assertFalse(q.copy(reason = "RemoveItems").reloads(q))
        assertFalse(q.copy(reason = "MoveItem").reloads(q))
        assertTrue(q.copy(reason = "NextItem").reloads(q))
        assertNull(SyncQueue.parse(Json.parseToJsonElement("""{"Playlist":[],"PlayingItemIndex":-1}""")))
        assertNull(SyncQueue.parse(Json.parseToJsonElement("""{"Playlist":[{"ItemId":"../x","PlaylistItemId":"y"}],"PlayingItemIndex":0}""")))

        val g = SyncGroup.parse(Json.parseToJsonElement("""{"GroupId":"g1","GroupName":"Soirée","State":"Idle","Participants":["Ana","Bo"]}"""))
        assertEquals(SyncGroup("g1", "Soirée", listOf("Ana", "Bo")), g)
    }
}
