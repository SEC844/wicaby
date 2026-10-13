package com.wika.wicaby.core.data

import com.wika.wicaby.core.Core
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.TimeZone

// The same fixtures as tools/checks/desk-shell-check.mjs (desktop shared/history.ts).
class WatchHistoryTest {
    private val zone = TimeZone.getTimeZone("Europe/Paris")
    private val h = 3_600_000L
    private val ticksMin = 600_000_000L

    // Noon today (local), so "an hour ago" and "a day ago" never straddle midnight.
    private val now = WatchHistory.dayStart(System.currentTimeMillis(), zone) + 12 * h
    private fun at(hours: Long) = Instant.ofEpochMilli(now - hours * h).toString()

    private fun item(id: String, hours: Long?, runMin: Long = 0, played: Boolean = false, posMin: Long = 0, genres: List<String> = emptyList(), type: String = "Movie", series: String? = null) =
        Item(
            id, type = type, runTimeTicks = runMin * ticksMin, genres = genres, seriesId = series,
            userData = UserData(lastPlayedDate = hours?.let(::at), played = played, playbackPositionTicks = posMin * ticksMin),
        )

    private val items = listOf(
        item("never", null),
        item("old", 24 * 40, 100, played = true),
        item("today-2", 2, 90, played = true, genres = listOf("Drame")),
        item("today-1", 1, 120, posMin = 30, type = "Episode", series = "s1"),
        item("yesterday", 24, 60, played = true, genres = listOf("Action", "Drame")),
        item("ten-days", 24 * 10, 45, played = true, genres = listOf("Action")),
    )

    @Test
    fun recentFirstDropsNeverPlayed() {
        assertEquals(listOf("today-1", "today-2", "yesterday", "ten-days", "old"), WatchHistory.recentFirst(items).map { it.id })
    }

    @Test
    fun groupedByLocalDay() {
        val groups = WatchHistory.groupByDay(items, zone)
        assertEquals(listOf(listOf("today-1", "today-2"), listOf("yesterday"), listOf("ten-days"), listOf("old")), groups.map { g -> g.second.map { it.id } })
        assertEquals(listOf(0, 1, 10, 40), groups.map { WatchHistory.daysAgo(it.first, now, zone) })
    }

    @Test
    fun stats() {
        val s = WatchHistory.stats(items, mapOf("s1" to listOf("Science-fiction", "Drame")), now)
        // 7 days: 90 (played) + 30 (position) + 60 (played) minutes; 30 days adds the 45-minute one.
        assertEquals((90 + 30 + 60) * 60_000L, s.weekMs)
        assertEquals((90 + 30 + 60 + 45) * 60_000L, s.monthMs)
        assertEquals(listOf("Drame", "Action", "Science-fiction"), s.genres)
        assertEquals(WatchStats(0, 0, emptyList()), WatchHistory.stats(emptyList(), now = now))
    }

    @Test
    fun topFiveGenres() {
        val many = ('a'..'g').map { c -> item("$c", 1, genres = listOf("G$c")) } + item("x", 2, genres = listOf("Gg"))
        assertEquals(listOf("Gg", "Ga", "Gb", "Gc", "Gd"), WatchHistory.stats(many, now = now).genres)
    }

    private val mocks = mutableListOf<MockWebServer>()

    @After
    fun tearDown() {
        Core.api = null
        Servers.extra = emptyList()
        mocks.forEach { it.close() }
    }

    private fun mock(vararg bodies: String) = MockWebServer().apply {
        bodies.forEach { enqueue(MockResponse.Builder().code(200).body(it).build()) }
        start()
        mocks += this
    }

    private fun api(id: String, m: MockWebServer) = Api(Server(id, "Server $id", m.url("/").toString().trimEnd('/'), "jellyfin"), "dev", "token-$id", "u-$id")

    // Desktop History.svelte: fanOut over every server, merge(..., true), series genres looked up on each item's server.
    @Test
    fun loadCoversEveryServerAndLooksSeriesGenresUpOnTheirOwnServer() = runBlocking {
        val sa = mock("""{"Items":[{"Id":"m1","Name":"M","Type":"Movie","Genres":["Drama"],"UserData":{"LastPlayedDate":"2026-10-10T10:00:00.0000000Z","Played":true}}]}""")
        val sb = mock(
            """{"Items":[{"Id":"e1","Name":"E","Type":"Episode","SeriesId":"s1","UserData":{"LastPlayedDate":"2026-10-11T10:00:00.0000000Z"}}]}""",
            """{"Items":[{"Id":"s1","Name":"S","Type":"Series","Genres":["Comedy"]}]}""",
        )
        val a = api("a", sa)
        Core.api = a
        Servers.extra = listOf(api("b", sb))
        val data = WatchHistory.load(a)
        assertEquals(listOf("b:e1", "a:m1"), data.items.map(Servers::key))
        assertEquals(mapOf("s1" to listOf("Comedy")), data.seriesGenres)
        assertEquals("DatePlayed", sa.takeRequest().url.queryParameter("SortBy"))
        assertEquals(1, sa.requestCount)
        assertEquals("Movie,Episode", sb.takeRequest().url.queryParameter("IncludeItemTypes"))
        assertEquals("s1", sb.takeRequest().url.queryParameter("Ids"))
        assertEquals(listOf("Comedy", "Drama"), WatchHistory.stats(data.items, data.seriesGenres).genres)
    }

    // The desktop parameters on each server, and the error state only when no server answered.
    @Test
    fun loadSendsTheDesktopQueryAndFailsOnlyWhenNoServerAnswers() = runBlocking {
        val sa = mock("""{"Items":[]}""")
        val a = api("a", sa)
        Core.api = a
        WatchHistory.load(a)
        val u = sa.takeRequest().url
        for ((k, v) in listOf("Recursive" to "true", "IncludeItemTypes" to "Movie,Episode", "SortBy" to "DatePlayed", "SortOrder" to "Descending", "Limit" to "200")) assertEquals(k, v, u.queryParameter(k))
        assertTrue(u.queryParameter("Fields")!!.split(',').contains("Genres"))
        val down = Api(Server("d", "D", "http://127.0.0.1:1", "jellyfin"), "dev", "t", "u")
        Core.api = down
        assertTrue(runCatching { WatchHistory.load(down) }.exceptionOrNull() is java.io.IOException)
    }
}
