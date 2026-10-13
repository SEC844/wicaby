package com.wika.wicaby.core.plex

import com.wika.wicaby.core.BuildConfig
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.PlaybackInfo
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.files.FilesTestKit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.addJsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

// PXA-core against the repository's own Plex mock (tools/mock-server/mock-plex.mjs: loopback only, every port free,
// nothing ever reaches plex.tv or a real Plex server): the PIN link, Home users and their PIN, the connection race
// (the Docker decoy dropped, local first), browsing through the Emby-shaped Api, the playback decision (direct play,
// transcode with the offset, multi-part, PGS burn, the remote cap and the remote-pass gate), the timeline with exactly
// one stopped, termination, the track PUT, markers, the watchlist as favourites, and where the tokens went.
// Skipped when node is not on the PATH.
class PlexMockTest {
    private val repo = File("../../..").canonicalFile
    private val mockScript = File(repo, "tools/mock-server/mock-plex.mjs")
    // Loopback only: anything else (plex.tv, the TEST-NET remote the mock lists, a LAN address) fails here, unsent.
    private val http = OkHttpClient.Builder().readTimeout(20, TimeUnit.SECONDS).addInterceptor { chain ->
        val host = chain.request().url.host
        if (host != "127.0.0.1" && host != "localhost" && !host.startsWith("127-0-0-1.")) throw IOException("not loopback: $host")
        chain.proceed(chain.request())
    }.build()
    private val client = PlexClient("wicaby-test-device", "Test device", "0.8.0-test", "14")

    private class Mock(val process: Process, val info: JsonObject) : AutoCloseable {
        fun s(k: String) = info[k].str()!!
        val pms get() = s("pms")
        val plextv get() = s("plextv")
        val relay get() = s("relay")

        override fun close() {
            process.destroy()
            process.waitFor(5, TimeUnit.SECONDS)
        }
    }

    @After
    fun reset() {
        PlexTv.devBase = null
    }

    private fun node(): String? = listOf("node", "node.exe").firstOrNull { n ->
        runCatching { ProcessBuilder(n, "--version").redirectErrorStream(true).start().let { it.waitFor(10, TimeUnit.SECONDS) && it.exitValue() == 0 } }.getOrDefault(false)
    }

    private fun start(env: Map<String, String> = emptyMap()): Mock {
        // PlexTv.devBase is honoured in debug builds only: a release unit test would aim at the real plex.tv.
        assumeTrue("debug build only", BuildConfig.DEBUG)
        val n = node()
        assumeTrue("node is not on the PATH", n != null && mockScript.isFile)
        // A script file, not -e: Windows command lines lose the quotes inside an argument. Switches go in the environment.
        val script = File(FilesTestKit.tempDir(), "start-mock-plex.mjs")
        script.writeText(
            listOf(
                "import { startMockPlex } from '${mockScript.toURI()}';",
                "const m = await startMockPlex({ port: 0, tvPort: 0, relayPort: 0, secondPort: 0 });",
                "console.log('MOCK ' + JSON.stringify({ pms: m.pms, plextv: m.plextv, relay: m.relay }));",
                "process.stdin.on('end', () => process.exit(0));",
                "process.stdin.resume();",
            ).joinToString("\n"),
        )
        val pb = ProcessBuilder(n, script.absolutePath).redirectError(ProcessBuilder.Redirect.INHERIT)
        // Never a real port: every listener on a free loopback port (the second PMS too, so nothing probes 32410).
        pb.environment().keys.removeAll { it.startsWith("MOCK_") || it == "PORT" }
        pb.environment().putAll(mapOf("MOCK_PLEX_SECOND" to "1") + env)
        val p = pb.start()
        val out = p.inputStream.bufferedReader()
        val line = generateSequence { out.readLine() }.firstOrNull { it.startsWith("MOCK ") } ?: run { p.destroy(); error("mock-plex did not start") }
        // Keep draining its log so it never blocks on a full pipe.
        Thread { runCatching { while (out.readLine() != null) Unit } }.apply { isDaemon = true }.start()
        return Mock(p, Json.parseToJsonElement(line.removePrefix("MOCK ")).jsonObject)
    }

    private fun state(base: String): JsonObject =
        http.newCall(Request.Builder().url("$base/Mock/State").build()).execute().use { Json.parseToJsonElement(it.body.string()).jsonObject }

