package com.wika.wicaby.core.trakt

import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.json
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.Collections

// The Trakt API v2 subset of tools/mock-server/mock-trakt.mjs, on loopback: device codes approved
// after [approveAfter] polls (or denied), one-use refresh tokens, revocation, scrobble and history.
class FakeTrakt(private val approveAfter: Int = 2, private val deny: Boolean = false) : Dispatcher() {
    val secret = "mock-secret-123"
    val scrobbles: MutableList<Pair<String, Double>> = Collections.synchronizedList(mutableListOf())
    val history: MutableList<String> = Collections.synchronizedList(mutableListOf())
    // History ids of the plays of trakt id 42, oldest first.
    val plays: MutableList<Long> = Collections.synchronizedList(mutableListOf())
    val access: MutableSet<String> = Collections.synchronizedSet(mutableSetOf())
    private val refresh = Collections.synchronizedSet(mutableSetOf<String>())
    private val codes = mutableMapOf<String, IntArray>() // device_code -> [polls, used]
    private var n = 0

    fun expire() = access.clear()

    private fun send(code: Int, body: String = "") = MockResponse.Builder().code(code).body(body).build()

    @Synchronized
    private fun tokens(): String {
        n++
        access += "acc$n"
        refresh += "ref$n"
        return """{"access_token":"acc$n","refresh_token":"ref$n","token_type":"bearer","expires_in":86400,"scope":"public","created_at":${System.currentTimeMillis() / 1000}}"""
    }

    override fun dispatch(request: RecordedRequest): MockResponse {
        val p = request.url.encodedPath
        if (request.headers["trakt-api-key"].isNullOrEmpty()) return send(403)
        if (request.headers["trakt-api-version"] != "2") return send(412)
        val b = request.body?.utf8()?.takeIf { it.isNotEmpty() }?.let { json.parseToJsonElement(it).jsonObject } ?: JsonObject(emptyMap())
        fun s(k: String) = b[k]?.jsonPrimitive?.content
        synchronized(this) {
            when (p) {
                "/oauth/device/code" -> {
                    val dc = "dev${codes.size}"
                    codes[dc] = intArrayOf(0, 0)
                    return send(200, """{"device_code":"$dc","user_code":"AB12CD34","verification_url":"https://trakt.tv/activate","expires_in":600,"interval":1}""")
                }
                "/oauth/device/token" -> {
                    val c = codes[s("code")] ?: return send(404)
                    if (s("client_secret") != secret) return send(401)
                    if (c[1] == 1) return send(409)
                    if (++c[0] < approveAfter) return send(400)
                    if (deny) return send(418)
                    c[1] = 1
                    return send(200, tokens())
                }
                "/oauth/token" -> {
                    if (s("grant_type") != "refresh_token" || s("client_secret") != secret || !refresh.remove(s("refresh_token"))) return send(401)
                    return send(200, tokens())
                }
                "/oauth/revoke" -> {
                    access.remove(s("token"))
                    return send(200, "{}")
                }
            }
        }
        val bearer = request.headers["Authorization"]?.removePrefix("Bearer ")
        if (bearer == null || bearer !in access) return send(401)
        if (p == "/users/settings") return send(200, """{"user":{"username":"wika"}}""")
        Regex("^/scrobble/(start|pause|stop)$").find(p)?.let {
            scrobbles += it.groupValues[1] to b["progress"]!!.jsonPrimitive.content.toDouble()
            return send(201, "{}")
        }
        if (p == "/sync/history") {
            history += "+" + b.keys.single()
            plays += 1000L + plays.size
            return send(201, "{}")
        }
        if (p == "/sync/history/remove") {
            val ids = b["ids"]!!.jsonArray.map { it.jsonPrimitive.long }
            history += "-" + ids.joinToString(",")
            plays.removeAll(ids)
            return send(200, "{}")
        }
        Regex("^/search/(imdb|tmdb|tvdb)/(.+)$").find(p)?.let {
            val type = request.url.queryParameter("type")
            return send(200, if (it.groupValues[2] == "tt0111161") """[{"type":"$type","score":1000,"$type":{"ids":{"trakt":42}}}]""" else "[]")
        }
        if (p == "/sync/history/movies/42") return send(200, plays.lastOrNull()?.let { """[{"id":$it,"action":"watch"}]""" } ?: "[]")
        return send(404)
    }
}

