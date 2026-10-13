package com.wika.wicaby.tv.ui.photos

import android.graphics.Color as AColor
import android.os.Bundle
import android.os.ParcelFileDescriptor
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.tween
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import coil3.SingletonImageLoader
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.livetv.DeviceClass
import com.wika.wicaby.core.livetv.DeviceClassDetector
import com.wika.wicaby.core.photos.TimelineState
import com.wika.wicaby.core.photos.buckets
import com.wika.wicaby.core.photos.photoDate
import com.wika.wicaby.tv.LocalApi
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.Nav
import com.wika.wicaby.tv.Route
import com.wika.wicaby.tv.dreamApi
import com.wika.wicaby.tv.data.TvSettings
import com.wika.wicaby.tv.ui.Accents
import com.wika.wicaby.tv.ui.Cache
import com.wika.wicaby.tv.ui.WicabyTheme
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

// Photos spec PH-06 AC1-AC3 and PH-07 AC4 on the Android TV emulator, against mock-emby on the host (10.0.2.2), with
// the device class forced to tv-low. Keys go into the Compose tree (no adb input): Right ×5 along a row, Down a row,
// Page down to the next month (its label shows), OK opens the viewer; there Right, Up (info with the camera line),
// Play/Pause (the next still within interval + 1 s), then Back twice lands on the same tile, focused. The image sizes
// tv-low asks for are read from the mock's log by tools/checks/photos-android-check.mjs, which runs this.
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class PhotosTvDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val base = InstrumentationRegistry.getArguments().getString("mock") ?: "http://10.0.2.2:8981"
    private val server = Server("mock", "Mock", base, "emby")
    private lateinit var api: Api

    @Before
    fun signIn(): Unit = runBlocking {
        val auth = Api(server, "photos-tv-test").login("Wika", "wicaby")
        api = Api(server, "photos-tv-test", auth.accessToken, auth.user.id)
        DeviceClassDetector.forced = DeviceClass.TV_LOW
        Cache.map.clear()
        SingletonImageLoader.get(instrumentation.targetContext).run { memoryCache?.clear(); diskCache?.clear() }
    }

    @After
    fun reset() {
        DeviceClassDetector.forced = null
    }

    private fun shell(cmd: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(cmd)).bufferedReader().use { it.readText() }

    private fun press(key: Key) {
        rule.onRoot().performKeyInput { pressKey(key) }
        rule.waitForIdle()
    }

    private fun focused(tag: String) = rule.waitUntil(5_000) { runCatching { rule.onNodeWithTag(tag).assertIsFocused() }.isSuccess }

    // MainActivity's stack: a Nav over routes, each route's state in a SaveableStateHolder, the same transition.
    private fun stack(vararg routes: Route): SnapshotStateList<Route> {
        val stack = mutableStateListOf(*routes)
        rule.setContent {
            val holder = rememberSaveableStateHolder()
            val nav = remember { Nav(stack) { holder.removeState(it.toString()) } }
            CompositionLocalProvider(LocalNav provides nav, LocalApi provides api) {
                WicabyTheme(Accents[0]) {
                    BackHandler(stack.size > 1) { nav.pop() }
                    AnimatedContent(
                        stack.last(), Modifier.fillMaxSize(),
                        transitionSpec = { (fadeIn(tween(260, delayMillis = 60)) + scaleIn(tween(320), initialScale = 0.985f)) togetherWith fadeOut(tween(160)) },
                        label = "nav",
                    ) { route ->
                        holder.SaveableStateProvider(route.toString()) {
                            when (route) {
                                is Route.PhotoView -> PhotoViewerScreen(route.key, route.index)
                                else -> PhotosTab(api, "lib-photos", "Photos de famille", 48.dp)
                            }
                        }
                    }
                }
            }
        }
        return stack
    }

    @Test
    fun dpadGridViewerAndBackToTheTile() {
        val interval = TvSettings.photoInterval.value
        TvSettings.photoInterval.value = 3
        try {
            val stack = stack(Route.Main)
            rule.waitUntil(60_000) { (Cache.map["photos-lib-photos-false"] as? TimelineState)?.complete == true }
            val photos = (Cache.map.getValue("photos-lib-photos-false") as TimelineState).photos
            val months = buckets(photos.map { it.asset.takenAt })
            fun tile(i: Int) = "tile-${photos[i].asset.id}"
            val locale = rule.activity.resources.configuration.locales[0]
            fun labelShows(m: Int) = rule.waitUntil(3_000) {
                rule.onAllNodesWithText(photoDate("${months[m].key}-01", locale, "LLLL yyyy")).fetchSemanticsNodes().any { n -> n.config.getOrNull(SemanticsProperties.TestTag) == "month-label" }
            }

            focused(tile(0))
            // Page down month by month to the first month with two full rows (MOCK_PHOTOS=6000: within a few).
            val m = months.indexOfFirst { it.count >= 12 }
            assertTrue("no month with 12 assets", m in 0 until months.size - 1)
            repeat(m) { k ->
                press(Key.PageDown)
                focused(tile(months[k + 1].firstIndex))
            }
            val first = months[m].firstIndex
            repeat(5) { press(Key.DirectionRight) }
            focused(tile(first + 5))
            press(Key.DirectionDown)
            focused(tile(first + 11))
            press(Key.PageDown)
            val m1 = months[m + 1].firstIndex
            focused(tile(m1))
            labelShows(m + 1)

            press(Key.DirectionCenter)
            rule.waitUntil(3_000) { stack.last() == Route.PhotoView("photos-lib-photos-false", m1) }
            // Right: the next asset; on to a still, whose info has the camera line.
            var at = m1
            do {
                press(Key.DirectionRight)
                at++
                rule.waitUntil(3_000) { runCatching { rule.onNodeWithTag("photo-${photos[at].asset.id}").assertExists() }.isSuccess }
            } while (photos[at].asset.kind != "photo")
            press(Key.DirectionUp)
            rule.waitUntil(5_000) { rule.onAllNodesWithText("Wicaby Test", substring = true).fetchSemanticsNodes().isNotEmpty() }
            rule.onNodeWithTag("photo-info").assertExists()
            press(Key.DirectionDown)
            rule.waitUntil(3_000) { runCatching { rule.onNodeWithTag("photo-info").assertDoesNotExist() }.isSuccess }
            // Play/Pause: the next still within the interval + 1 s.
            val next = (at + 1 until photos.size).first { photos[it].asset.kind == "photo" }
            press(Key.MediaPlayPause)
            // The Compose test clock drives the effect's delay and the crossfade: step it, 100 ms at a time, up to 4 s.
            var ms = 0
            while (ms < 4_000 && runCatching { rule.onNodeWithTag("photo-${photos[next].asset.id}").assertExists() }.isFailure) {
                rule.mainClock.advanceTimeBy(100)
                Thread.sleep(20)
                ms += 100
            }
            rule.onNodeWithTag("photo-${photos[next].asset.id}").assertExists()
            instrumentation.sendStatus(0, Bundle().apply { putString("photos-slideshow", "next still after $ms ms of the 3 s interval + 1 s") })
            // Back stops the slideshow, Back again closes the viewer: the tile it was opened from has the focus.
            rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
            rule.waitForIdle()
            rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
            rule.waitUntil(3_000) { stack.size == 1 }
            focused(tile(m1))
            // Spec §4.4 tabs: OK on a pill keeps the focus on it in the new tab (Albums, then Favoris while it loads).
            rule.onNodeWithTag("photo-grid").performScrollToIndex(0)
            rule.onNodeWithTag("photos-tab-1").requestFocus()
            press(Key.DirectionCenter)
            focused("photos-tab-1")
            press(Key.DirectionRight)
            press(Key.DirectionCenter)
            focused("photos-tab-2")
            press(Key.DirectionLeft)
            press(Key.DirectionLeft)
            press(Key.DirectionCenter)
            focused("photos-tab-0")
        } finally {
            TvSettings.photoInterval.value = interval
        }
    }
}

