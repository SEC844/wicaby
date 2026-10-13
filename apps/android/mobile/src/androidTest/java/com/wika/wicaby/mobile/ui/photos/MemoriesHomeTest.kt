package com.wika.wicaby.mobile.ui.photos

import android.graphics.Bitmap
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasScrollToKeyAction
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.hasParent
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.performScrollToKey
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.mobile.MainActivity
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

// Photos spec PH-08 AC1 on the Android phone emulator, the real app against mock-emby on the host (10.0.2.2): signed in,
// the home screen shows "Ce jour-là" with 1, 3 and 7 years ago, in that order. A screenshot of the app lands in the
// app's external files folder (memories-mobile.png) for the reviewer. Run by hand: see tools/checks/photos-android-check.mjs.
@RunWith(AndroidJUnit4::class)
class MemoriesHomeTest {
    @get:Rule val rule = createEmptyComposeRule()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val base = InstrumentationRegistry.getArguments().getString("mock") ?: "http://10.0.2.2:8981"

    @Test
    fun homeShowsOnThisDayNearestYearFirst() {
        val ctx = instrumentation.targetContext
        val server = Server("a1b2c3d4e5f60718293a4b5c6d7e8f90", "Wicaby Mock Emby", base, "emby")
        runBlocking {
            val auth = Api(server, "memories-mobile-test").login("Wika", "wicaby")
            Core.prefs.setServer(server)
            Core.prefs.setSession(auth.user.id, auth.user.name, auth.accessToken)
            Core.prefs.setOnboarded(true)
        }
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
            // A phone shows a card and a half: card i of the row is years[i], nearest year first.
            // The row: the list inside MemoriesRow (testTag "memories").
            val row = rule.onNode(hasScrollToIndexAction() and hasParent(hasTestTag("memories")))
            years.forEachIndexed { i, label ->
                row.performScrollToIndex(i)
                rule.waitUntil(5_000) { rule.onAllNodesWithText(label).fetchSemanticsNodes().isNotEmpty() }
            }
            row.performScrollToIndex(0)
            rule.waitUntil(5_000) { rule.onAllNodesWithText(years[0]).fetchSemanticsNodes().isNotEmpty() }
            assertTrue(rule.onAllNodesWithText(ctx.getString(CoreR.string.photos_memories_title)).fetchSemanticsNodes().isNotEmpty())
            Thread.sleep(2_500) // the covers load
            val shot = instrumentation.uiAutomation.takeScreenshot()
            File(ctx.getExternalFilesDir(null), "memories-mobile.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
            // A card opens that year’s photos in the viewer (PH-08 entry point).
            rule.onAllNodesWithText(years[0])[0].performClick()
            rule.waitUntil(10_000) { rule.onAllNodesWithTag("photo-viewer").fetchSemanticsNodes().isNotEmpty() }
            Thread.sleep(2_000)
            val viewer = instrumentation.uiAutomation.takeScreenshot()
            File(ctx.getExternalFilesDir(null), "memories-mobile-viewer.png").outputStream().use { viewer.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }
}