private class MemoryStore : TraktStore {
    var account: TraktAccount? = null
    var off = setOf<String>()
    override suspend fun load() = account
    override suspend fun save(a: TraktAccount?) { account = a }
    override suspend fun offServers() = off
    override suspend fun setOffServers(ids: Set<String>) { off = ids }
}

class TraktTest {
    private lateinit var server: MockWebServer
    private lateinit var scope: CoroutineScope
    private val client = "wicaby-check-client"
    private val movie = Item("m1", type = "Movie", providerIds = mapOf("Imdb" to "tt0111161"))

    @Before
    fun setUp() {
        server = MockWebServer()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }

    @After
    fun tearDown() {
        scope.cancel()
        server.close()
    }

    private fun start(f: FakeTrakt): String {
        server.dispatcher = f
        server.start()
        return "http://${server.hostName}:${server.port}"
    }

    private suspend fun until(ms: Long = 8000, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + ms
        while (!cond()) {
            if (System.currentTimeMillis() > end) fail("timed out")
            delay(20)
        }
    }

    @Test
    fun bodiesAndPluginDetection() {
        fun item(type: String, vararg ids: Pair<String, String?>) = Item("x", type = type, providerIds = mapOf(*ids))
        assertEquals(
            buildJsonObject { put("movie", buildJsonObject { put("ids", buildJsonObject { put("imdb", "tt0111161"); put("tmdb", 278) }) }); put("progress", 12.35) },
            scrobbleBody(item("Movie", "Imdb" to "tt0111161", "Tmdb" to "278"), 12.3456),
        )
        assertEquals("""{"episode":{"ids":{"tvdb":349232}},"progress":100.0}""", scrobbleBody(item("Episode", "TVDB" to "349232", "imdb" to "bogus"), 150.0).toString())
        assertNull("no usable id", scrobbleBody(item("Episode", "Tvdb" to "x1"), 10.0))
        assertNull("no ids", scrobbleBody(item("Movie"), 10.0))
        assertNull("live TV is never scrobbled", scrobbleBody(item("TvChannel", "Imdb" to "tt1"), 10.0))
        assertEquals("0.0", scrobbleBody(item("Movie", "Tmdb" to "5"), Double.NaN)!!["progress"].toString())
        assertEquals("""{"episodes":[{"ids":{"tmdb":7}}]}""", historyBody(item("Episode", "Tmdb" to "7")).toString())
        assertNull(historyBody(item("Series", "Tmdb" to "7")))
        fun plugins(s: String) = hasTraktPlugin(json.parseToJsonElement(s))
        assertTrue("Emby lists loaded plugins only", plugins("""[{"Name":"Open Subtitles"},{"Name":"Trakt","Version":"3.2.0.0"}]"""))
        assertFalse("Jellyfin, disabled", plugins("""[{"Name":"Trakt","Status":"Disabled"}]"""))
        assertTrue("Jellyfin, active", plugins("""[{"Name":"Trakt","Status":"Active"}]"""))
        assertFalse(plugins("""[{"Name":"Webhooks"}]"""))
        assertFalse(plugins("""{"Items":[]}"""))
    }

    @Test
    fun clientFlow() = runBlocking {
        val f = FakeTrakt()
        val c = TraktClient(start(f), client)
        val code = c.deviceCode()
        assertEquals("AB12CD34", code.userCode)
        assertEquals(Poll.Pending, c.pollToken(code.deviceCode, f.secret))
        val tok = (c.pollToken(code.deviceCode, f.secret) as Poll.Done).tokens
        assertEquals(409, runCatching { c.pollToken(code.deviceCode, f.secret) }.exceptionOrNull().let { (it as TraktException).status })
        assertEquals(404, (runCatching { c.pollToken("nope", f.secret) }.exceptionOrNull() as TraktException).status)
        assertEquals("wika", c.username(tok.accessToken))
        c.scrobble("start", tok.accessToken, scrobbleBody(movie, 1.0)!!)
        val next = c.refresh(tok.refreshToken, f.secret)
        assertEquals("a refresh token works once", 401, (runCatching { c.refresh(tok.refreshToken, f.secret) }.exceptionOrNull() as TraktException).status)
        c.revoke(next.accessToken, f.secret)
        val e = runCatching { c.username(next.accessToken) }.exceptionOrNull() as TraktException
        assertEquals(401, e.status)
        assertFalse("no token in errors", e.message!!.contains(next.accessToken))
        assertEquals(listOf("start" to 1.0), f.scrobbles.toList())
    }

