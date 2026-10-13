package com.wika.wicaby.mobile.ui.photos

import android.os.Bundle
import android.os.ParcelFileDescriptor
import androidx.activity.ComponentActivity
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pinch
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeUp
import androidx.navigation.compose.rememberNavController
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import coil3.SingletonImageLoader
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.photos.TimelineState
import com.wika.wicaby.mobile.ui.Accents
import com.wika.wicaby.mobile.ui.Cache
import com.wika.wicaby.mobile.ui.GridRoute
import com.wika.wicaby.mobile.ui.WicabyTheme
import com.wika.wicaby.mobile.ui.ZoomScale
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

// Photos spec PH-05 AC2 and AC4 on an emulator, against mock-emby on the host (10.0.2.2), real images and all:
// the library opens through PhotosScreen and PhotoSource; a pinch past ×1.25 moves to the next row height with the
// anchor still in view; a tap opens the viewer, a swipe turns the page, a double tap zooms, a swipe down closes. Then
// the memory budget: paging 50 photos in the viewer costs under 120 MB over the grid (dumpsys meminfo, emulator only).
// Run by tools/checks/photos-android-check.mjs (instrumentation argument "mock": the mock's address).
@RunWith(AndroidJUnit4::class)
class PhotosTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val base = InstrumentationRegistry.getArguments().getString("mock") ?: "http://10.0.2.2:8981"
    private lateinit var api: Api

    @Before
    fun signIn(): Unit = runBlocking {
        val server = Server("mock", "Mock", base, "emby")
        val auth = Api(server, "photos-test").login("Wika", "wicaby")
        api = Api(server, "photos-test", auth.accessToken, auth.user.id)
        Cache.map.clear()
        SingletonImageLoader.get(instrumentation.targetContext).run { memoryCache?.clear(); diskCache?.clear() }
    }

    private fun open() {
        rule.setContent {
            WicabyTheme(Accents[0]) {
                PhotosScreen(api, GridRoute("Photos de famille", parentId = "lib-photos", collectionType = "homevideos"), rememberNavController())
            }
        }
        rule.waitUntil(30_000) { (Cache.map["photos-mock-lib-photos-false"] as? TimelineState)?.complete == true }
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("photo-month").fetchSemanticsNodes().isNotEmpty() }
    }

    private val timeline get() = (Cache.map.getValue("photos-mock-lib-photos-false") as TimelineState).photos

    // Grid tiles: "photo-<id>" with the date as their description.
    private val tile = SemanticsMatcher("photo tile") { n ->
        n.config.getOrNull(SemanticsProperties.TestTag)?.startsWith("photo-") == true && n.config.getOrNull(SemanticsProperties.ContentDescription) != null
    }

    private fun visibleTiles() = rule.onAllNodes(tile).fetchSemanticsNodes()
        .filter { it.boundsInRoot.top >= 0f && it.boundsInRoot.bottom <= rule.onNodeWithTag("photo-grid").fetchSemanticsNode().boundsInRoot.bottom }

    @Test
    fun libraryOpensPinchesAndViews() {
        open()
        rule.onAllNodesWithTag("photo-month")[0].assertIsDisplayed()
        // Away from the top, so the anchor is a row in the middle of the timeline.
        rule.onNodeWithTag("photo-grid").performTouchInput { swipeUp(startY = bottom * 0.8f, endY = bottom * 0.4f) }
        rule.waitForIdle()
        val before = visibleTiles().minBy { it.boundsInRoot.top }
        val anchor = before.config[SemanticsProperties.TestTag]
        val h0 = before.boundsInRoot.height
        rule.onNodeWithTag("photo-grid").performTouchInput {
            pinch(center - Offset(40f, 0f), center - Offset(400f, 0f), center + Offset(40f, 0f), center + Offset(400f, 0f))
        }
        rule.waitForIdle()
        val after = rule.onNodeWithTag(anchor).assertIsDisplayed().fetchSemanticsNode()
        // 140 dp rows to 220 dp rows.
        assertTrue("row height $h0 -> ${after.boundsInRoot.height}", after.boundsInRoot.height > h0 * 1.4f)

        val id = anchor.removePrefix("photo-")
        val i = timeline.indexOfFirst { it.asset.id == id }
        rule.onNodeWithTag(anchor).performClick()
        rule.waitForIdle()
        rule.onNodeWithTag("photo-page-$id").assertIsDisplayed()
        rule.onNodeWithTag("photo-viewer").performTouchInput { swipeLeft() }
        rule.waitForIdle()
        val next = timeline[i + 1].asset.id
        rule.onNodeWithTag("photo-page-$next").assertIsDisplayed()
        val zoom = rule.onNodeWithTag("photo-zoom-$next")
        zoom.performTouchInput { doubleClick(center) }
        rule.waitForIdle()
        assertTrue(zoom.fetchSemanticsNode().config[ZoomScale] > 1f)
        zoom.performTouchInput { doubleClick(center) }
        rule.waitForIdle()
        assertEquals(1f, zoom.fetchSemanticsNode().config[ZoomScale])
        rule.onNodeWithTag("photo-viewer").performTouchInput { swipeDown() }
        rule.waitForIdle()
        rule.onNodeWithTag("photo-viewer").assertDoesNotExist()
    }

    // Real time for the network and the decoder, with the Compose test clock pumped so the results reach the screen.
    private fun settle(ms: Long) {
        repeat((ms / 100).toInt()) {
            Thread.sleep(100)
            rule.waitForIdle()
        }
    }

    // Total PSS in KB, after a collection, as `adb shell dumpsys meminfo <package>` reports it.
    private fun pssKb(): Long {
        Runtime.getRuntime().gc()
        Thread.sleep(500)
        val fd = instrumentation.uiAutomation.executeShellCommand("dumpsys meminfo ${instrumentation.targetContext.packageName}")
        val out = ParcelFileDescriptor.AutoCloseInputStream(fd).bufferedReader().use { it.readText() }
        val kb = Regex("""TOTAL PSS:\s+(\d+)""").find(out) ?: Regex("""(?m)^\s*TOTAL\s+(\d+)""").find(out)
        return kb!!.groupValues[1].toLong()
    }

    @Test
    fun fiftyPagesStayInTheMemoryBudget() {
        open()
        settle(3_000) // the visible thumbnails arrive and decode
        val grid = pssKb()
        rule.onNodeWithTag("photo-${timeline[0].asset.id}").performClick()
        rule.waitForIdle()
        repeat(50) {
            rule.onNodeWithTag("photo-viewer").performTouchInput { swipeLeft() }
            rule.waitForIdle()
            settle(300) // the page's image arrives and decodes
        }
        rule.onNodeWithTag("photo-page-${timeline[50].asset.id}").assertIsDisplayed()
        settle(2_000)
        val viewer = pssKb()
        val deltaMb = (viewer - grid) / 1024
        instrumentation.sendStatus(0, Bundle().apply { putString("photos-memory", "grid=${grid / 1024} MB viewer=${viewer / 1024} MB delta=$deltaMb MB") })
        assertTrue("viewer after 50 pages: +$deltaMb MB over the grid (budget 120 MB)", deltaMb < 120)
    }
}
