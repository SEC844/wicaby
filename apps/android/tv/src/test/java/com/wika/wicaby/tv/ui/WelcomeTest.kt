package com.wika.wicaby.tv.ui

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import androidx.tv.material3.Text
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.Snapshot
import com.wika.wicaby.tv.Nav
import com.wika.wicaby.tv.Route
import com.wika.wicaby.tv.startRoute
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// OB-T1: the first-run wizard's start route and its D-pad steps 1 and 2. A plain Application: Wicaby would start
// Core, the mesh and the updater; the steps under test only reach the outside through their callbacks.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w960dp-h540dp-land-mdpi")
class WelcomeTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val home = Server("abc123", "Home", "http://192.0.2.10:8096", "emby")
    private val fresh = Snapshot("dev", null, null, 0, 0, 0, onboarded = false)

    private var language = ""
    private var skipped = 0

    @After
    fun tearDown() {
        C.theme = "graphite"
    }

    private fun press(key: Key) = rule.onRoot().performKeyInput { pressKey(key) }

    private fun wizard() {
        rule.setContent {
            WicabyTheme(Accents[0]) {
                Wizard("", onLanguage = { language = it }, accent = 0, onAccent = {}, onTheme = {}, onSkip = { skipped++ }) { step, _ -> Text("step $step") }
            }
        }
        // The default focus waits a moment (Modifier.remembered); let it land before moving it.
        rule.mainClock.advanceTimeBy(200)
    }

    @Test
    fun aFreshInstallOpensTheWizardAndASavedServerItsSignIn() {
        assertEquals(Route.Welcome(), startRoute(fresh))
        assertEquals(Route.Login(home), startRoute(fresh.copy(server = home)))
        // Skipped (or an install from before the wizard): the classic server screen.
        assertEquals(Route.Servers, startRoute(fresh.copy(onboarded = true)))
    }

    @Test
    fun upRightOkPicksEnglish() {
        wizard()
        rule.onNodeWithTag("start").assertIsFocused()
        press(Key.DirectionUp)
        press(Key.DirectionRight)
        press(Key.DirectionCenter)
        assertEquals("en", language)
    }

    @Test
    fun focusingAThemeCardAppliesIt() {
        wizard()
        rule.onNodeWithTag("start").requestFocus()
        press(Key.DirectionCenter)
        rule.waitForIdle()
        rule.onNodeWithTag("theme-oled").requestFocus()
        rule.waitForIdle()
        assertEquals("oled", C.theme)
        rule.onNodeWithTag("theme-cinema").requestFocus()
        rule.waitForIdle()
        assertEquals("cinema", C.theme)
        rule.onNodeWithTag("theme-graphite").requestFocus()
        rule.waitForIdle()
        assertEquals("graphite", C.theme)
        // The TV never offers the light theme.
        rule.onNodeWithTag("theme-light").assertDoesNotExist()
    }

    @Test
    fun backOnStepTwoReturnsToStepOne() {
        wizard()
        rule.onNodeWithTag("start").requestFocus()
        press(Key.DirectionCenter)
        rule.waitForIdle()
        rule.onNodeWithTag("theme-graphite").assertExists()
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        rule.onNodeWithTag("start").assertExists()
        rule.onNodeWithTag("theme-graphite").assertDoesNotExist()
    }

    @Test
    fun skipLeavesTheWizard() {
        wizard()
        rule.onNodeWithTag("skip").requestFocus()
        press(Key.DirectionCenter)
        assertEquals(1, skipped)
        // WelcomeScreen writes onboarded first, then lands where the app would have: no server, the server screen.
        assertEquals(Route.Servers, startRoute(fresh.copy(onboarded = true)))
    }

    // Run Setup Again twice: Skip (or Start Watching) pops the wizard without Back, and the second rerun still
    // opens on step 1, not where the first one stopped.
    @Test
    fun aSecondRerunStartsAtStepOne() {
        lateinit var nav: Nav
        rule.setContent {
            val stack = remember { mutableStateListOf<Route>(Route.Main) }
            val holder = rememberSaveableStateHolder()
            nav = remember { Nav(stack) { holder.removeState(it.toString()) } }
            WicabyTheme(Accents[0]) {
                holder.SaveableStateProvider(stack.last().toString()) {
                    if (stack.last() is Route.Welcome) {
                        Wizard("", onLanguage = {}, accent = 0, onAccent = {}, onTheme = {}, onSkip = { nav.pop() }) { step, go ->
                            if (step == 3) LaunchedEffect(Unit) { go(5) }
                            Text("step $step")
                        }
                    } else Text("main")
                }
            }
        }
        rule.runOnUiThread { nav.push(Route.Welcome(rerun = true)) }
        rule.waitForIdle()
        rule.onNodeWithTag("start").requestFocus()
        press(Key.DirectionCenter)
        rule.waitForIdle()
        rule.onNodeWithTag("continue").requestFocus()
        press(Key.DirectionCenter)
        rule.waitForIdle()
        rule.onNodeWithText("step 5").assertExists()
        rule.onNodeWithTag("skip").requestFocus()
        press(Key.DirectionCenter)
        rule.waitForIdle()
        rule.onNodeWithText("main").assertExists()
        rule.runOnUiThread { nav.push(Route.Welcome(rerun = true)) }
        rule.waitForIdle()
        rule.onNodeWithTag("start").assertExists()
        rule.onNodeWithText("step 5").assertDoesNotExist()
    }
}
