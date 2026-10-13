package com.wika.wicaby.mobile.ui.livetv

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

// §9.5 client grouping: in progress apart, 20 newest, one group per show, then films, sport, others.
class RecordingGroupsTest {
    private fun rec(id: String, created: Int, extra: String = ""): JsonObject =
        Json.parseToJsonElement("""{"Id":"$id","Name":"n$id","DateCreated":"2026-10-${"%02d".format(created)}T10:00:00.0000000Z"$extra}""").jsonObject

    @Test
    fun groupsOnTheClient() {
        val all = listOf(
            rec("a", 1, ""","IsMovie":true"""),
            rec("b", 2, ""","IsSports":true"""),
            rec("c", 3, ""","IsSeries":true,"SeriesName":"Section 7""""),
            rec("d", 4, ""","SeriesName":"Section 7""""),
            rec("e", 5),
            rec("f", 6, ""","Status":"InProgress","IsMovie":true"""),
            rec("g", 7),
            rec("e", 5), // the in-progress call and the full list overlap
        )
        val g = groupRecordings(all, setOf("g"))
        assertEquals(listOf("g", "f"), g.inProgress.map { it.s("Id") })
        assertEquals(listOf("e", "d", "c", "b", "a"), g.recent.map { it.s("Id") })
        assertEquals(listOf("Section 7" to listOf("d", "c")), g.series.map { (k, v) -> k to v.map { it.s("Id") } })
        assertEquals(listOf("a"), g.movies.map { it.s("Id") })
        assertEquals(listOf("b"), g.sports.map { it.s("Id") })
        assertEquals(listOf("e"), g.other.map { it.s("Id") })
    }

    @Test
    fun recentKeepsTwenty() {
        val g = groupRecordings((1..25).map { rec("r$it", it) }, emptySet())
        assertEquals(20, g.recent.size)
        assertEquals("r25", g.recent.first().s("Id"))
    }
}
