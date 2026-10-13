package com.wika.wicaby.mobile.ui

import android.app.Application
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import com.wika.wicaby.core.plex.PlexApi
import kotlinx.coroutines.runBlocking
import com.wika.wicaby.core.BuildConfig
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.plex.PlexAccounts
import com.wika.wicaby.core.plex.PlexClient
import com.wika.wicaby.core.plex.PlexStore
import com.wika.wicaby.core.plex.PlexTv
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

// PXA-mobile: the phone's Plex link screen against the repository's mock (tools/mock-server/mock-plex.mjs, loopback
// only: nothing reaches plex.tv or a real Plex server). Link with a code, then the Home profiles: a protected one is
// never signed in without its PIN, a wrong PIN says so, the right one signs that profile in to its servers.
// The mock part is skipped when node is not on the PATH.
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "en")
class PlexLinkTest {
    @get:Rule
    val rule = createComposeRule()

    private val repo = File("../../..").canonicalFile
    private val mockScript = File(repo, "tools/mock-server/mock-plex.mjs")
    private val http = OkHttpClient.Builder().readTimeout(20, TimeUnit.SECONDS).addInterceptor { chain ->
        val host = chain.request().url.host
        if (host != "127.0.0.1" && host != "localhost") throw IOException("not loopback: $host")
        chain.proceed(chain.request())
    }.build()

    @After
    fun reset() {
        PlexTv.devBase = null
    }

    private fun sign(id: String, owned: Boolean) = PlexAccounts.SignIn(Server(id, id, "https://$id.example", "plex"), "t", "u", "U", owned, false, null)

    @Test
    fun theOwnServerBecomesPrimaryOnlyWhenNothingIsSignedIn() {
        val list = listOf(sign("shared", false), sign("mine", true))
        assertEquals("mine", plexPrimary(list, null, signedIn = false, add = false))
        // A profile switch keeps the primary server where it was.
        assertEquals("shared", plexPrimary(list, "shared", signedIn = false, add = false))
        // Adding, or another server already primary: every plex server is an extra account.
        assertNull(plexPrimary(list, null, signedIn = false, add = true))
        assertNull(plexPrimary(list, "emby-home", signedIn = true, add = false))
        // A switch to a profile without the primary server, signed out: the own server rather than nothing.
        assertEquals("mine", plexPrimary(list, "gone", signedIn = false, add = false))
    }

    private fun node(): String? = listOf("node", "node.exe").firstOrNull { n ->
        runCatching { ProcessBuilder(n, "--version").redirectErrorStream(true).start().let { it.waitFor(10, TimeUnit.SECONDS) && it.exitValue() == 0 } }.getOrDefault(false)
    }

    private val client = PlexClient("wicaby-test-device", "Test device", "0.8.0-test", "14")

    // The mock on free loopback ports, plex.tv pointed at it, a store in a temp folder.
    private fun withMock(block: (plextv: String, accounts: PlexAccounts) -> Unit) {
        assumeTrue("debug build only", BuildConfig.DEBUG)
        val n = node()
        assumeTrue("node is not on the PATH", n != null && mockScript.isFile)
        val dir = kotlin.io.path.createTempDirectory("wicaby-plex-ui").toFile()
        val script = File(dir, "start-mock-plex.mjs")
        script.writeText(
            listOf(
                "import { startMockPlex } from '${mockScript.toURI()}';",
                "const m = await startMockPlex({ port: 0, tvPort: 0, relayPort: 0, secondPort: 0 });",
                "console.log('MOCK ' + m.plextv);",
                "process.stdin.on('end', () => process.exit(0));",
                "process.stdin.resume();",
            ).joinToString("\n"),
        )
        val pb = ProcessBuilder(n, script.absolutePath).redirectError(ProcessBuilder.Redirect.INHERIT)
        pb.environment().keys.removeAll { it.startsWith("MOCK_") || it == "PORT" }
        val p = pb.start()
        try {
            val out = p.inputStream.bufferedReader()
            val plextv = generateSequence { out.readLine() }.firstOrNull { it.startsWith("MOCK ") }?.removePrefix("MOCK ") ?: error("mock-plex did not start")
            Thread { runCatching { while (out.readLine() != null) Unit } }.apply { isDaemon = true }.start()
            PlexTv.devBase = plextv
            block(plextv, PlexAccounts(PlexStore(File(dir, "plex"), { "sealed:$it" }, { it.removePrefix("sealed:") }), PlexTv(http) { client }, http, subnets = { emptyList() }))
        } finally {
            p.destroy()
            p.waitFor(5, TimeUnit.SECONDS)
        }
    }

