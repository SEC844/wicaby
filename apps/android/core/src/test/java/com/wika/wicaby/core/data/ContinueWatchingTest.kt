package com.wika.wicaby.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The same fixtures as tools/checks/continue-check.mjs (desktop renderer/lib/continue.ts).
class ContinueWatchingTest {
    private fun ep(id: String, series: String, pos: Long, played: String? = null) =
        Item(id, type = "Episode", seriesId = series, userData = UserData(playbackPositionTicks = pos, lastPlayedDate = played))

    private fun movie(id: String, pos: Long, played: String? = null) =
        Item(id, type = "Movie", userData = UserData(playbackPositionTicks = pos, lastPlayedDate = played))

    private fun ids(list: List<Item>) = list.joinToString(",") { it.id }

    @Test
    fun seriesInProgressKeepsOneCard() {
        assertEquals("e4", ids(ContinueWatching.merge(listOf(ep("e4", "A", 100, "2026-10-01T10:00:00Z")), listOf(ep("e5", "A", 0)), emptyMap())))
    }

    @Test
    fun newestFirstUndatedAfterInServerOrder() {
        val resume = listOf(
            movie("m1", 50, "2026-10-02T10:00:00Z"),
            ep("b3", "B", 70, "2026-10-05T10:00:00.0000000Z"),
            movie("m2", 10),
            ep("c1", "C", 0), // Emby mixes a positionless row in: next-up material
        )
        val nextUp = listOf(ep("b4", "B", 0), ep("d2", "D", 0), ep("c1", "C", 0), ep("e1", "E", 0), ep("f1", "F", 0))
        val series = mapOf("D" to "2026-10-04T10:00:00Z", "C" to "2026-10-03T10:00:00Z")
        assertEquals("b3,d2,c1,m1,m2,e1,f1", ids(ContinueWatching.merge(resume, nextUp, series)))
    }

    @Test
    fun hiddenUntilPlayedAgain() {
        var list = ContinueWatching.withHidden(emptyList(), "s:u:m1", "2026-10-02T10:00:00Z")
        assertTrue(ContinueWatching.isHidden(list, "s:u:m1", "2026-10-02T10:00:00Z"))
        assertFalse(ContinueWatching.isHidden(list, "s:u:m1", "2026-10-06T10:00:00Z"))
        assertFalse(ContinueWatching.isHidden(list, "s:u:other", ""))
        assertTrue(ContinueWatching.isHidden(ContinueWatching.withHidden(emptyList(), "k", ""), "k", ""))
        assertTrue(ContinueWatching.withoutHidden(list, "s:u:m1").isEmpty())
        repeat(520) { list = ContinueWatching.withHidden(list, "k$it", "") }
        assertEquals(ContinueWatching.HIDE_CAP, list.size)
        assertEquals("k20", list.first().key)
        assertEquals(list, ContinueWatching.decode(ContinueWatching.encode(list)))
        assertTrue(ContinueWatching.decode("not json").isEmpty())
    }

    @Test
    fun listFieldsCarryProviderIds() {
        assertTrue(LIST_FIELDS.split(",").containsAll(listOf("ProviderIds", "DateCreated")))
        // PremiereDate is not a Jellyfin ItemFields value: Emby dialect only (Api.listFields).
        assertFalse("PremiereDate" in LIST_FIELDS.split(","))
        val item = json.decodeFromString(Item.serializer(), """{"Id":"x","ProviderIds":{"Imdb":"tt1"},"UserData":{"LastPlayedDate":"2026-10-01T00:00:00Z"}}""")
        assertEquals("tt1", item.providerIds["Imdb"])
        assertEquals("2026-10-01T00:00:00Z", item.userData?.lastPlayedDate)
    }
}