    private fun post(url: String) = http.newCall(Request.Builder().url(url).post(ByteArray(0).toRequestBody()).build()).execute().use { assertTrue(url, it.isSuccessful) }

    private fun accounts(m: Mock): PlexAccounts {
        PlexTv.devBase = m.plextv
        val dir = File(FilesTestKit.tempDir(), "plex-${System.nanoTime()}")
        // No device network is a Plex "local" network here: the Docker decoy (172.17.0.2) is dropped, loopback kept.
        return PlexAccounts(PlexStore(dir, { "sealed:$it" }, { it.removePrefix("sealed:") }), PlexTv(http) { client }, http, subnets = { emptyList() })
    }

    // Link with a code: the PIN is created, entered on the (mock) plex.tv, then polled.
    private suspend fun link(m: Mock, a: PlexAccounts): PlexAccounts.Poll.Linked {
        val l = a.link()
        assertTrue(l.url, l.url.startsWith("https://plex.tv/link?code="))
        assertEquals(PlexAccounts.Poll.Waiting, a.poll())
        post("${m.plextv}/Mock/Pin/Link?code=${l.code}")
        return a.poll() as PlexAccounts.Poll.Linked
    }

    private fun api(s: PlexAccounts.SignIn, a: PlexAccounts, server: Server = s.server) =
        PlexApi(server, client.deviceId, s.token, s.userId, a.options(server, s.userId, s.userName), http, client)

    private fun JsonElement?.strings(key: String) = this.list().map { it[key].str() }

    private fun profile(directCodecs: String) = buildJsonObject {
        putJsonArray("DirectPlayProfiles") { addJsonObject { put("Type", "Video"); put("Container", "mkv,mp4"); put("VideoCodec", directCodecs); put("AudioCodec", "aac,eac3,ac3") } }
        putJsonArray("TranscodingProfiles") { addJsonObject { put("Type", "Video"); put("Container", "ts"); put("VideoCodec", "h264"); put("AudioCodec", "aac"); put("Protocol", "hls") } }
        putJsonArray("SubtitleProfiles") { addJsonObject { put("Format", "srt"); put("Method", "External") } }
    }

    private suspend fun playbackInfo(api: PlexApi, id: String, body: JsonObject): JsonObject =
        Json.parseToJsonElement(api.raw("POST", "/Items/$id/PlaybackInfo", body.toString(), "UserId" to api.userId)).jsonObject

    private fun report(id: String, session: String, positionMs: Long, paused: Boolean = false, extra: JsonObject.() -> JsonObject = { this }) = buildJsonObject {
        put("ItemId", id)
        put("PlaySessionId", session)
        put("PositionTicks", positionMs * 10_000)
        put("IsPaused", paused)
        put("PlayMethod", "DirectPlay")
    }.extra().toString()