    private fun enter(plextv: String, code: String) =
        http.newCall(Request.Builder().url("$plextv/Mock/Pin/Link?code=$code").post(ByteArray(0).toRequestBody()).build()).execute().use { assertTrue(it.isSuccessful) }

    @Test
    fun linkWithACodeThenAProtectedProfileNeedsItsPin() = withMock { plextv, accounts ->
        var saved: List<PlexAccounts.SignIn>? = null
        rule.setContent { WicabyTheme(Accents[0]) { PlexLinkScreen({}, {}, accounts) { saved = it } } }

        rule.onNodeWithText("Link with a code").performClick()
        rule.waitUntil(15_000) { rule.onAllNodes(hasTestTag("plex-code")).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Open plex.tv/link").assertExists()
        enter(plextv, rule.onNodeWithTag("plex-code").fetchSemanticsNode().config[SemanticsProperties.Text].first().text)

        rule.waitUntil(20_000) { rule.onAllNodes(hasText("Ado")).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Invité").assertExists()
        rule.onNodeWithText("Ado").performClick()
        rule.waitForIdle()
        assertNull("a protected profile is never signed in without its PIN", saved)

        rule.onNode(hasSetTextAction()).performTextReplacement("0000")
        rule.onNodeWithText("Sign In").performScrollTo().performClick()
        rule.waitUntil(15_000) { rule.onAllNodes(hasText("wrong pin", substring = true, ignoreCase = true)).fetchSemanticsNodes().isNotEmpty() }
        assertNull(saved)

        rule.onNode(hasSetTextAction()).performTextReplacement("1234")
        rule.onNodeWithText("Sign In").performScrollTo().performClick()
        rule.waitUntil(20_000) { saved != null }
        val signed = saved!!
        assertTrue(signed.isNotEmpty())
        assertTrue(signed.all { it.userName == "Ado" && it.server.kind == "plex" })
        assertTrue(signed.any { it.server.name == "Maison" })
    }

    // allowSync (plex spec §1.3): the mock's films allow it, its episodes do not; the Download button follows.
    @Test
    fun downloadShowsOnlyWherePlexAllowsIt() = withMock { plextv, accounts ->
        val owner = runBlocking {
            val l = accounts.link()
            enter(plextv, l.code)
            val linked = accounts.poll() as PlexAccounts.Poll.Linked
            accounts.signIn(linked.account, linked.account).first { it.server.name == "Maison" }
        }
        val api = PlexApi(owner.server, client.deviceId, owner.token, owner.userId, accounts.options(owner.server, owner.userId), http, client)
        var id by mutableStateOf("1000")
        rule.setContent { androidx.compose.material3.Text(if (rememberCanDownload(api, id)) "allowed:$id" else "refused:$id") }
        rule.waitUntil(20_000) { rule.onAllNodes(hasText("allowed:1000")).fetchSemanticsNodes().isNotEmpty() }
        // An episode of the mock's show (2000 > season 2001 > 2002…): no allowSync, no Download button.
        id = "2002"
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("refused:2002")).fetchSemanticsNodes().isNotEmpty() }
        rule.waitForIdle()
        rule.onNodeWithText("refused:2002").assertExists()
        // The enqueue path asks the same question, so a refused item is never fetched either.
        assertNull(runBlocking { api.downloadPath("2002") })
    }
}
