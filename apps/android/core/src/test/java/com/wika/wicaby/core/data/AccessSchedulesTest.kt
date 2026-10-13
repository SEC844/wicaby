package com.wika.wicaby.core.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar
import java.util.TimeZone

class AccessSchedulesTest {
    private val tz = TimeZone.getTimeZone("Europe/Paris")

    // 2026-10-12 is a Monday.
    private fun at(day: Int, h: Int, m: Int = 0): Long =
        Calendar.getInstance(tz).apply { clear(); set(2026, Calendar.OCTOBER, day, h, m, 0) }.timeInMillis

    // The mock's "Enfants" user (tools/mock-server/mock-admin/20-users.mjs).
    private val kids = listOf(AccessSchedule("Weekday", 16.0, 20.0), AccessSchedule("Weekend", 9.0, 21.0))

    @Test
    fun days() {
        assertEquals((1..7).toSet(), AccessSchedules.days("Everyday"))
        assertEquals(setOf(Calendar.MONDAY, Calendar.TUESDAY, Calendar.WEDNESDAY, Calendar.THURSDAY, Calendar.FRIDAY), AccessSchedules.days("Weekday"))
        assertEquals(setOf(Calendar.SATURDAY, Calendar.SUNDAY), AccessSchedules.days("Weekend"))
        assertEquals(setOf(Calendar.TUESDAY), AccessSchedules.days("Tuesday"))
        assertEquals(emptySet<Int>(), AccessSchedules.days("Someday"))
    }

    @Test
    fun windowsMerge() {
        val list = listOf(AccessSchedule("Everyday", 14.0, 18.0), AccessSchedule("Monday", 8.0, 12.0), AccessSchedule("Weekday", 11.5, 15.0))
        assertEquals(listOf(8.0..18.0), AccessSchedules.windows(list, Calendar.MONDAY))
        assertEquals(listOf(11.5..18.0), AccessSchedules.windows(list, Calendar.TUESDAY))
        assertEquals(listOf(14.0..18.0), AccessSchedules.windows(list, Calendar.SUNDAY))
    }

    @Test
    fun allowed() {
        assertTrue(AccessSchedules.allowed(emptyList(), at(12, 3), tz))
        assertTrue(AccessSchedules.allowed(kids, at(12, 17), tz))
        assertFalse(AccessSchedules.allowed(kids, at(12, 10), tz))
        assertFalse(AccessSchedules.allowed(kids, at(12, 20), tz)) // the end is not allowed
        assertTrue(AccessSchedules.allowed(kids, at(17, 10), tz)) // Saturday
    }

    @Test
    fun minutesLeft() {
        assertEquals(10L, AccessSchedules.minutesLeft(kids, at(12, 19, 50), tz))
        assertEquals(240L, AccessSchedules.minutesLeft(kids, at(12, 16), tz))
        assertNull(AccessSchedules.minutesLeft(kids, at(12, 21), tz))
        assertNull(AccessSchedules.minutesLeft(emptyList(), at(12, 21), tz))
        // 0:00–24:00 every day: no end.
        assertNull(AccessSchedules.minutesLeft(listOf(AccessSchedule("Everyday", 0.0, 24.0)), at(12, 23, 55), tz))
        // Monday until midnight, then Tuesday from 0:00 to 1:30: the span carries on.
        val late = listOf(AccessSchedule("Monday", 20.0, 24.0), AccessSchedule("Tuesday", 0.0, 1.5))
        assertEquals(150L, AccessSchedules.minutesLeft(late, at(12, 23), tz))
        // Monday until midnight only.
        assertEquals(5L, AccessSchedules.minutesLeft(listOf(AccessSchedule("Monday", 20.0, 24.0)), at(12, 23, 55), tz))
    }

    @Test
    fun refused() {
        val now = at(12, 10)
        assertTrue(AccessSchedules.refused(ApiException("User is not allowed access at this time.", 401), emptyList(), now, tz))
        assertTrue(AccessSchedules.refused(ApiException("HTTP 403", 403), kids, now, tz))
        assertFalse(AccessSchedules.refused(ApiException("HTTP 403", 403), kids, at(12, 17), tz))
        assertFalse(AccessSchedules.refused(ApiException("Invalid user or password", 401), emptyList(), now, tz))
        assertFalse(AccessSchedules.refused(ApiException("HTTP 500", 500), kids, now, tz))
        assertFalse(AccessSchedules.refused(java.io.IOException("timeout"), kids, now, tz))
        // Live TV: the tune error keeps Emby's wording, not the status (Playback falls back to the kept hours).
        val live = com.wika.wicaby.core.livetv.LiveError(com.wika.wicaby.core.livetv.LiveFailure.FAILED, "User is not allowed access at this time.")
        assertTrue(AccessSchedules.refused(live, emptyList(), now, tz))
        // Jellyfin sign-in: a bare 403 for a listed user is the hours, even with nothing kept; a 401 stays a wrong password.
        assertTrue(AccessSchedules.refused(ApiException("Error processing request.", 403), emptyList(), at(12, 17), tz, signIn = true))
        assertFalse(AccessSchedules.refused(ApiException("Error processing request.", 401), emptyList(), now, tz, signIn = true))
        assertFalse(AccessSchedules.refused(ApiException("Error processing request.", 403), emptyList(), now, tz))
    }

