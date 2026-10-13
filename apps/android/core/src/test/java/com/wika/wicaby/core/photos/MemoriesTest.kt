package com.wika.wicaby.core.photos

import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.HomeRows
import com.wika.wicaby.core.data.Server
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// Photos spec PH-08: the home rows' "Ce jour-là". AC1: groups 1, 3 and 7 years ago, in that order; AC2: no match, no
// row; AC3: at most one /Years call and 10 ranges, cached until the date changes; AC4: a row of the home layout.
class MemoriesTest {
    private val server = MockWebServer()
    private val seen = mutableListOf<RecordedRequest>()

    @After
    fun tearDown() = server.close()

    private fun photo(id: String, date: String) = """{"Id":"$id","Type":"Photo","PremiereDate":"${date}T10:00:00","ImageTags":{"Primary":"t"}}"""

    @Test
    fun yearsNearestFirstAskedOnceADay() = runBlocking {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                synchronized(seen) { seen += request }
                val r = request.url
                val body = when {
                    r.encodedPath.endsWith("/Years") ->
                        """{"Items":[${(2005..2026).joinToString(",") { """{"Id":"y$it","Name":"$it","ProductionYear":$it}""" }}]}"""
                    // Keyed on the year: the eve and the morrow come back too, memories() drops them.
                    else -> when (r.queryParameter("MinPremiereDate")?.take(4)) {
                        "2025" -> """{"Items":[${photo("x0", "2025-10-12")},${photo("a1", "2025-10-13")},${photo("a2", "2025-10-13")},${photo("x1", "2025-10-14")}],"TotalRecordCount":4}"""
                        "2023" -> """{"Items":[${photo("c1", "2023-10-13")}],"TotalRecordCount":1}"""
                        "2019" -> """{"Items":[${photo("g1", "2019-10-13")}],"TotalRecordCount":1}"""
                        else -> """{"Items":[],"TotalRecordCount":0}"""
                    }
                }
                return MockResponse.Builder().addHeader("Content-Type", "application/json").body(body).build()
            }
        }
        server.start()
        val api = Api(Server("mem1", "Test", server.url("/").toString().trimEnd('/'), "jellyfin"), "dev", "tok", "u1")

        val groups = api.homeMemories("2026-10-13")
        assertEquals(listOf(1, 3, 7), groups.map { it.first })
        assertEquals(listOf(listOf("a1", "a2"), listOf("c1"), listOf("g1")), groups.map { (_, p) -> p.map { it.asset.id } })
        assertEquals(1, seen.count { it.url.encodedPath.endsWith("/Years") })
        assertEquals(10, seen.count { it.url.queryParameter("MinPremiereDate") != null })
        assertTrue(seen.all { it.url.queryParameter("ParentId") == null })
        // Spec §3.1 step 2: that year's today ±1 day.
        val r25 = seen.first { it.url.queryParameter("MinPremiereDate")?.startsWith("2025") == true }.url
        assertEquals("2025-10-12T00:00:00" to "2025-10-14T23:59:59", r25.queryParameter("MinPremiereDate") to r25.queryParameter("MaxPremiereDate"))

        // Same day: the cache. Next day: asked again.
        val before = seen.size
        api.homeMemories("2026-10-13")
        assertEquals(before, seen.size)
        // x1 (2025-10-14) is the next day's one-year memory.
        assertEquals(listOf(1 to listOf("x1")), api.homeMemories("2026-10-14").map { (y, p) -> y to p.map { it.asset.id } })
        assertEquals(2, seen.count { it.url.encodedPath.endsWith("/Years") })
    }

    @Test
    fun theRowFollowsThePhotoLibraries() {
        assertEquals(listOf(HomeRows.RESUME, HomeRows.UPCOMING, "latest:p", HomeRows.MEMORIES, HomeRows.BECAUSE), HomeRows.defaults(listOf("p"), merged = true, memories = true))
        assertTrue(HomeRows.MEMORIES !in HomeRows.defaults(listOf("p"), merged = true))
        // Hidden like any other row (Réglages > Accueil).
        val pref = HomeRows.Pref(hidden = setOf(HomeRows.MEMORIES))
        assertTrue(HomeRows.arrange(HomeRows.defaults(emptyList(), true, memories = true), pref).filter { it !in pref.hidden }.none { it == HomeRows.MEMORIES })
    }
}
