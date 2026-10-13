package com.wika.wicaby.tv.music

import android.content.Intent
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.music.albums
import com.wika.wicaby.core.player.PlayQueue
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

// Music spec MU-09 AC5 on the Android TV emulator (never a real TV), against mock-emby on the host with MOCK_MUSIC=1
// (silent WAV tracks) and the media volume at 0: the session shows in `dumpsys media_session` as PLAYING, the remote's
// Play/Pause key toggles it, and after HOME it plays on with MusicService in the foreground. Run by hand, on ONE
// emulator named by its serial (never `connectedAndroidTest`, which installs on every attached device):
//   MOCK_MUSIC=1 node tools/mock-server/mock-emby.mjs 8982
//   ./gradlew :tv:assembleDebug :tv:assembleDebugAndroidTest
//   adb -s emulator-NNNN install -r -t <tv apk>; adb -s emulator-NNNN install -r -t tv/build/outputs/apk/androidTest/debug/tv-debug-androidTest.apk
//   adb -s emulator-NNNN shell am instrument -w -e class com.wika.wicaby.tv.music.MusicServiceDeviceTest com.wika.wicaby.tv.test/androidx.test.runner.AndroidJUnitRunner
@RunWith(AndroidJUnit4::class)
class MusicServiceDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val base = InstrumentationRegistry.getArguments().getString("mock") ?: "http://10.0.2.2:8982"
    private val server = Server("mock", "Mock", base, "emby")
    private val context get() = instrumentation.targetContext

    private fun shell(cmd: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(cmd)).bufferedReader().use { it.readText() }

    private fun main(block: () -> Unit) = instrumentation.runOnMainSync(block)

    private fun until(what: String, ok: () -> Boolean) {
        val end = System.currentTimeMillis() + 30_000
        while (!ok()) {
            check(System.currentTimeMillis() < end) { "timed out: $what" }
            Thread.sleep(200)
        }
    }

    private fun playing(): Boolean {
        var p = false
        main { p = Music.session?.player?.isPlaying == true }
        return p
    }

    private fun playWhenReady(): Boolean {
        var p = false
        main { p = Music.session?.player?.playWhenReady == true }
        return p
    }

    @After
    fun stop() = main { Music.release() }

    @Test
    fun sessionMediaKeysAndHome(): Unit = runBlocking {
        // Never audible: the media stream at 0 before anything plays (the tracks are silence anyway).
        shell("cmd media_session volume --stream 3 --set 0")
        val auth = Api(server, "music-tv-test").login("Wika", "wicaby")
        val api = Api(server, "music-tv-test", auth.accessToken, auth.user.id)
        // The signed-in server: Core.http's interceptor gives the streams its auth, as after a real sign-in.
        Core.api = api
        val albums = api.albums("lib-music").items
        suspend fun play(name: String) {
            val tracks = api.tracksOf(PlayQueue.tracks(api, albums.first { it.name == name }))
            main {
                Music.start(context, api, tracks, 0)
                context.startActivity(Intent(context, MusicActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            until("playing $name") { playing() }
        }
        // Screenshots for the record (emulator only): the now-playing screen, then its synced lyrics (the lyrics button
        // is 6 to the right of Play, which has the focus).
        play("Lignes claires")
        Thread.sleep(2_000)
        shell("screencap -p /sdcard/Download/wicaby-music-nowplaying.png")
        repeat(6) { shell("input keyevent KEYCODE_DPAD_RIGHT") }
        shell("input keyevent KEYCODE_DPAD_CENTER")
        Thread.sleep(3_000)
        shell("screencap -p /sdcard/Download/wicaby-music-lyrics.png")

        // Longer tracks (20 s and more) for the key and HOME checks.
        play("Marée basse")
        val sessions = shell("dumpsys media_session")
        assertTrue(sessions, sessions.contains("com.wika.wicaby.tv") && Regex("""state=PlaybackState \{state=(3|PLAYING)""").containsMatchIn(sessions))

        shell("input keyevent KEYCODE_MEDIA_PLAY_PAUSE")
        until("paused by the remote") { !playWhenReady() }
        shell("input keyevent KEYCODE_MEDIA_PLAY_PAUSE")
        until("playing again") { playWhenReady() }

        shell("input keyevent KEYCODE_HOME")
        Thread.sleep(3_000)
        until("still playing after HOME") { playing() }
        val services = shell("dumpsys activity services com.wika.wicaby.tv")
        assertTrue(services, services.contains("MusicService") && services.contains("isForeground=true"))

        // The system screensaver (Wicaby's Dream) over the home screen while music plays: the ambient layout. The
        // emulator stays awake on power and dream commands need root, so a 15 s timeout brings it, then is undone.
        val stayOn = shell("settings get global stay_on_while_plugged_in").trim()
        val timeout = shell("settings get system screen_off_timeout").trim()
        try {
            shell("settings put secure screensaver_enabled 1")
            shell("settings put secure screensaver_activate_on_sleep 1")
            shell("settings put secure screensaver_components com.wika.wicaby.tv/.Dream")
            shell("settings put global stay_on_while_plugged_in 0")
            shell("settings put system screen_off_timeout 15000")
            until("the screensaver") { shell("dumpsys dreams").contains("mCurrentDream=DreamRecord") && shell("dumpsys dreams").contains("com.wika.wicaby.tv.Dream") }
            Thread.sleep(2_500)
            assertTrue(playing())
            shell("screencap -p /sdcard/Download/wicaby-music-dream.png")
        } finally {
            shell("settings put global stay_on_while_plugged_in $stayOn")
            shell("settings put system screen_off_timeout $timeout")
            shell("input keyevent KEYCODE_WAKEUP")
        }
    }
}
