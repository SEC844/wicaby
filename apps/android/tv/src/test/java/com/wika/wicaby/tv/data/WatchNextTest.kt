package com.wika.wicaby.tv.data

import android.app.Application
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class WatchNextTest {
    // "Who is watching?" to another profile: the launcher's Watch Next row is not left to the next viewer.
    @Test
    fun aProfileSwitchClearsTheRow() = runBlocking {
        val app: Application = RuntimeEnvironment.getApplication()
        assertTrue(WatchNext.follow(app, "s1|parent"))
        assertFalse(WatchNext.follow(app, "s1|parent")) // a reconnect, same user
        assertTrue(WatchNext.follow(app, "s1|child"))
    }
}
