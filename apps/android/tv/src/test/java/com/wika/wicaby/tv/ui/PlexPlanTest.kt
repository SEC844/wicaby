package com.wika.wicaby.tv.ui

import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.Session
import com.wika.wicaby.core.plex.Plex
import com.wika.wicaby.core.plex.PlexAccount
import com.wika.wicaby.core.plex.PlexAccounts
import com.wika.wicaby.core.plex.PlexHomeUser
import com.wika.wicaby.core.plex.PlexResource
import com.wika.wicaby.core.plex.PlexServer
import com.wika.wicaby.core.plex.PlexStore
import com.wika.wicaby.core.plex.PlexTv
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class PlexPlanTest {
    private val a = "a".repeat(40)
    private val b = "b".repeat(40)
    private val c = "c".repeat(40)

    private fun signIn(id: String, confirm: String? = null) =
        PlexAccounts.SignIn(Server(id, id.take(1), "http://127.0.0.1:32400", "plex"), "tok-$id", "user", "Ado", owned = id == a, relay = false, confirm = confirm)

    @Test
    fun theOtherShownServersJoinAsExtras() {
        val account = listOf(PlexServer(a, account = "acc"), PlexServer(b, account = "acc"), PlexServer(c, account = "acc", hidden = true))
        val plan = plexPlan(signIn(a), listOf(signIn(a), signIn(b), signIn(c)), account, emptyList())
        // D-10: the hidden one stays out; the chosen one is the session, not an extra.
        assertEquals(listOf(b), plan.extras.map { it.server.id })
        assertEquals(emptyList<String>(), plan.drop)
    }

    @Test
    fun anAddressWaitingForD3NeverJoinsUnasked() {
        val account = listOf(PlexServer(a, account = "acc"), PlexServer(b, account = "acc"))
        val plan = plexPlan(signIn(a), listOf(signIn(a), signIn(b, confirm = "http://192.168.1.5:32400")), account, emptyList())
        assertEquals(emptyList<String>(), plan.extras.map { it.server.id })
    }

    @Test
    fun anotherHomeUsersServersLeave() {
        // The previous Home user had b and c; this one only has a and b: c leaves, and another source's extra stays.
        val account = listOf(PlexServer(a, account = "acc"), PlexServer(b, account = "acc"), PlexServer(c, account = "acc"))
        val emby = "e".repeat(32)
        val plan = plexPlan(signIn(a), listOf(signIn(a), signIn(b)), account, listOf(b, c, emby))
        assertEquals(listOf(b), plan.extras.map { it.server.id })
        assertEquals(listOf(c), plan.drop)
    }

    @Test
    fun aProtectedHomeUserNeverSkipsThePicker() {
        val store = PlexStore(Files.createTempDirectory("plex").toFile(), { it }, { it })
        store.putAccount(PlexAccount("acc", "Wika", home = listOf(PlexHomeUser(uuid = "ado", title = "Ado", protected = true), PlexHomeUser(uuid = "inv", title = "Invité"))), "tok")
        store.putResources("acc", listOf(PlexResource("Maison", a, "server")))
        Plex.use(PlexAccounts(store, PlexTv(OkHttpClient()) { error("never plex.tv in a test") }, OkHttpClient()))
        try {
            val maison = Server(a, "Maison", "http://127.0.0.1:32400", "plex")
            assertTrue(plexProtected(Session(maison, "ado", "Ado", "t")))
            assertFalse(plexProtected(Session(maison, "inv", "Invité", "t")))
            assertFalse(plexProtected(Session(Server("e".repeat(32), "Emby", "http://127.0.0.1:8096", "emby"), "u", "U", "t")))
            // A plex server the store does not know: protected until proven otherwise.
            assertTrue(plexProtected(Session(Server(b, "?", "http://127.0.0.1:32410", "plex"), "inv", "Invité", "t")))
        } finally {
            Plex.use(null)
        }
    }
}
