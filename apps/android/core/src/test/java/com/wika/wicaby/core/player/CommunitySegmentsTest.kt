package com.wika.wicaby.core.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Saved TheIntroDB / IntroDB answers (resources/community), the sanity drops and the per-kind priority merge.
class CommunitySegmentsTest {
    private fun fx(name: String) = javaClass.getResource("/community/$name")!!.readText()

    @Test
    fun parsesTheIntroDb() {
        // Credits with a null end run to the end of the media.
        val bb = CommunitySegments.parseTheIntroDb(fx("tidb-tv.json"), 2_905_000)!!
        assertEquals(Segments(credits = 2_843_000), bb)
        val got = CommunitySegments.parseTheIntroDb(fx("tidb-tv2.json"), 3_720_000)!!
        assertEquals(Segments(435_691, 534_851, 3_627_540, listOf(SkipRange(SegmentKind.Intro, 435_691, 534_851))), got)
        // A null intro start is the start of the media.
        val movie = CommunitySegments.parseTheIntroDb(fx("tidb-movie.json"), 8_160_000)!!
        assertEquals(Segments(0, 40_000, 7_726_802, listOf(SkipRange(SegmentKind.Intro, 0, 40_000))), movie)
        // Recap and preview; the "versions" and "episodes" shapes have no segments.
        val rp = CommunitySegments.parseTheIntroDb("""{"tvdb_id":1,"type":"tv","recap":[{"start_ms":null,"end_ms":60000}],"preview":[{"start_ms":1700000,"end_ms":null}]}""", 1_750_000)!!
        assertEquals(listOf(SkipRange(SegmentKind.Recap, 0, 60_000), SkipRange(SegmentKind.Preview, 1_700_000, 1_750_000)), rp.ranges)
        assertNull(CommunitySegments.parseTheIntroDb("""{"tvdb_id":1,"type":"tv","versions":[{"duration_ms":1,"submission_count":2}]}""", 1_000_000))
        assertNull(CommunitySegments.parseTheIntroDb("""{"tvdb_id":1,"type":"tv","episodes":[]}""", 1_000_000))
        assertNull(CommunitySegments.parseTheIntroDb("not json", 1_000_000))
    }

    @Test
    fun parsesIntroDb() {
        val bb = CommunitySegments.parseIntroDb(fx("introdb-tv.json"), 2_905_000)!!
        assertEquals(Segments(314_500, 331_000, 2_843_000, listOf(SkipRange(SegmentKind.Intro, 314_500, 331_000))), bb)
        assertNull(CommunitySegments.parseIntroDb(fx("introdb-movie.json"), 8_160_000))
        // post_credits is ignored.
        assertNull(CommunitySegments.parseIntroDb("""{"intro":null,"post_credits":{"start_ms":10,"end_ms":20}}""", 1_000_000))
        // Fractional milliseconds are rounded; seconds stand in for missing milliseconds (as the desktop).
        assertEquals(Segments(1_235, 31_500, null, listOf(SkipRange(SegmentKind.Intro, 1_235, 31_500))), CommunitySegments.parseIntroDb("""{"intro":{"start_ms":1234.6,"end_sec":31.5}}""", 1_000_000))
    }

    @Test
    fun asksOnlyForMissingKinds() {
        val all = Segments(0, 30_000, 900_000, listOf(SkipRange(SegmentKind.Intro, 0, 30_000), SkipRange(SegmentKind.Recap, 30_000, 60_000), SkipRange(SegmentKind.Preview, 950_000, 990_000)))
        assertEquals(false, CommunitySegments.missingKinds(all))
        assertEquals(true, CommunitySegments.missingKinds(all.copy(ranges = all.ranges.filter { it.kind != SegmentKind.Preview })))
        assertEquals(true, CommunitySegments.missingKinds(all.copy(credits = null)))
        assertEquals(true, CommunitySegments.missingKinds(Segments()))
    }

