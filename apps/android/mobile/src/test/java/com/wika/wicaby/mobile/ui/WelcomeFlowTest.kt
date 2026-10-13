package com.wika.wicaby.mobile.ui

import android.app.Application
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.Session
import com.wika.wicaby.core.data.Snapshot
import com.wika.wicaby.core.mesh.MeshStatus
import com.wika.wicaby.mobile.R
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import com.wika.wicaby.core.R as CoreR

// OB-M1 acceptance, in French and in English (the strings come from the resources, so both run the same steps).
abstract class WelcomeFlowTest {
    @get:Rule val rule = createComposeRule()
    private val app: Application get() = RuntimeEnvironment.getApplication()
    private fun text(id: Int, vararg args: Any) = app.getString(id, *args)

    private val server = Server("s1", "Living room", "http://192.0.2.10:8096", "emby")
    private val fresh = Snapshot("dev", null, null, accent = 0, maxMbps = 0, displayMode = 0, onboarded = false)

    private class FakeStore(initial: Snapshot) : WizardStore {
        val snap = MutableStateFlow(initial)
        override suspend fun setAccent(i: Int) = snap.update { it.copy(accent = i) }
        override suspend fun setOled(v: Boolean) = snap.update { it.copy(oled = v) }
        override suspend fun setWifiOnlyDownloads(v: Boolean) = snap.update { it.copy(wifiOnlyDownloads = v) }
        override suspend fun setServer(server: Server) = snap.update { it.copy(server = server) }
        override suspend fun setOnboarded(v: Boolean) = snap.update { it.copy(onboarded = v) }
    }

    private fun show(store: FakeStore) {
        SetupRequest.wizard = true
        rule.setContent {
            val s by store.snap.collectAsState()
            WicabyTheme(Accents[0]) {
                CompositionLocalProvider(LocalSnapshot provides s) {
                    // No LAN broadcast from a unit test.
                    WelcomeFlow(s, store = store, mesh = MutableStateFlow(MeshStatus()), find = { emptyList() })
                }
            }
        }
    }

    @After
    fun reset() {
        SetupRequest.wizard = false
        SetupRequest.returnTo = null
    }

    @Test
    fun freshInstallShowsWelcome() {
        assertTrue(showsWizard(fresh))
        assertFalse(showsWizard(fresh.copy(server = server)))
        assertFalse(showsWizard(fresh.copy(onboarded = true)))
        show(FakeStore(fresh))
        rule.onNodeWithText(text(CoreR.string.onboarding_welcome_title)).assertExists()
        rule.onNodeWithText(text(CoreR.string.onboarding_start)).assertExists()
    }

    @Test
    fun lanRowRevealsTheAddressField() {
        show(FakeStore(fresh))
        rule.onNodeWithText(text(CoreR.string.onboarding_start)).performClick()
        rule.onNodeWithText(text(R.string.wizard_continue)).performClick()
        rule.onNodeWithText(text(CoreR.string.onboarding_where_title)).assertExists()
        rule.onNodeWithText(text(R.string.address_hint)).assertDoesNotExist()
        rule.onNodeWithText(text(CoreR.string.onboarding_where_lan)).performClick()
        rule.onNodeWithText(text(R.string.address_hint)).assertExists()
    }

    @Test
    fun wifiOnlySwitchPersistsAndDoneLeavesTheWizard() {
        // Signed in already (back from step 4): step 3 offers Continue.
        val store = FakeStore(fresh.copy(server = server, session = Session(server, "u1", "Alex", "token")))
        show(store)
        rule.onNodeWithText(text(CoreR.string.onboarding_start)).performClick()
        rule.onNodeWithText(text(R.string.wizard_continue)).performClick()
        rule.onNodeWithText(text(R.string.wizard_continue)).performClick()
        rule.onNodeWithText(text(CoreR.string.onboarding_extras_title)).assertExists()
        rule.onNodeWithText(text(R.string.wifi_only)).performClick()
        rule.waitForIdle()
        assertFalse(store.snap.value.wifiOnlyDownloads)
        rule.onNode(androidx.compose.ui.test.isToggleable()).assertIsOff()

        rule.onNodeWithText(text(R.string.wizard_continue)).performClick()
        rule.onNodeWithText(text(CoreR.string.onboarding_done_title)).assertExists()
        rule.onNodeWithText(text(CoreR.string.onboarding_done_start)).performClick()
        rule.waitForIdle()
        assertTrue(store.snap.value.onboarded)
        // WicabyRoot shows the main shell once the wizard is off and a session exists.
        assertFalse(SetupRequest.wizard)
        assertEquals(null, SetupRequest.returnTo)
    }

    @Test
    fun publicAddressOverHttpWarns() {
        assertTrue(insecureAddress("http://media.example.com:8096"))
        assertFalse(insecureAddress("https://media.example.com"))
        assertFalse(insecureAddress("http://10.0.0.5:8096"))
        assertFalse(insecureAddress("http://100.64.0.5:8096"))
        assertFalse(insecureAddress("http://nas.local:8096"))
        assertFalse(insecureAddress("http://127.0.0.1:8096"))
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "fr")
class WelcomeFlowFrTest : WelcomeFlowTest()

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "en")
class WelcomeFlowEnTest : WelcomeFlowTest()
