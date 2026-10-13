package com.wika.wicaby.tv.ui.photos

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.ItemsResult
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.photos.Photo
import com.wika.wicaby.core.photos.PhotoSource
import com.wika.wicaby.core.photos.TimelineState
import com.wika.wicaby.core.photos.toAsset
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.Nav
import com.wika.wicaby.tv.Route
import com.wika.wicaby.tv.ui.Accents
import com.wika.wicaby.tv.ui.Cache
import com.wika.wicaby.tv.ui.LocalAutoFocus
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.TopBar
import com.wika.wicaby.tv.ui.TopTab
import com.wika.wicaby.tv.ui.WicabyTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper
import java.util.concurrent.TimeUnit

// The photo tabs inside MainScreen's frame (the real TopBar over a content box with the same focus rules): OK on each
// tab pill keeps the focus on the photo screen and switches the tab, whether the new tab is ready, loading or failed;
// focus never falls back to the bar, whose first tab (Home) would take over the screen.
@OptIn(ExperimentalTestApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "en-w960dp-h540dp-land-mdpi")
class PhotosTabFocusTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val api = Api(Server("s1", "Test", "http://127.0.0.1:9", "jellyfin"), "dev", "tok", "u1")
    private var selected by mutableStateOf("lib")

    private val photos = (0 until 12).map { i ->
        val item = Item(id = "p$i", type = "Photo", premiereDate = "2024-03-${(20 - i).toString().padStart(2, '0')}T12:00:00", width = 6000, height = 4000, imageTags = mapOf("Primary" to "t$i"))
        Photo(toAsset(item, 0), item)
    }

    @Before
    fun clear() = Cache.map.clear()

    private fun idle(ms: Long) {
        ShadowLooper.idleMainLooper(ms, TimeUnit.MILLISECONDS)
        rule.mainClock.advanceTimeBy(ms)
        rule.waitForIdle()
    }

    private fun press(key: Key) {
        rule.onRoot().performKeyInput { pressKey(key) }
        rule.waitForIdle()
    }

    private fun loaded(key: String, list: List<Photo>) {
        val t = TimelineState()
        runBlocking { t.load(PhotoSource({ _, _ -> ItemsResult(list.map { it.item }, list.size) })) }
        Cache.map[key] = t
    }

    // MainScreen (Main.kt) reduced to its focus structure, its content box's rules copied: Home and a photo library.
    private fun frame() {
        rule.setContent {
            val nav = remember { Nav(mutableStateListOf<Route>(Route.Main)) {} }
            CompositionLocalProvider(LocalNav provides nav) { WicabyTheme(Accents[0]) {
                val tabs = listOf(TopTab("home", "Home"), TopTab("lib", "Photos"))
                val requesters = remember { tabs.associate { it.key to FocusRequester() } }
                val content = remember { FocusRequester() }
                var barFocused by remember { mutableStateOf(false) }
                Box(Modifier.fillMaxSize()) {
                    Box(
                        Modifier.fillMaxSize()
                            .focusProperties {
                                @Suppress("DEPRECATION")
                                exit = { dir -> if (dir == FocusDirection.Up) requesters[selected] ?: FocusRequester.Default else FocusRequester.Default }
                            }
                            .focusRequester(content).focusRestorer().focusGroup(),
                    ) {
                        CompositionLocalProvider(LocalAutoFocus provides !barFocused) {
                            if (selected == "home") Pill("Home content", onClick = {}, modifier = Modifier.testTag("home-content"))
                            else PhotosTab(api, "lib", "Photos", 104.dp)
                        }
                    }
                    TopBar(
                        tabs, selected, requesters, content, remember { FocusRequester() }, barFocused, visible = true, showClock = false,
                        user = null, api = api, userName = "U", onSelect = { selected = it }, onFocus = { barFocused = it },
                        onAvatar = {}, modifier = Modifier.align(Alignment.TopCenter),
                    )
                }
            } }
        }
        idle(300)
    }

    private fun ok(pill: Int) {
        rule.onNodeWithTag("photos-tab-$pill").requestFocus()
        press(Key.DirectionCenter)
        idle(400)
        assertEquals("lib", selected)
        rule.onNodeWithTag("photos-tab-$pill").assertIsFocused()
    }

    @Test
    fun okOnEachPillKeepsTheFocusOnThePhotoScreen() {
        loaded("photos-lib-false", photos)
        loaded("photos-lib-true", photos.take(3))
        Cache.map["photo-albums-lib"] = listOf(Item(id = "a1", name = "Album", type = "PhotoAlbum", childCount = 3))
        frame()
        rule.onNodeWithTag("tile-p0").assertIsFocused()
        ok(1)
        rule.onNodeWithText("Album").assertExists()
        rule.onNodeWithTag("tile-p0").assertDoesNotExist()
        ok(2)
        rule.onNodeWithTag("tile-p2").assertExists()
        rule.onNodeWithTag("tile-p3").assertDoesNotExist()
        ok(0)
        rule.onNodeWithTag("tile-p3").assertExists()
    }

    // Nothing cached: the albums and the favourites load (and fail here, port 9); the pill keeps the focus throughout.
    @Test
    fun okWhileTheNewTabLoadsKeepsTheFocus() {
        loaded("photos-lib-false", photos)
        frame()
        ok(1)
        ok(2)
        ok(0)
    }

    // Up from a pill goes to the library's own tab in the bar, not to Home, also after a visit to Home.
    @Test
    fun upFromAPillReachesTheLibraryTab() {
        loaded("photos-lib-false", photos)
        frame()
        rule.onNodeWithTag("photos-tab-1").requestFocus()
        press(Key.DirectionUp)
        idle(300)
        assertEquals("lib", selected)
        press(Key.DirectionLeft)
        idle(300)
        assertEquals("home", selected)
        press(Key.DirectionRight)
        idle(300)
        press(Key.DirectionDown)
        idle(300)
        rule.onNodeWithTag("photos-tab-0").assertIsFocused()
        press(Key.DirectionUp)
        idle(300)
        assertEquals("lib", selected)
    }
}