    @Test
    fun linkSignInBrowsePlayAndReport() = runBlocking {
        start().use { m ->
            val a = accounts(m)
            val linked = link(m, a)
            // Three Home users: someone must pick; nothing signed in yet.
            assertEquals(listOf("Wika", "Ado", "Invité"), linked.users.map { it.title })
            assertTrue(linked.users.first { it.title == "Ado" }.protected)
            assertTrue(linked.signedIn.isEmpty())
            assertEquals(listOf("Wika", "Ado", "Invité"), a.users(linked.account).map { it.title })

            // A protected Home user never signs in without the right PIN.
            assertEquals(401, (runCatching { a.signIn(linked.account, "Ado") }.exceptionOrNull() as ApiException).status)
            assertEquals(401, (runCatching { a.signIn(linked.account, "Ado", "0000") }.exceptionOrNull() as ApiException).status)
            val ado = a.signIn(linked.account, "Ado", "1234")
            assertEquals(2, ado.size)
            assertTrue(ado.all { it.userId == "b2c3d4e5f6071829" && it.server.kind == "plex" })

            // The account itself: the local loopback connection wins the race (the Docker decoy dropped, the unroutable
            // remote and the relay never needed), and becomes lastGood.
            val owner = a.signIn(linked.account, linked.account).first { it.server.name == "Maison" }
            assertEquals(m.pms, owner.server.address)
            assertNull("loopback is not a LAN address: no D-3 prompt", owner.confirm)
            assertFalse(owner.relay)
            assertEquals(m.pms, a.servers().first { it.id == owner.server.id }.lastGood)
            val api = api(owner, a)
            assertTrue("D-2: the owner", api.options.owner)
            assertFalse(api.options.remote)

            // Browse through the Emby-shaped calls the apps make.
            assertEquals(listOf("Films", "Séries", "Musique"), api.views().map { it.name })
            assertEquals(listOf("movies", "tvshows", "music"), api.views().map { it.collectionType })
            val films = api.items("ParentId" to "section-1", "IncludeItemTypes" to "Movie", "Recursive" to true, "SortBy" to "SortName", "SortOrder" to "Ascending", "StartIndex" to 0, "Limit" to 50)
            assertEquals(12, films.items.size)
            assertEquals(12, films.totalRecordCount)
            val poster = api.image(films.items[0].id, "Primary", films.items[0].imageTags["Primary"], maxWidth = 300)
            assertTrue(poster, poster.startsWith("${m.pms}/photo/:/transcode?url=%2Flibrary%2Fmetadata%2F"))
            val bunny = api.item("1000")
            assertEquals(listOf("Theatrical", "Director's Cut"), bunny.mediaSources.map { it.name })
            assertEquals("tt1254207", bunny.providerIds["Imdb"])
            assertEquals("the missing version is hidden", 1, api.item("1001").mediaSources.size)
            assertEquals(1, api.localTrailers("1000").size)
            assertEquals(1, api.specialFeatures("1000").size)
            assertTrue("flattenSeasons: no seasons", api.seasons("2100").isEmpty())
            assertEquals(4, api.episodes("2100").size)
            assertEquals(listOf(1, 2), api.seasons("2200").map { it.indexNumber })
            assertTrue("a single shared item is found by search", api.items("SearchTerm" to "Agent", "IncludeItemTypes" to "Movie", "Recursive" to true, "Limit" to 20).items.any { it.id == "1100" })
            assertTrue(api.resume().any { it.id == "1002" })
            assertEquals(listOf("2003"), api.nextUp().map { it.id })
            assertTrue(api.latest("section-1").isNotEmpty())
            assertTrue(api.hubs().map { it["Name"].str() }.contains("Continue Watching"))
            assertEquals(2, api.albumArtists("ParentId" to "section-3").items.size)
            assertEquals("music: an album's tracks", 4, api.items("ParentId" to "3001", "IncludeItemTypes" to "Audio").items.size)
            // An unknown filter is a 404 PLEX-UNMAPPED, never a wrong answer.
            val unmapped = runCatching { api.items("ParentId" to "section-1", "HasSubtitles" to true) }.exceptionOrNull() as ApiException
            assertEquals(404, unmapped.status)
            assertTrue(unmapped.message!!.startsWith("PLEX-UNMAPPED"))

            // Markers (D-5: only what the server found): intro and credits on an episode, no intro on a film.
            assertEquals(listOf("Intro", "Outro"), api.mediaSegments("2002").map { it.type })
            assertEquals(listOf("Outro"), api.mediaSegments("1000").map { it.type })

            // Watched state, hide from Continue, offline progress.
            api.setPlayed("1003", true)
            api.hideFromResume("1002", true)
            api.updateUserData("1004", 600_000L * 10_000, false, "2026-10-13T10:00:00.000Z")

            // D-6: favourites are the plex.tv watchlist of the signed-in Home user.
            api.setFavorite("2000", true)
            val favs = api.items("Filters" to "IsFavorite", "Recursive" to true, "IncludeItemTypes" to "Series")
            assertEquals(listOf("2000"), favs.items.map { it.id })
            assertTrue(favs.items[0].userData!!.isFavorite)
            api.setFavorite("2000", false)

            // ---- Playback ----
            val direct = playbackInfo(api, "1006", buildJsonObject { put("DeviceProfile", profile("h264")); put("MaxStreamingBitrate", 200_000_000); put("StartTimeTicks", 0) })
            val ds = direct["MediaSources"]!!.jsonArray[0]
            assertTrue(ds["SupportsDirectPlay"].isTrue())
            assertNull(ds["TranscodingUrl"])
            val session = direct["PlaySessionId"].str()!!
            val streamUrl = api.url("/Videos/1006/stream", "static" to true, "MediaSourceId" to ds["Id"].str(), "PlaySessionId" to session)
            assertTrue(streamUrl, streamUrl.startsWith("${m.pms}/library/parts/") && "Token" !in streamUrl)
            assertEquals("the app's own PlaybackInfo DTO reads it", true, api.post<PlaybackInfo>("/Items/1006/PlaybackInfo", buildJsonObject { put("DeviceProfile", profile("h264")) }.toString()).mediaSources[0].supportsDirectPlay)
            assertTrue("the BIF of a single-part file", api.url("/Videos/1006/index.bif").endsWith("/indexes/sd"))

            // HEVC on an h264-only profile transcodes, from the resume point: the offset rides in start.m3u8 (§6.1.4).
            val trans = playbackInfo(api, "1002", buildJsonObject { put("DeviceProfile", profile("h264")); put("StartTimeTicks", 600_000L * 10_000) })["MediaSources"]!!.jsonArray[0]
            assertFalse(trans["SupportsDirectPlay"].isTrue())
            val tu = trans["TranscodingUrl"].str()!!
            assertTrue(tu, tu.startsWith("/video/:/transcode/universal/start.m3u8?") && "offset=600" in tu && "X-Plex-Token" !in tu)
            assertEquals(6_000_000_000L, trans["StartTimeTicks"].num()!!.toLong())
            assertTrue(api.resolve(tu).startsWith(m.pms))

            // D-4: a two-part film is one source with its parts in order; a start in part 2 decides on part 2.
            val two = api.item("1005")
            val partMs = (two.runTimeTicks!! / 10_000 + 1) / 2
            val multi = playbackInfo(api, "1005", buildJsonObject { put("DeviceProfile", profile("h264")); put("StartTimeTicks", (partMs + 10_000) * 10_000) })["MediaSources"]!!.jsonArray[0]
            assertEquals(2, multi["PartPaths"].list().size)
            // A PGS subtitle the player cannot draw over a transcode is burned in (#1398).
            val pgs = api.item("1004").mediaSources[0].mediaStreams.first { it.codec == "pgssub" }.index
            playbackInfo(api, "1004", buildJsonObject { put("DeviceProfile", profile("hevc")); put("SubtitleStreamIndex", pgs) })
            val decisions = state(m.pms)["decisions"].list()
            assertEquals("1", decisions.first { it["key"].str() == "1005" }["partIndex"].str())
            assertEquals("10", decisions.first { it["key"].str() == "1005" }["offset"].str())
            assertEquals("burn", decisions.last()["subtitles"].str())

            // Reporting: playing, paused, stopped once (a second Stopped is never sent, and nothing scrobbles: #1740).
            api.raw("POST", "/Sessions/Playing", report("1006", session, 0))
            api.raw("POST", "/Sessions/Playing/Progress", report("1006", session, 5_000, paused = true))
            api.raw("POST", "/Sessions/Playing/Stopped", report("1006", session, 9_000))
            api.raw("POST", "/Sessions/Playing/Stopped", report("1006", session, 9_000))
            api.raw("POST", "/Sessions/Playing/Progress", report("1006", session, 9_500))
            api.raw("POST", "/Sessions/Playing/Ping", null, "PlaySessionId" to session)
            api.raw("DELETE", "/Videos/ActiveEncodings", null, "DeviceId" to client.deviceId, "PlaySessionId" to session)
            assertEquals(listOf("playing", "paused", "stopped"), state(m.pms)["timelines"].list().filter { it["session"].str() == session }.map { it["state"].str() })

            // A manual audio change is stored on the part, once (#1326).
            val ep = api.item("2002")
            val epInfo = playbackInfo(api, "2002", buildJsonObject { put("DeviceProfile", profile("h264")) })
            val epSession = epInfo["PlaySessionId"].str()!!
            val english = ep.mediaSources[0].mediaStreams.first { it.type == "Audio" && it.language == "eng" }.index
            val change = { body: JsonObject -> JsonObject(body + ("EventName" to JsonPrimitive("AudioTrackChange")) + ("AudioStreamIndex" to JsonPrimitive(english)) + ("MediaSourceId" to JsonPrimitive(ep.mediaSources[0].id))) }
            api.raw("POST", "/Sessions/Playing", report("2002", epSession, 0))
            api.raw("POST", "/Sessions/Playing/Progress", report("2002", epSession, 1_000) { change(this) })
            api.raw("POST", "/Sessions/Playing/Progress", report("2002", epSession, 2_000) { change(this) })
            assertEquals(listOf(english.toString()), state(m.pms)["partPuts"].list().map { it["audioStreamID"].str() })

            // Termination by the server owner: the player is stopped with the text, and nothing more is reported (#1362).
            var stoppedWith: String? = null
            api.onTerminated = { stoppedWith = it }
            post("${m.pms}/Mock/Terminate?session=$epSession&reason=Bedtime")
            api.raw("POST", "/Sessions/Playing/Progress", report("2002", epSession, 3_000))
            assertEquals("Bedtime", stoppedWith)
            val before = state(m.pms)["timelines"].list().count { it["session"].str() == epSession }
            api.raw("POST", "/Sessions/Playing/Stopped", report("2002", epSession, 3_000))
            assertEquals(before, state(m.pms)["timelines"].list().count { it["session"].str() == epSession })

            // Where the tokens went: the account token only to plex.tv, the server token only as a header, a client id on
            // every call, nothing unmapped, no duplicate stopped or scrobble.
            val st = state(m.pms)
            assertFalse(st["tokens"]["pms"].list().any { it.str() == "mock-account-token" })
            assertTrue(st["tokens"]["plextv"].list().any { it.str() == "mock-account-token" })
            val tags = st["tags"].list().map { it.str() }
            for (bad in listOf("TOKEN-IN-URL", "NO-CLIENT-ID", "NO-TOKEN", "ACCOUNT-TOKEN-ON-PMS", "UNMAPPED", "DUP-STOPPED", "AFTER-STOPPED", "DUP-SCROBBLE", "HTTP-REFUSED")) {
                assertFalse("mock tag $bad in $tags", bad in tags)
            }
            assertTrue(st["scrobbles"].list().any { it["key"].str() == "1003" && it["played"].isTrue() })
            assertEquals(listOf("1002"), st["hidden"].list().map { it.str() })
            assertTrue(st["calls"].list().any { it["path"].str() == "/:/progress" && it["query"]["time"].str() == "600000" })
        }
    }

