package com.wika.wicaby.tv.ui.photos

import android.graphics.Bitmap
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasScrollToKeyAction
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performScrollToKey
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.tv.MainActivity
import com.wika.wicaby.tv.data.TvSettings
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

// Photos spec PH-08 AC1 on the Android TV emulator, the real app against mock-emby on the host (10.0.2.2): signed in,
// the home screen shows "Ce jour-là" with 1, 3 and 7 years ago, in that order. A screenshot of the app lands in the
// app's external files folder (memories-tv.png) for the reviewer. Run by hand: see tools/checks/photos-android-check.mjs.
@RunWith(AndroidJUnit4::class)
class MemoriesHomeDeviceTest {
    @get:Rule val rule = createEmptyComposeRule()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val base = InstrumentationRegistry.getArguments().getString("mock") ?: "http://10.0.2.2:8981"

    @Test
    fun homeShowsOnThisDayNearestYearFirst() {
        val ctx = instrumentation.targetContext
        val server = Server("a1b2c3d4e5f60718293a4b5c6d7e8f90", "Wicaby Mock Emby", base, "emby")
        runBlocking {
            val auth = Api(server, "memories-tv-test").login("Wika", "wicaby")
            Core.prefs.setServer(server)
            Core.prefs.setSession(auth.user.id, auth.user.name, auth.accessToken)
            Core.prefs.setOnboarded(true)
            Core.prefs.setSkipPicker(true)
        }
        // A first sign-in on a fresh emulator asks the system to add a launcher channel: that dialog takes the focus and
        // the home never shows. The channels are not under test here.
        instrumentation.runOnMainSync { TvSettings.homeChannels.value = false }
        val years = listOf(1, 3, 7).map { ctx.resources.getQuantityString(CoreR.plurals.photos_memories_years_ago, it, it) }
        ActivityScenario.launch(MainActivity::class.java).use {
            // The row sits below the libraries' rows: scroll the home list to it (the first list that knows the key).
            // (No Compose tree until the activity has set its content: the first rounds may throw.)
            rule.waitUntil(60_000) {
                runCatching {
                    rule.onAllNodes(hasScrollToKeyAction()).fetchSemanticsNodes().indices.any { i ->
                        runCatching { rule.onAllNodes(hasScrollToKeyAction())[i].performScrollToKey("memories") }.isSuccess
                    } && rule.onAllNodesWithText(years[0]).fetchSemanticsNodes().isNotEmpty()
                }.getOrDefault(false)
            }
            rule.waitUntil(10_000) { years.all { rule.onAllNodesWithText(it).fetchSemanticsNodes().isNotEmpty() } }
            val left = years.map { rule.onAllNodesWithText(it).fetchSemanticsNodes().first().boundsInRoot.left }
            assertTrue("nearest year first: $left", left == left.sorted())
            assertTrue(rule.onAllNodesWithText(ctx.getString(CoreR.string.photos_memories_title)).fetchSemanticsNodes().isNotEmpty())
            Thread.sleep(2_500) // the covers load
            val shot = instrumentation.uiAutomation.takeScreenshot()
            File(ctx.getExternalFilesDir(null), "memories-tv.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
            // A card opens that year’s photos in the viewer (PH-08 entry point).
            val b = rule.onAllNodesWithText(years[0]).fetchSemanticsNodes().first().boundsInRoot
            rule.onAllNodes(isRoot())[0].performTouchInput { click(Offset(b.left + 40f, b.top - 80f)) }
            rule.waitUntil(10_000) { rule.onAllNodesWithTag("photo-viewer").fetchSemanticsNodes().isNotEmpty() }
            Thread.sleep(2_000)
            val viewer = instrumentation.uiAutomation.takeScreenshot()
            File(ctx.getExternalFilesDir(null), "memories-tv-viewer.png").outputStream().use { viewer.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
}
