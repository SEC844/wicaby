package com.wika.wicaby.core.data

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okio.Path.Companion.toOkioPath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

// Onboarding flag (OB-C1): a fresh store runs the wizard, an install from before the flag never does.
class PrefsOnboardedTest {
    private val device = stringPreferencesKey("device_id")

    @Test
    fun freshStoreIsNotOnboarded() {
        val p = mutablePreferencesOf()
        assertFalse(onboarded(p))
        firstRun(p)
        assertFalse(onboarded(p))
        assertTrue(p[device]!!.isNotEmpty())
        // Later launches change nothing until the wizard is done or skipped.
        val id = p[device]
        firstRun(p)
        assertFalse(onboarded(p))
        assertEquals(id, p[device])
    }

    @Test
    fun existingInstallIsOnboarded() {
        val p = mutablePreferencesOf(device to "abc")
        // Read before current() migrates: the same answer.
        assertTrue(onboarded(p))
        firstRun(p)
        assertEquals(true, p[onboardedKey])
        assertEquals("abc", p[device])
    }

    // setOnboarded's edit, through a file-backed store reopened from disk. One write only: the Android
    // FileStorage cannot replace an existing file on a Windows host.
    @Test
    fun setOnboardedPersists() = runBlocking {
        val file = Files.createTempDirectory("wicaby-prefs").resolve("wicaby.preferences_pb").toFile().toOkioPath()
        val job = Job()
        val first = PreferenceDataStoreFactory.createWithPath(scope = CoroutineScope(Dispatchers.IO + job)) { file }
        first.edit { it[onboardedKey] = true }
        job.cancelAndJoin()
        val reopened = PreferenceDataStoreFactory.createWithPath(scope = CoroutineScope(Dispatchers.IO + Job())) { file }
        val p = reopened.data.first().toMutablePreferences()
        // No device id: only the stored flag can say true.
        assertTrue(onboarded(p))
        // The migration never overrides a stored answer.
        firstRun(p)
        assertTrue(onboarded(p))
    }
}
