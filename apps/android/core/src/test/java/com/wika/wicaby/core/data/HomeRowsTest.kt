package com.wika.wicaby.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// TP-07: the home rows order, as desktop's Home.svelte computes it.
class HomeRowsTest {
    private val defaults = HomeRows.defaults(listOf("m", "s"), merged = false)

    @Test
    fun defaultsFollowDesktopOrder() {
        assertEquals(listOf("resume", "nextUp", "upcoming", "latest:m", "latest:s", "because"), defaults)
        assertEquals(listOf("resume", "upcoming", "because"), HomeRows.defaults(emptyList(), merged = true))
    }

    @Test
    fun savedOrderWinsAndNewRowsKeepTheirDefaultPlace() {
        assertEquals(defaults, HomeRows.arrange(defaults, null))
        // A library added since ("latest:s") lands after its default neighbour; a removed one ("latest:gone") drops out.
        val pref = HomeRows.Pref(order = listOf("because", "latest:m", "latest:gone", "resume", "upcoming", "nextUp"))
        assertEquals(listOf("because", "latest:m", "latest:s", "resume", "upcoming", "nextUp"), HomeRows.arrange(defaults, pref))
        // A new first row goes first.
        assertEquals(listOf("resume", "because"), HomeRows.arrange(listOf("resume", "because"), HomeRows.Pref(order = listOf("because"))))
    }

    @Test
    fun moveIgnoresOutOfRange() {
        val rows = listOf("a", "b", "c")
        assertEquals(listOf("b", "a", "c"), HomeRows.move(rows, 1, 0))
        assertEquals(listOf("a", "c", "b"), HomeRows.move(rows, 1, 2))
        assertEquals(rows, HomeRows.move(rows, 0, -1))
        assertEquals(rows, HomeRows.move(rows, 2, 3))
    }

    @Test
    fun prefRoundTripsAndBadDataIsIgnored() {
        val p = HomeRows.Pref(listOf("because", "resume"), setOf("nextUp"), setOf("latest:m"))
        assertEquals(p, HomeRows.decode(HomeRows.encode(p)))
        assertNull(HomeRows.decode("{not json"))
        assertNull(HomeRows.decode(null))
        assertEquals("m", HomeRows.latestViewId("latest:m"))
        assertNull(HomeRows.latestViewId("resume"))
    }

    @Test
    fun staleThumbSetIsDroppedOnceAndNewPicksStay() {
        // What 0.4.0-0.4.2 saved (a reported case: Films in thumbnails): order and hidden survive, the rows are posters again.
        val old = """{"Order":["resume","latest:lib-movies","because"],"Hidden":["because"],"Thumb":["latest:lib-movies"]}"""
        assertEquals(HomeRows.Pref(listOf("resume", "latest:lib-movies", "because"), setOf("because")), HomeRows.decode(old))
        // A pick made after the migration is kept.
        val picked = HomeRows.Pref(order = listOf("latest:lib-movies"), thumb = setOf("latest:lib-movies"))
        assertEquals(picked, HomeRows.decode(HomeRows.encode(picked)))
    }

    @Test
    fun becauseSeedsAndUnseen() {
        val played = listOf(
            Item("e1", "Pilot", "Episode", seriesId = "s1", seriesName = "Show"),
            Item("e2", "Two", "Episode", seriesId = "s1", seriesName = "Show"),
            Item("m1", "Film", "Movie"),
            Item("m2", "Other", "Movie"),
        )
        val seeds = HomeRows.becauseSeeds(played)
        assertEquals(listOf("s1", "m1"), seeds.map { it.id })
        assertEquals("Show", seeds[0].name)
        assertEquals("Series", seeds[0].type)
        assertEquals(listOf("b"), HomeRows.unseen(listOf(Item("a"), Item("b"), Item("b")), listOf(Item("a"))).map { it.id })
        // tools/checks/home-rows-check.mjs: the same item and the same title on another server go, another server's id stays.
        fun movie(id: String, server: String, tmdb: String? = null) = Item(id, id, "Movie", serverId = server, providerIds = tmdb?.let { mapOf("Tmdb" to it) }.orEmpty())
        val shown = listOf(movie("m1", "A"), movie("m2", "A", "42"))
        val sim = listOf(movie("m1", "A"), movie("m3", "B", "42"), movie("m4", "A"), movie("m1", "B"))
        assertEquals(listOf("A:m4", "B:m1"), HomeRows.unseen(sim, shown).map(Servers::key))
    }

    @Test
    fun becauseSeedsKeepTheirServer() {
        val played = listOf(
            Item("e1", "Pilot", "Episode", seriesId = "s1", seriesName = "Show", serverId = "A"),
            Item("e9", "Pilot", "Episode", seriesId = "s1", seriesName = "Show", serverId = "B"),
        )
        assertEquals(listOf("A", "B"), HomeRows.becauseSeeds(played).map { it.serverId })
    }

    @Test
    fun liveNowRowOnlyWithLiveTvAndOnlyChannelsAiring() {
        assertEquals(listOf("resume", "upcoming", "liveNow", "latest:m", "because"), HomeRows.defaults(listOf("m"), merged = true, live = true))
        val airing = Item("c1", "One", "TvChannel", currentProgram = Item("p1", "News"))
        assertEquals(listOf(airing), HomeRows.onNow(listOf(airing, Item("c2", "Two", "TvChannel"))))
    }
}