    @Test
    fun dropsInsaneSpans() {
        // end <= start, start < 0, end past runtime + 5 s, a credits start at 0, an intro without an end.
        val body = """{"tvdb_id":1,"type":"tv",
            "intro":[{"start_ms":5000,"end_ms":5000},{"start_ms":-1,"end_ms":3000},{"start_ms":0,"end_ms":null}],
            "recap":[{"start_ms":0,"end_ms":1006000}],
            "credits":[{"start_ms":0,"end_ms":null}],
            "preview":[{"start_ms":900000,"end_ms":1004000}]}"""
        val s = CommunitySegments.parseTheIntroDb(body, 1_000_000)!!
        assertEquals(Segments(ranges = listOf(SkipRange(SegmentKind.Preview, 900_000, 1_004_000))), s)
        assertNull(CommunitySegments.parseIntroDb("""{"intro":{"start_ms":20000,"end_ms":10000},"outro":{"start_ms":0,"end_ms":5000}}""", 1_000_000))
    }

    @Test
    fun mergesPerKind() {
        val server = Segments(credits = 1_000_000, ranges = listOf(SkipRange(SegmentKind.Commercial, 10, 20)))
        val tidb = Segments(credits = 999_000, ranges = listOf(SkipRange(SegmentKind.Recap, 0, 30_000)))
        val introDb = Segments(60_000, 90_000, 998_000, listOf(SkipRange(SegmentKind.Intro, 60_000, 90_000), SkipRange(SegmentKind.Recap, 0, 40_000)))
        val aniSkip = Segments(61_000, 91_000, 997_000, listOf(SkipRange(SegmentKind.Intro, 61_000, 91_000), SkipRange(SegmentKind.Preview, 1_100_000, 1_200_000)))
        val m = CommunitySegments.merge(listOf(server, tidb, null, introDb, aniSkip))
        assertEquals(60_000L, m.introStart)
        assertEquals(90_000L, m.introEnd)
        assertEquals(1_000_000L, m.credits)
        assertEquals(
            listOf(SkipRange(SegmentKind.Recap, 0, 30_000), SkipRange(SegmentKind.Commercial, 10, 20), SkipRange(SegmentKind.Intro, 60_000, 90_000), SkipRange(SegmentKind.Preview, 1_100_000, 1_200_000)),
            m.ranges,
        )
    }

    @Test
    fun buildsUrls() {
        val ids = mapOf("Tmdb" to "1396", "imdb" to "tt0903747", "Tvdb" to "81189")
        assertEquals("https://api.theintrodb.org/v4/media?tvdb_id=81189&season=1&episode=2", CommunitySegments.theIntroDbUrl(ids, 1, 2).toString())
        assertEquals("https://api.theintrodb.org/v4/media?tmdb_id=603", CommunitySegments.theIntroDbUrl(mapOf("Tmdb" to "603", "Tvdb" to "x&y"), null, null).toString())
        assertEquals("https://api.introdb.app/segments?imdb_id=tt0903747&season=1&episode=2", CommunitySegments.introDbUrl(ids, 1, 2).toString())
        assertEquals("https://api.introdb.app/segments?imdb_id=tt0133093&is_movie=true", CommunitySegments.introDbUrl(mapOf("Imdb" to "tt0133093"), null, null).toString())
        assertNull(CommunitySegments.introDbUrl(mapOf("Tmdb" to "603"), null, null))
        assertNull(CommunitySegments.theIntroDbUrl(mapOf("Imdb" to "nope"), null, null))
        // The same id rules as the desktop: 1 to 10 digits, tt and 5 to 10 digits.
        assertEquals("https://api.theintrodb.org/v4/media?tmdb_id=1234567890", CommunitySegments.theIntroDbUrl(mapOf("Tmdb" to "1234567890"), null, null).toString())
        assertNull(CommunitySegments.theIntroDbUrl(mapOf("Tmdb" to "12345678901", "Imdb" to "tt1234"), null, null))
    }
}