    @Test
    fun remoteCapRemotePassAndHttpsRequired() = runBlocking {
        // §6.2: a remote session (through the relay) starts at the owner's remote cap; one over it retries down to it.
        start(mapOf("MOCK_REMOTE_CAP_KBPS" to "2000")).use { m ->
            val a = accounts(m)
            link(m, a)
            val owner = a.signIn(a.servers().first().account, a.servers().first().account).first { it.server.name == "Maison" }
            val viaRelay = owner.server.copy(address = m.relay)
            val capped = PlexApi(viaRelay, client.deviceId, owner.token, owner.userId, PlexApi.Options("Wika", owner = true, remote = true), http, client)
            assertNotNull(playbackInfo(capped, "1006", buildJsonObject { put("DeviceProfile", profile("h264")); put("MaxStreamingBitrate", 200_000_000) })["MediaSources"]!!.jsonArray.firstOrNull())
            assertEquals(listOf("2000"), state(m.pms)["decisions"].list().map { it["maxVideoBitrate"].str() })
            // Not known as remote: the 500 "Cannot make a decision" is retried down the ladder until the cap plays.
            val unaware = PlexApi(viaRelay, client.deviceId, owner.token, owner.userId, PlexApi.Options("Wika", owner = true, remote = false), http, client)
            assertNotNull(playbackInfo(unaware, "1006", buildJsonObject { put("DeviceProfile", profile("h264")); put("MaxStreamingBitrate", 200_000_000) })["MediaSources"]!!.jsonArray.firstOrNull())
            val results = state(m.pms)["decisions"].list().drop(1)
            assertEquals("500", results.first()["result"].str())
            assertEquals("2000", results.last()["maxVideoBitrate"].str())
            assertTrue(results.last()["result"].str() != "500")
        }
        // §1.3: remote playback without a pass is explained (403), never worked around.
        start(mapOf("MOCK_REMOTE_PASS" to "0")).use { m ->
            val a = accounts(m)
            link(m, a)
            val owner = a.signIn(a.servers().first().account, a.servers().first().account).first { it.server.name == "Maison" }
            val remote = PlexApi(owner.server.copy(address = m.relay), client.deviceId, owner.token, owner.userId, PlexApi.Options(remote = true), http, client)
            val e = runCatching { playbackInfo(remote, "1006", buildJsonObject { put("DeviceProfile", profile("h264")) }) }.exceptionOrNull() as ApiException
            assertEquals(403, e.status)
            assertEquals(1, state(m.pms)["decisions"].list().size)
        }
        // #929: a server that requires https is never called over plain http.
        start(mapOf("MOCK_PLEX_HTTPS_REQUIRED" to "1")).use { m ->
            val a = accounts(m)
            val linked = link(m, a)
            assertTrue(a.servers().first { it.name == "Maison" }.httpsRequired)
            val e = runCatching { a.connect(PlexMockIds.MACHINE) }.exceptionOrNull()
            assertTrue(e is IOException)
            // Only the second server (no https rule) signs in; Maison is never probed over http.
            assertEquals(listOf("Chez Léa"), a.signIn(linked.account, linked.account).map { it.server.name })
            assertTrue("no PMS call over http", state(m.pms)["calls"].list().none { it["server"].str() == "Maison" })
            assertFalse("HTTP-REFUSED" in state(m.pms)["tags"].list().map { it.str() })
        }
    }

