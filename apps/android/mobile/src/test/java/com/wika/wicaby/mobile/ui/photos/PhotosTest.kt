package com.wika.wicaby.mobile.ui.photos

import android.app.Application
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.navigation.compose.rememberNavController
import com.wika.wicaby.core.data.ItemsResult
import com.wika.wicaby.core.photos.PhotoSource
import com.wika.wicaby.core.photos.TimelineState
import com.wika.wicaby.mobile.ui.Cache
import com.wika.wicaby.mobile.ui.GridRoute
import kotlinx.coroutines.runBlocking
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pinch
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.photos.Photo
import com.wika.wicaby.core.photos.toAsset
import com.wika.wicaby.mobile.ui.Accents
import com.wika.wicaby.mobile.ui.WicabyTheme
import com.wika.wicaby.mobile.ui.ZoomScale
import com.wika.wicaby.mobile.ui.ZoomState
import com.wika.wicaby.mobile.ui.zoomable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Photos spec PH-05 AC2/AC3 under Robolectric: month headers, the pinch between densities keeping the anchor in view,
// tap to open, swipe to the next asset, double-tap zoom, swipe down to close, and the comic reader's shared zoom; the
// long-press selection and the fast scroller. The emulator run against the mock is androidTest/PhotosTest.kt.
// Images do not load here (port 9 refuses): the tiles and pages are laid out from the server's sizes alone.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "en-w411dp-h891dp-xxhdpi")
class PhotosTest {
    @get:Rule val rule = createComposeRule()

    private val api = Api(Server("s1", "Test", "http://127.0.0.1:9", "jellyfin"), "dev", "tok", "u1")

    // 3 months × 12 photos, newest first, mixed shapes.
    private val photos = (0 until 36).map { i ->
        val month = 3 - i / 12
        val day = 28 - i % 12
        val (w, h) = listOf(6000 to 4000, 3000 to 4000, 4000 to 3000, 4000 to 4000)[i % 4]
        val item = Item(id = "p$i", type = "Photo", premiereDate = "2024-0$month-${day}T12:00:00", dateCreated = "2024-0$month-${day}T11:00:00.0000000Z", width = w, height = h, imageTags = mapOf("Primary" to "t$i"))
        Photo(toAsset(item, 0), item)
    }

    @Test
    fun gridShowsMonthsPinchesAndOpens() {
        var density by mutableIntStateOf(1)
        var opened = -1
        rule.setContent {
            WicabyTheme(Accents[0]) {
                PhotoGrid(api, photos, density, { density = it }, onOpen = { opened = it }, modifier = Modifier.fillMaxSize())
            }
        }
        rule.onNodeWithText("March 2024").assertIsDisplayed()
        rule.onNodeWithTag("photo-p0").assertIsDisplayed()
        // Spread two fingers well past ×1.25: the next (larger) row height, the anchor still on screen.
        rule.onNodeWithTag("photo-grid").performTouchInput {
            pinch(center - Offset(40f, 0f), center - Offset(400f, 0f), center + Offset(40f, 0f), center + Offset(400f, 0f))
        }
        rule.waitForIdle()
        assertEquals(2, density)
        rule.onNodeWithTag("photo-p0").assertIsDisplayed()
        // And back in, twice: the square month overview.
        repeat(2) {
            rule.onNodeWithTag("photo-grid").performTouchInput {
                pinch(center - Offset(400f, 0f), center - Offset(40f, 0f), center + Offset(400f, 0f), center + Offset(40f, 0f))
            }
            rule.waitForIdle()
        }
        assertEquals(0, density)
        rule.onNodeWithTag("photo-p1").performClick()
        assertEquals(1, opened)
    }

    @Test
    fun viewerSwipesZoomsAndCloses() {
        var closed = false
        rule.setContent {
            WicabyTheme(Accents[0]) { PhotoViewer(api, photos, 0, onClose = { closed = true }) }
        }
        rule.onNodeWithTag("photo-page-p0").assertIsDisplayed()
        rule.onNodeWithTag("photo-viewer").performTouchInput { swipeLeft() }
        rule.waitForIdle()
        rule.onNodeWithTag("photo-page-p1").assertIsDisplayed()
        val zoom = rule.onNodeWithTag("photo-zoom-p1")
        zoom.performTouchInput { doubleClick(center) }
        rule.waitForIdle()
        assertTrue(zoom.fetchSemanticsNode().config[ZoomScale] > 1f)
        // Zoomed: a swipe pans instead of turning the page.
        rule.onNodeWithTag("photo-viewer").performTouchInput { swipeLeft() }
        rule.waitForIdle()
        rule.onNodeWithTag("photo-page-p1").assertIsDisplayed()
        zoom.performTouchInput { doubleClick(center) }
        rule.waitForIdle()
        assertEquals(1f, zoom.fetchSemanticsNode().config[ZoomScale])
        // Up opens the info panel, down closes the viewer.
        rule.onNodeWithTag("photo-viewer").performTouchInput { swipeUp() }
        rule.waitForIdle()
        rule.onNodeWithTag("photo-info").assertExists()
        rule.onNodeWithTag("photo-info-scrim").performClick()
        rule.waitForIdle()
        rule.onNodeWithTag("photo-info").assertDoesNotExist()
        rule.onNodeWithTag("photo-viewer").performTouchInput { swipeDown() }
        rule.waitForIdle()
        assertTrue(closed)
    }