    @Test
    fun serviceConnectScrobbleRefreshDisconnect() = runBlocking {
        val f = FakeTrakt()
        val store = MemoryStore()
        val svc = TraktService(store, scope).apply { base = start(f) }

        svc.connect("short", "x")
        assertEquals(R.string.trakt_error_invalid_client, svc.state.value.error?.res)

        svc.connect(client, f.secret)
        assertEquals("AB12CD34", svc.state.value.pending?.userCode)
        assertNull(svc.state.value.user)
        until { svc.state.value.user == "wika" }
        assertNull(svc.state.value.pending)
        assertNull(svc.state.value.error)

        // In order; nothing for a server with the plugin, a server turned off, or an item without ids.
        svc.scrobble("start", "jf", movie, 60_000, 6_000_000) { false }
        svc.scrobble("pause", "jf", movie, 120_000, 6_000_000) { false }
        svc.scrobble("stop", "jf", movie, 5_400_000, 6_000_000) { null }
        svc.scrobble("start", "emby", movie, 0, 6_000_000) { true }
        svc.setScrobble("user", false)
        assertEquals(setOf("user"), svc.state.value.offServers)
        svc.scrobble("start", "user", movie, 0, 6_000_000) { false }
        svc.scrobble("start", "jf", Item("x", type = "Movie"), 0, 1) { false }
        svc.history("jf", movie, true) { false }
        svc.history("jf", movie, true) { false }
        until { f.history.size == 2 }
        assertEquals(listOf("start" to 1.0, "pause" to 2.0, "stop" to 90.0), f.scrobbles.toList())
        assertEquals(listOf("+movies", "+movies"), f.history.toList())

        // A revoked access token: one refresh, then the call goes through. "Unwatched" removes the latest play
        // only (B25): the first watch stays in the Trakt history.
        f.expire()
        svc.history("jf", movie, false) { false }
        until { f.history.size == 3 }
        assertEquals("-1001", f.history[2])
        assertEquals(listOf(1000L), f.plays.toList())
        // Unknown to Trakt: nothing removed.
        svc.history("jf", Item("m2", type = "Movie", providerIds = mapOf("Imdb" to "tt0000001")), false) { false }
        svc.history("jf", movie, true) { false }
        until { f.history.size == 4 }
        assertEquals("+movies", f.history[3])
        val saved = store.account!!.secrets
        assertTrue(saved.secret == f.secret && saved.access in f.access && saved.refresh != null && saved.expiresAt > System.currentTimeMillis())
        assertFalse("secrets never printed", store.account.toString().contains(saved.access!!) || store.account.toString().contains(f.secret))

        // Trakt forgot the refresh token too: authorize again.
        f.expire()
        store.account = store.account!!.copy(secrets = saved.copy(refresh = "gone"))
        svc.scrobble("start", "jf", movie, 0, 1) { false }
        until { svc.state.value.error != null }
        assertEquals(R.string.trakt_error_reauthorize, svc.state.value.error?.res)
        assertNull(svc.state.value.user)
        assertEquals("the secret is kept", f.secret, store.account?.secrets?.secret)

        svc.disconnect()
        assertNull(store.account)
        assertEquals("", svc.state.value.clientId)
    }

    @Test
    fun deniedAndCancelled() = runBlocking {
        val f = FakeTrakt(approveAfter = 1, deny = true)
        val store = MemoryStore()
        val svc = TraktService(store, scope).apply { base = start(f) }
        svc.connect(client, f.secret)
        until { svc.state.value.error != null }
        assertEquals(R.string.trakt_error_denied, svc.state.value.error?.res)
        assertNull(svc.state.value.pending)

        // An empty secret keeps the stored one for the same client id; Cancel stops the polling.
        svc.connect(client, "")
        assertNotNull(svc.state.value.pending)
        svc.cancel()
        assertNull(svc.state.value.pending)
        delay(1500)
        assertNull(svc.state.value.error)
        assertEquals(f.secret, store.account?.secrets?.secret)
    }
}
