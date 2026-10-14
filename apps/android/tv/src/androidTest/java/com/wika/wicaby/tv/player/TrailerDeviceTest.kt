package com.wika.wicaby.tv.player

import android.content.Intent
import android.graphics.Bitmap
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Server
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

// 0.10.2: a local trailer showed a black screen on a real TV (sound, no picture). On the Android TV emulator (never a
// real TV), against mock-emby on the host serving a video file:
//   node tools/mock-server/mock-emby.mjs 8983 .dev/pbux-silent.mkv
// "Bande-annonce" (PlayerActivity in trailer mode) must draw the video: a screenshot taken while it plays has a picture,
// not the black of an empty surface. movie-6's trailer is VC-1 (trailer-fixture.mjs): no decoder, so before the fix
// ExoPlayer dropped the video and played the sound over black; now the server converts it. Run on ONE emulator by its
// serial (never connectedAndroidTest):
//   adb -s emulator-NNNN shell am instrument -w -e class com.wika.wicaby.tv.player.TrailerDeviceTest com.wika.wicaby.tv.test/androidx.test.runner.AndroidJUnitRunner
@RunWith(AndroidJUnit4::class)
class TrailerDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val base = InstrumentationRegistry.getArguments().getString("mock") ?: "http://10.0.2.2:8983"
    private val server = Server("mock", "Mock", base, "emby")
    private val context get() = instrumentation.targetContext

    // The share of sampled pixels that are not near black.
    private fun lit(b: Bitmap): Double {
        var n = 0
        var lit = 0
        for (y in b.height / 8 until b.height * 7 / 8 step 16) for (x in b.width / 8 until b.width * 7 / 8 step 16) {
            val c = b.getPixel(x, y)
            n++
            if (((c shr 16) and 0xff) + ((c shr 8) and 0xff) + (c and 0xff) > 60) lit++
        }
        return lit.toDouble() / n
    }

    @Test
    fun localTrailersDrawTheirPicture(): Unit = runBlocking {
        instrumentation.uiAutomation.executeShellCommand("cmd media_session volume --stream 3 --set 0").close()
        val auth = Api(server, "trailer-tv-test").login("Wika", "wicaby")
        Core.api = Api(server, "trailer-tv-test", auth.accessToken, auth.user.id)
        // movie-0's trailer direct plays; movie-6's is VC-1, which no Android decoder plays: the server converts it.
        for (film in listOf("movie-0", "movie-6")) {
            val trailer = Core.api!!.localTrailers(film).first()
            val intent = Intent(context, PlayerActivity::class.java)
                .putExtra(PlayerActivity.EXTRA_ID, trailer.id).putExtra(PlayerActivity.EXTRA_FROM_START, true).putExtra(PlayerActivity.EXTRA_TRAILER, true)
            // Sampled every 2 s while it plays: the picture, not the black of an empty surface.
            val scenario = ActivityScenario.launch<PlayerActivity>(intent)
            var best = 0.0
            val end = System.currentTimeMillis() + 40_000
            // Only while the player is on screen (a 30 s trailer that ends closes it: the launcher is no picture of it).
            while (System.currentTimeMillis() < end && best < 0.3) {
                Thread.sleep(2_000)
                if (scenario.state != Lifecycle.State.RESUMED) break
                val shot = instrumentation.uiAutomation.takeScreenshot() ?: continue
                best = maxOf(best, lit(shot))
                shot.compress(Bitmap.CompressFormat.PNG, 90, File(context.filesDir, "trailer-$film.png").outputStream())
            }
            assertTrue("$film: the trailer's picture (lit share $best)", best >= 0.3)
            scenario.close()
        }
    }
}
