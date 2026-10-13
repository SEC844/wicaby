package com.wika.wicaby.mobile.music

import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.performClick
import androidx.navigation.compose.rememberNavController
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.music.albums
import com.wika.wicaby.mobile.player.PlayerHolder
import com.wika.wicaby.mobile.ui.Accents
import com.wika.wicaby.mobile.ui.Cache
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.GridRoute
import com.wika.wicaby.mobile.ui.WicabyTheme
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

// Music spec MU-07 AC5 on an emulator against mock-emby on the host (10.0.2.2), silent WAVs, media volume 0 (set by
// tools/checks/music-android-emu.mjs, which runs this): the session plays, `dumpsys media_session` lists it PLAYING with
// the track's metadata, the media notification names the track, KEYCODE_MEDIA_NEXT moves to the next one. Screenshots
// (library, mini player, now playing, queue) land in the app's files dir for the script to pull.
@RunWith(AndroidJUnit4::class)
class MusicDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val base = InstrumentationRegistry.getArguments().getString("mock") ?: "http://10.0.2.2:8987"
    private lateinit var api: Api

    @Before
    fun signIn(): Unit = runBlocking {
        val server = Server("mock", "Mock", base, "emby")
        val auth = Api(server, "music-test").login("Wika", "wicaby")
        api = Api(server, "music-test", auth.accessToken, auth.user.id)
        // The stream and art requests get their auth from the active server (ServerAuthInterceptor).
        Core.api = api
        Cache.map.clear()
    }

    @After
    fun stop() = instrumentation.runOnMainSync { PlayerHolder.release() }

    private fun shell(cmd: String): String {
        val fd = instrumentation.uiAutomation.executeShellCommand(cmd)
        return ParcelFileDescriptor.AutoCloseInputStream(fd).bufferedReader().readText()
    }

    private fun shot(name: String) {
        rule.waitForIdle()
        Thread.sleep(600)
        val png = instrumentation.uiAutomation.takeScreenshot() ?: return
        File(instrumentation.targetContext.filesDir, "$name.png").outputStream().use { png.compress(Bitmap.CompressFormat.PNG, 100, it) }
        println("music-shot=$name.png")
    }

    private fun waitFor(what: String, ms: Long = 30_000, ok: () -> Boolean) {
        val end = System.currentTimeMillis() + ms
        while (!ok()) {
            if (System.currentTimeMillis() > end) println("music-debug=" + shell("dumpsys media_session").lines().filter { "wicaby" in it || "state=" in it || "metadata" in it }.take(20).joinToString(" | "))
            assertTrue("timed out: $what", System.currentTimeMillis() < end)
            Thread.sleep(200)
        }
    }

    @Test
    fun theSessionIsOnTheSystemAndFollowsTheMediaKeys() {
        val album = runBlocking { api.albums("lib-music").items.let { all -> all.firstOrNull { (it.childCount ?: 0) in 3..20 } ?: all.first() } }
        val tracks = runBlocking { tracksOf(api, album.id, "MusicAlbum", album.name) }
        assertTrue("the album has tracks", tracks.size >= 3)
        rule.setContent {
            WicabyTheme(Accents[0]) {
                // The app's root paints the canvas (WicabyRoot); this bare activity does it here.
                Box(Modifier.fillMaxSize().background(G.bg)) {
                    Column(Modifier.fillMaxSize()) {
                        Box(Modifier.weight(1f)) { MusicScreen(api, GridRoute("Musique", parentId = "lib-music", collectionType = "music"), rememberNavController()) }
                        MiniPlayerSlot()
                    }
                    MusicOverlay()
                }
            }
        }
        rule.waitUntil(20_000) { rule.onAllNodes(hasText(album.name)).fetchSemanticsNodes().isNotEmpty() }
        instrumentation.runOnMainSync { PlayerHolder.startMusic(instrumentation.targetContext, api, tracks) }
        waitFor("playing") { PlayerHolder.music?.isPlaying == true }
        shot("music-library-mini-player")

        var dump = ""
        waitFor("media_session lists the session PLAYING with the track's title") {
            dump = shell("dumpsys media_session")
            // Older releases print state=3, newer ones state=PLAYING(3).
            dump.contains("package=com.wika.wicaby") && Regex("""state=(PLAYING\(3\)|3)""").containsMatchIn(dump) && dump.contains(tracks[0].name)
        }
        println("music-media-session=PLAYING ${tracks[0].name}")
        waitFor("the notification names the track") { shell("dumpsys notification --noredact").let { it.contains("com.wika.wicaby") && it.contains(tracks[0].name) } }
        println("music-notification=${tracks[0].name}")

        shell("input keyevent KEYCODE_MEDIA_NEXT")
        waitFor("KEYCODE_MEDIA_NEXT advances") { PlayerHolder.music?.current?.id == tracks[1].id }
        println("music-next=${tracks[1].name}")

        instrumentation.runOnMainSync { NowPlaying.open = true }
        rule.waitUntil(10_000) { rule.onAllNodes(hasContentDescription("Queue") or hasContentDescription("File d’attente")).fetchSemanticsNodes().isNotEmpty() }
        shot("music-now-playing")
        rule.onNode(hasContentDescription("Queue") or hasContentDescription("File d’attente")).performClick()
        rule.waitUntil(10_000) { rule.onAllNodes(hasText(tracks[2].name)).fetchSemanticsNodes().isNotEmpty() }
        shot("music-queue")
    }
}
