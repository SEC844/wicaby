package com.wika.wicaby.tv.music

import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.tv.LocalApi
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.Nav
import com.wika.wicaby.tv.Route
import com.wika.wicaby.tv.ui.Accents
import com.wika.wicaby.tv.ui.WicabyTheme
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

// 0.10.2 on the Android TV emulator (never a real TV), against mock-emby on the host with its music library
// (MOCK_DATASET=demo or MOCK_MUSIC=1): an artist opens their page (focus on Lire), Down reaches the albums row, OK opens
// the album page (focus on Lire), OK plays it in the music session, Back returns to the artist. The host then reads the
// mock's Mock/State: the streams it served (with a DeviceId) and the Playing / Stopped reports. Keys go into the
// Compose tree. Run on ONE emulator by its serial:
//   adb -s emulator-NNNN shell am instrument -w -e mock http://10.0.2.2:PORT -e class com.wika.wicaby.tv.music.ArtistTvDeviceTest com.wika.wicaby.tv.test/androidx.test.runner.AndroidJUnitRunner
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class ArtistTvDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val base = InstrumentationRegistry.getArguments().getString("mock") ?: "http://10.0.2.2:8984"
    private val server = Server("mock", "Mock", base, "emby")

    @After
    fun stop() = instrumentation.runOnMainSync { Music.release() }

    private fun press(key: Key) {
        rule.onRoot().performKeyInput { pressKey(key) }
        rule.waitForIdle()
    }

    private fun focused(tag: String) = rule.waitUntil(15_000) { runCatching { rule.onNodeWithTag(tag).assertIsFocused() }.isSuccess }

    // MainActivity's stack and its Back, with the two music pages.
    private fun stack(api: Api, first: Route): SnapshotStateList<Route> {
        val stack = mutableStateListOf(first)
        rule.setContent {
            val nav = remember { Nav(stack) {} }
            CompositionLocalProvider(LocalNav provides nav, LocalApi provides api) {
                WicabyTheme(Accents[0]) {
                    BackHandler(stack.size > 1) { nav.pop() }
                    when (val r = stack.last()) {
                        is Route.MusicArtist -> ArtistScreen(api, r.id, r.name)
                        is Route.MusicAlbum -> AlbumScreen(api, r.id, r.name)
                        else -> Unit
                    }
                }
            }
        }
        return stack
    }

    @Test
    fun artistPageAlbumAndPlay(): Unit = runBlocking {
        instrumentation.uiAutomation.executeShellCommand("cmd media_session volume --stream 3 --set 0").close()
        val auth = Api(server, "artist-tv-test").login("Wika", "wicaby")
        val api = Api(server, "artist-tv-test", auth.accessToken, auth.user.id)
        Core.api = api
        val nora = api.albumArtists("SortBy" to "SortName").items.first { it.name == "Nora Vale" }
        val stack = stack(api, Route.MusicArtist(nora.id, nora.name))

        focused("music-artist-play")
        // Her two albums have 3 tracks or fewer (singles & EPs, as desktop); the compilation she is on is "appears on".
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("music-artist-singles").assertExists() }.isSuccess }
        rule.onNodeWithTag("music-artist-appears").assertExists()
        press(Key.DirectionDown)
        press(Key.Enter)
        rule.waitUntil(10_000) { stack.last() is Route.MusicAlbum }
        focused("music-album-play")
        press(Key.Enter)
        rule.waitUntil(30_000) {
            var playing = false
            instrumentation.runOnMainSync { playing = Music.session?.player?.isPlaying == true }
            playing
        }
        // The system's Back (on this emulator): now playing closes over the album page, then the artist page again.
        repeat(2) {
            instrumentation.uiAutomation.executeShellCommand("input keyevent KEYCODE_BACK").close()
            Thread.sleep(1_500)
        }
        rule.waitUntil(10_000) { stack.last() is Route.MusicArtist }
        assertEquals(1, stack.size)
        focused("music-artist-play")
        assertTrue(Music.active)
    }
}