// PH-07 AC4: the system Dream, started by the dream manager, shows photos when the screensaver source is Photos.
// No Compose test rule here: it would hand every ComposeView in the process, the Dream's too, a test clock that only
// moves while a test waits on it.
@RunWith(AndroidJUnit4::class)
class PhotoDreamDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val base = InstrumentationRegistry.getArguments().getString("mock") ?: "http://10.0.2.2:8981"
    private val server = Server("mock", "Mock", base, "emby")
    private lateinit var api: Api

    @Before
    fun signIn(): Unit = runBlocking {
        val auth = Api(server, "photos-tv-test").login("Wika", "wicaby")
        api = Api(server, "photos-tv-test", auth.accessToken, auth.user.id)
    }

    private fun shell(cmd: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(cmd)).bufferedReader().use { it.readText() }

    private fun dreaming(): Boolean {
        var on = false
        instrumentation.runOnMainSync {
            on = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).any { it.javaClass.name == "android.service.dreams.DreamActivity" }
        }
        return on
    }

    // PH-07 AC4: the system screensaver (Dream.kt, unchanged) shows photos when the setting says Photos. It needs a
    // session the TV opens without the picker: one saved account, no PIN.
    @Test
    fun dreamShowsPhotos() {
        val source = TvSettings.screensaverSource.value
        runBlocking {
            Core.prefs.setServer(server)
            Core.prefs.setSession(api.userId!!, "Wika", api.token!!, remember = true)
            Core.prefs.setSkipPicker(true)
            val snap = Core.prefs.current()
            assertTrue("no session the Dream may open: ${snap.profiles.size} profiles, skip=${snap.skipPicker}", dreamApi(snap) != null)
        }
        TvSettings.screensaverSource.value = TvSettings.SCREENSAVER_PHOTOS
        // Every setting changed below, as found ("null": unset), put back in finally.
        val saved = listOf(
            "secure screensaver_enabled", "secure screensaver_activate_on_sleep", "secure screensaver_components",
            "global stay_on_while_plugged_in", "system screen_off_timeout",
        ).associateWith { shell("settings get $it").trim() }
        try {
            // The system screensaver set to Wicaby, as Settings > Screen saver would (adb only on Google TV). `cmd dreams
            // start-dreaming` needs root, which this image refuses: the dream comes the user's way, from idleness.
            shell("settings put secure screensaver_enabled 1")
            shell("settings put secure screensaver_activate_on_sleep 1")
            shell("settings put secure screensaver_components ${instrumentation.targetContext.packageName}/com.wika.wicaby.tv.Dream")
            shell("settings put global stay_on_while_plugged_in 0")
            shell("settings put system screen_off_timeout 10000")
            shell("input keyevent KEYCODE_WAKEUP")
            // The Dream runs in this process: its window is a resumed DreamActivity of this package.
            val deadline = System.currentTimeMillis() + 60_000
            while (!dreaming() && System.currentTimeMillis() < deadline) Thread.sleep(500)
            assertTrue("the Dream did not start within 60 s", dreaming())
            Thread.sleep(8_000)
            assertTrue("the Dream stopped", dreaming())
            // A photo, not the black of a signed-out or empty screensaver: the middle of the screen has colour.
            val shot = instrumentation.uiAutomation.takeScreenshot()!!
            var lit = 0
            var n = 0
            for (x in shot.width / 4 until shot.width * 3 / 4 step 16) for (y in shot.height / 4 until shot.height * 3 / 4 step 16) {
                val c = shot.getPixel(x, y)
                if (AColor.red(c) + AColor.green(c) + AColor.blue(c) > 60) lit++
                n++
            }
            instrumentation.sendStatus(0, Bundle().apply { putString("photos-dream", "lit=${lit * 100 / n}% of the centre") })
            assertTrue("the dream shows black (${lit * 100 / n}% lit)", lit * 2 > n)
        } finally {
            shell("input keyevent KEYCODE_WAKEUP")
            saved.forEach { (k, v) -> shell(if (v == "null") "settings delete $k" else "settings put $k $v") }
            TvSettings.screensaverSource.value = source
        }
    }
}
