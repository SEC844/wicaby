package com.wika.wicaby.tv.ui.photos

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.snapshots.SnapshotStateList
import com.wika.wicaby.core.data.ItemsResult
import com.wika.wicaby.core.photos.PhotoSource
import com.wika.wicaby.core.photos.TimelineState
import com.wika.wicaby.tv.LocalApi
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.Nav
import com.wika.wicaby.tv.Route
import com.wika.wicaby.tv.ui.Cache
import com.wika.wicaby.tv.ui.Idle
import kotlinx.coroutines.runBlocking
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.photos.Photo
import com.wika.wicaby.core.photos.toAsset
import com.wika.wicaby.tv.ui.Accents
import com.wika.wicaby.tv.ui.WicabyTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper
import java.util.concurrent.TimeUnit

// Photos spec PH-06 AC1/AC2 with D-pad key events: along a row, down a row, Page down to the next month (its label
// shows), OK opens; in the viewer Right shows the next asset, Up the info panel with the camera line, Play/Pause runs
// the slideshow (next within interval + 1 s) and keeps the in-app screensaver away, Back closes and returns to the
// tile, focused; holding Down jumps a month; an empty album offers Back. Images do not load here (port 9 refuses).
// The emulator run against the mock is tv/src/androidTest/.../PhotosTvDeviceTest.kt.
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "en-w960dp-h540dp-land-mdpi")
class PhotosTvTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val api = Api(Server("s1", "Test", "http://127.0.0.1:9", "jellyfin"), "dev", "tok", "u1")

    // 3 months × 14 stills, newest first.
    private val photos = (0 until 42).map { i ->
        val month = 3 - i / 14
        val day = (28 - i % 14).toString().padStart(2, '0')
        val item = Item(
            id = "p$i", type = "Photo", premiereDate = "2024-0$month-${day}T12:00:00", dateCreated = "2024-0$month-${day}T11:00:00.0000000Z",
            width = 6000, height = 4000, imageTags = mapOf("Primary" to "t$i"), cameraMake = "Wicaby Test", cameraModel = "Model A", exposureTime = 0.004,
        )
        Photo(toAsset(item, 0), item)
    }

    // The effect's delay runs on the main looper (Robolectric time), the animations on the Compose clock: both move.
    private fun idle(ms: Long) {
        ShadowLooper.idleMainLooper(ms, TimeUnit.MILLISECONDS)
        rule.mainClock.advanceTimeBy(ms)
        rule.waitForIdle()
    }

    private fun press(key: Key) {
        rule.onRoot().performKeyInput { pressKey(key) }
        rule.waitForIdle()
    }

    @Test
    fun dpadMovesByTileRowAndMonth() {
        var opened = -1
        rule.setContent {
            WicabyTheme(Accents[0]) { PhotoGrid(api, photos, top = 24.dp, header = { Text("Photos") }) { opened = it } }
        }
        rule.mainClock.advanceTimeBy(200)
        rule.onNodeWithTag("tile-p0").assertIsFocused()
        repeat(5) { press(Key.DirectionRight) }
        rule.onNodeWithTag("tile-p5").assertIsFocused()
        press(Key.DirectionDown)
        rule.onNodeWithTag("tile-p11").assertIsFocused()
        press(Key.PageDown)
        rule.mainClock.advanceTimeBy(200)
        rule.onNodeWithTag("tile-p14").assertIsFocused()
        rule.onNodeWithTag("month-label").assertTextEquals("February 2024")
        press(Key.DirectionCenter)
        assertEquals(14, opened)
    }

    @Test
    fun viewerKeysAndSlideshow() {
        var closed = false
        rule.setContent {
            WicabyTheme(Accents[0]) { PhotoViewer(api, photos, 0, onClose = { closed = true }, seconds = 3, kenBurns = false) }
        }
        rule.mainClock.advanceTimeBy(100)
        press(Key.DirectionRight)
        rule.mainClock.advanceTimeBy(1_000)
        rule.onNodeWithTag("photo-p1").assertExists()
        rule.onNodeWithTag("photo-p0").assertDoesNotExist()
        press(Key.DirectionUp)
        rule.mainClock.advanceTimeBy(1_000)
        rule.onNodeWithTag("photo-info").assertExists()
        rule.onNodeWithText("Wicaby Test Model A").assertExists()
        press(Key.DirectionDown)
        rule.mainClock.advanceTimeBy(1_000)
        rule.onNodeWithTag("photo-info").assertDoesNotExist()
        // Play/Pause: the next still within the interval (3 s) + 1 s.
        press(Key.MediaPlayPause)
        rule.onNodeWithText("27 March 2024").assertExists()
        val poked = Idle.last
        idle(4_000)
        rule.onNodeWithTag("photo-p2").assertExists()
        // Spec F11: each slide counts as activity, so the in-app screensaver never covers a running slideshow.
        assertTrue(Idle.last > poked)
        // Back stops the slideshow, then closes the viewer.
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        rule.onNodeWithText("26 March 2024").assertDoesNotExist()
        idle(5_000)
        rule.onNodeWithTag("photo-p2").assertExists()
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        assertTrue(closed)
    }

    private fun loaded(key: String, list: List<Photo>) {
        val t = TimelineState()
        runBlocking { t.load(PhotoSource({ _, _ -> ItemsResult(list.map { it.item }, list.size) })) }
        Cache.map[key] = t
    }

    // The app's own stack (MainActivity): a Nav over routes, each route's state kept by a SaveableStateHolder.
    private fun stack(vararg routes: Route): SnapshotStateList<Route> {
        val stack = mutableStateListOf(*routes)
        rule.setContent {
            val holder = rememberSaveableStateHolder()
            val nav = remember { Nav(stack) { holder.removeState(it.toString()) } }
            CompositionLocalProvider(LocalNav provides nav, LocalApi provides api) {
                WicabyTheme(Accents[0]) {
                    BackHandler(stack.size > 1) { nav.pop() }
                    val route = stack.last()
                    holder.SaveableStateProvider(route.toString()) {
                        when (route) {
                            // PhotoViewerScreen with the slideshow settings given (TvSettings needs the app: the device test runs it).
                            is Route.PhotoView -> PhotoViewer(api, (Cache.map[route.key] as TimelineState).photos, route.index, onClose = nav::pop, seconds = 3, kenBurns = false)
                            is Route.PhotoAlbum -> PhotoAlbumScreen(api, route.id, route.name)
                            else -> PhotosTab(api, "lib", "Photos", 24.dp)
                        }
                    }
                }
            }
        }
        return stack
    }

    private fun back() {
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        rule.mainClock.advanceTimeBy(300)
    }

    // PH-06 AC2: Back from the viewer comes back to the tile it was opened from, focused.
    @Test
    fun backReturnsToTheSameFocusedTile() {
        loaded("photos-lib-false", photos)
        val stack = stack(Route.Main)
        rule.mainClock.advanceTimeBy(200)
        rule.onNodeWithTag("tile-p0").assertIsFocused()
        repeat(3) { press(Key.DirectionRight) }
        press(Key.DirectionDown)
        rule.onNodeWithTag("tile-p9").assertIsFocused()
        press(Key.DirectionCenter)
        rule.mainClock.advanceTimeBy(300)
        assertEquals(Route.PhotoView("photos-lib-false", 9), stack.last())
        rule.onNodeWithTag("photo-p9").assertExists()
        press(Key.DirectionRight)
        rule.mainClock.advanceTimeBy(500)
        rule.onNodeWithTag("photo-p10").assertExists()
        back()
        assertEquals(1, stack.size)
        rule.onNodeWithTag("tile-p9").assertIsFocused()
    }

    // Spec §4.4: holding Down jumps one month (the D-pad scrubber), however long it is held.
    @Test
    fun holdingDownJumpsAMonth() {
        rule.setContent {
            WicabyTheme(Accents[0]) { PhotoGrid(api, photos, top = 24.dp, header = { Text("Photos") }) {} }
        }
        rule.mainClock.advanceTimeBy(200)
        rule.onNodeWithTag("tile-p0").assertIsFocused()
        rule.onRoot().performKeyInput {
            keyDown(Key.DirectionDown)
            advanceEventTime(1_200)
            keyUp(Key.DirectionDown)
        }
        rule.waitForIdle()
        rule.mainClock.advanceTimeBy(200)
        rule.onNodeWithTag("tile-p14").assertIsFocused()
        rule.onNodeWithTag("month-label").assertTextEquals("February 2024")
    }

    // Spec §4.4 tabs: OK on a tab pill keeps the focus on that pill in the new tab (the pills stay outside the switched
    // content; PhotosTabFocusTest runs them under the top bar). Albums fail to load here (port 9): the header stays.
    @Test
    fun tabPillsKeepTheFocus() {
        loaded("photos-lib-false", photos)
        loaded("photos-lib-true", photos.take(5))
        stack(Route.Main)
        idle(200)
        rule.onNodeWithTag("tile-p0").assertIsFocused()
        rule.onNodeWithTag("photos-tab-1").requestFocus()
        press(Key.DirectionCenter)
        idle(200)
        rule.onNodeWithTag("photos-tab-1").assertIsFocused()
        press(Key.DirectionRight)
        press(Key.DirectionCenter)
        idle(200)
        rule.onNodeWithTag("photos-tab-2").assertIsFocused()
        rule.onNodeWithTag("tile-p4").assertExists()
        rule.onNodeWithTag("tile-p5").assertDoesNotExist()
        press(Key.DirectionLeft)
        press(Key.DirectionLeft)
        press(Key.DirectionCenter)
        idle(200)
        rule.onNodeWithTag("photos-tab-0").assertIsFocused()
        rule.onNodeWithTag("tile-p5").assertExists()
    }

    // An empty album still has something to focus, which goes back.
    @Test
    fun anEmptyAlbumOffersBack() {
        loaded("photos-empty-false", emptyList())
        val stack = stack(Route.Main, Route.PhotoAlbum("empty", "Album"))
        rule.mainClock.advanceTimeBy(200)
        rule.onNodeWithTag("photos-back").assertIsFocused()
        press(Key.DirectionCenter)
        assertEquals(1, stack.size)
    }
}