    @Test
    fun parsePolicy() {
        val policy = Json.parseToJsonElement(
            """{"IsAdministrator":false,"AccessSchedules":[{"DayOfWeek":"Weekday","StartHour":16,"EndHour":20.5},{"DayOfWeek":"Sunday","StartHour":9,"EndHour":21}]}""",
        ) as JsonObject
        assertEquals(listOf(AccessSchedule("Weekday", 16.0, 20.5), AccessSchedule("Sunday", 9.0, 21.0)), AccessSchedules.parse(policy))
        assertEquals(emptyList<AccessSchedule>(), AccessSchedules.parse(null))
        assertEquals(emptyList<AccessSchedule>(), AccessSchedules.parse(Json.parseToJsonElement("""{"AccessSchedules":"x"}""") as JsonObject))
        // AuthenticateByName's User carries the policy.
        val u = json.decodeFromString<User>("""{"Id":"u","Name":"Enfants","Policy":{"AccessSchedules":[{"DayOfWeek":"Everyday","StartHour":8,"EndHour":20}]}}""")
        assertEquals(listOf(AccessSchedule("Everyday", 8.0, 20.0)), AccessSchedules.parse(u.policy))
    }

    // TP-11, a saved account picked outside the hours: the token check is the call both servers refuse.
    private fun server(vararg r: Pair<Int, String>) = MockWebServer().apply {
        r.forEach { (code, body) -> enqueue(MockResponse.Builder().code(code).body(body).build()) }
        start()
    }

    @Test
    fun verifyOnJellyfinAsksUsersMeAndStillReadsTheHours() = runBlocking {
        // /Users/Me: a bare 403; /Users/{id} ([Authorize(IgnoreParentalControl)]) answers with the policy.
        val m = server(403 to "", 200 to """{"Id":"u1","Name":"Kid","Policy":{"AccessSchedules":[{"DayOfWeek":"Weekday","StartHour":16,"EndHour":20}]}}""")
        m.use {
            val api = Api(Server("jf", "JF", m.url("/").toString().trimEnd('/'), "jellyfin"), "dev", "tok", "u1")
            val e = runCatching { AccessSchedules.verify(api, "u1") }.exceptionOrNull() as ApiException
            assertEquals(403, e.status)
            assertEquals(if (api.server.isEmby) "/emby/Users/u1" else "/Users/Me", m.takeRequest().url.encodedPath)
            assertEquals("/Users/u1", m.takeRequest().url.encodedPath)
            // With those hours, Monday 10:00 makes the bare 403 a refusal of the hours.
            assertTrue(AccessSchedules.refused(e, kids, at(12, 10), tz))
        }
    }

    @Test
    fun verifyOnEmbyAsksUsersIdWhichCarriesTheWording() = runBlocking {
        val m = server(401 to "This user account is not allowed access at this time.")
        m.use {
            val api = Api(Server("em", "Emby", m.url("/").toString().trimEnd('/'), "emby"), "dev", "tok", "u1")
            val e = runCatching { AccessSchedules.verify(api, "u1") }.exceptionOrNull() as ApiException
            assertEquals("/emby/Users/u1", m.takeRequest().url.encodedPath)
            assertEquals(1, m.requestCount)
            assertTrue(AccessSchedules.refused(e, emptyList(), at(12, 10), tz))
        }
    }

    @Test
    fun verifyHandsBackTheTokensUser() = runBlocking {
        val m = server(200 to """{"Id":"u1","Name":"Kid","Policy":{}}""")
        m.use {
            val api = Api(Server("jf", "JF", m.url("/").toString().trimEnd('/'), "jellyfin"), "dev", "tok", "u1")
            assertEquals("u1", AccessSchedules.verify(api, "u1").id)
        }
    }
}