    @Test
    fun d3ConfirmAndD10Hide() = runBlocking {
        val dir = File(FilesTestKit.tempDir(), "plex-d3-${System.nanoTime()}")
        val store = PlexStore(dir, { it }, { it })
        val a = PlexAccounts(store, PlexTv(http) { client }, http, subnets = { listOf("192.168.1.0/24") })
        store.putResources(
            "acct",
            listOf(
                PlexResource(
                    "Second server", PlexMockIds.MACHINE, "server", owned = false, sourceTitle = "Léa", accessToken = "t",
                    connections = listOf(PlexConnection("http://192.168.1.5:32400", "http", "192.168.1.5", 32400, local = true)),
                ),
            ),
        )
        val s = store.server(PlexMockIds.MACHINE)!!
        // D-3: a plain-http LAN address gets the token only once the user agreed; a background pick never goes there.
        assertEquals("http://192.168.1.5:32400", a.needsConfirm(s, "http://192.168.1.5:32400"))
        assertTrue(runCatching { a.connect(s.id, interactive = false) }.exceptionOrNull() is IOException)
        // A server offline at sign-in keeps that address, with the prompt; until then no request carries the token.
        assertEquals("http://192.168.1.5:32400", a.fallback(s)?.confirm)
        val lan = Server(s.id, s.name, "http://192.168.1.5:32400", "plex")
        val unbound = PlexApi(lan, client.deviceId, "t", "acct", a.options(lan, "acct"), http, client)
        assertTrue(unbound.options.unbound)
        assertNull(unbound.authHeaders()["X-Plex-Token"])
        assertEquals(403, (runCatching { unbound.raw("GET", "/Users/acct/Views", null) }.exceptionOrNull() as? ApiException)?.status)
        assertTrue("an address plex.tv never listed", a.options(lan.copy(address = "http://192.168.1.9:32400"), "acct").unbound)
        a.confirm(s.id, "http://192.168.1.5:32400")
        assertNull(a.needsConfirm(store.server(s.id)!!, "http://192.168.1.5:32400"))
        assertNull(a.fallback(store.server(s.id)!!)?.confirm)
        assertFalse(a.options(lan, "acct").unbound)
        // D-10: a shared server shows by default; hidden, it stays stored.
        assertFalse(store.server(s.id)!!.hidden)
        a.setHidden(s.id, true)
        assertTrue(store.server(s.id)!!.hidden)
        assertEquals("Léa", store.server(s.id)!!.source)
        // Tokens are stored sealed only (the Keystore seal in the app).
        val sealed = PlexStore(File(dir, "x"), { "S($it)" }, { it.removeSurrounding("S(", ")") })
        sealed.putAccount(PlexAccount("abcdef0123", "Wika"), "secret-token")
        assertFalse(File(dir, "x/plex.json").readText().contains("\"secret-token\""))
        assertEquals("secret-token", sealed.accountToken("abcdef0123"))
    }
}

private object PlexMockIds {
    const val MACHINE = "d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0"
}