    // The comic reader's pages use the same modifier (PH-05 AC3): pinch and double tap zoom, one finger alone does not.
    @Test
    fun sharedZoomPinchesAndDoubleTaps() {
        val state = ZoomState()
        rule.setContent {
            Box(Modifier.size(300.dp).testTag("zoom").zoomable(state, 600f, 900f).background(Color.Gray))
        }
        rule.onNodeWithTag("zoom").performTouchInput { swipeLeft() }
        assertEquals(1f, state.scale)
        rule.onNodeWithTag("zoom").performTouchInput { pinch(center - Offset(20f, 0f), center - Offset(200f, 0f), center + Offset(20f, 0f), center + Offset(200f, 0f)) }
        rule.waitForIdle()
        assertTrue(state.scale > 1.5f)
        rule.onNodeWithTag("zoom").performTouchInput { doubleClick(center) }
        rule.waitForIdle()
        assertEquals(1f, state.scale)
        rule.onNodeWithTag("zoom").performTouchInput { doubleClick(center) }
        rule.waitForIdle()
        assertEquals(2.5f, state.scale)
    }

    // Spec §4.3: a long press selects; taps then toggle; the bar offers Favourite and Slideshow from here.
    @Test
    fun longPressSelectsThenSlideshowFromHere() {
        val t = TimelineState()
        runBlocking { t.load(PhotoSource({ _, _ -> ItemsResult(photos.map { it.item }, photos.size) })) }
        Cache.map["photos-s1-lib-false"] = t
        rule.setContent {
            WicabyTheme(Accents[0]) { PhotosScreen(api, GridRoute("Photos", parentId = "lib", collectionType = "photos"), rememberNavController()) }
        }
        rule.onNodeWithTag("photo-p2").performTouchInput { longClick() }
        rule.onNodeWithText("1 selected").assertIsDisplayed()
        rule.onNodeWithTag("photo-p2").assertIsSelected()
        rule.onNodeWithTag("photo-p1").performClick()
        rule.onNodeWithText("2 selected").assertIsDisplayed()
        rule.onNodeWithTag("photo-p2").performClick()
        rule.onNodeWithText("1 selected").assertIsDisplayed()
        rule.onNodeWithTag("photo-viewer").assertDoesNotExist()
        rule.onNodeWithContentDescription("Slideshow from Here").performClick()
        rule.onNodeWithTag("photo-slideshow").assertExists()
        rule.onNodeWithTag("photo-selection").assertDoesNotExist()
    }

    // Spec §4.3 fast scroller: shown once the list moves; dragging it to the bottom reaches the last month, named in
    // the bubble meanwhile.
    @Test
    fun fastScrollerJumpsByMonth() {
        rule.setContent {
            WicabyTheme(Accents[0]) { PhotoGrid(api, photos, 1, {}, onOpen = {}, modifier = Modifier.fillMaxSize()) }
        }
        rule.onNodeWithTag("photo-scroller").assertDoesNotExist()
        rule.onNodeWithTag("photo-grid").performTouchInput { swipeUp(startY = bottom - 10f, endY = bottom - 300f) }
        rule.onNodeWithTag("photo-scroller").assertExists().performTouchInput {
            down(Offset(centerX, 20f))
            moveTo(Offset(centerX, bottom / 2))
            moveTo(Offset(centerX, bottom - 1f))
        }
        rule.onNodeWithTag("photo-scroller-month").assertTextEquals("January 2024")
        rule.onNodeWithTag("photo-scroller").performTouchInput { up() }
        rule.onNodeWithText("January 2024").assertIsDisplayed()
        rule.onNodeWithTag("photo-p35").assertIsDisplayed()
    }
}
