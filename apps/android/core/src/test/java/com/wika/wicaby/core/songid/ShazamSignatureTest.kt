package com.wika.wicaby.core.songid

import com.wika.wicaby.core.data.json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import kotlin.math.abs

// The signature against the reference SongRec's own Python code made (desktop's tools/checks/song-id-check.mjs runs
// the same fixture). Robolectric for android.util.Base64.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ShazamSignatureTest {
    // Integer math only, the same samples as song-id-check.mjs: three gated triangle waves over LCG noise.
    private fun synth(total: Int): ShortArray {
        fun tri(n: Int, p: Int, k: Int) = abs((n % p) * 2 - p) * k / p - k / 2
        var x = 12345
        return ShortArray(total) { n ->
            val sec = n / 16000
            x = (x * 1103515245 + 12345) and 0x7fffffff
            var s = (x shr 16) % 2001 - 1000 + tri(n, 9 + sec % 3, 3000)
            if ((n / 4000) % 3 != 0) s += tri(n, 40 + 7 * (sec % 5), 8000)
            if ((n / 2400) % 4 != 1) s += tri(n, 23 + 3 * (sec % 4), 6000)
            s.toShort()
        }
    }

    @Test
    fun matchesSongRec() {
        val f = json.parseToJsonElement(File("../../../tools/checks/fixtures/song-id/signature.json").readText()).jsonObject
        val sig = ShazamSignature.of(synth(f["samples"]!!.jsonPrimitive.int))
        assertEquals(f["peaks"]!!.jsonPrimitive.int, sig.peaks)
        assertEquals(12_000, sig.sampleMs)
        assertEquals(f["uri"]!!.jsonPrimitive.content, sig.uri)
        assertEquals(0, ShazamSignature.of(ShortArray(16000)).peaks)
    }

    @Test
    fun resamplesTo16kAndMatchesArtists() {
        // 48 kHz ramp: every third sample, capped at 12 s.
        val pcm = SongId.resample(List(48_000 * 13) { (it % 3000).toFloat() }, 48_000)
        assertEquals(16_000 * 12, pcm.size)
        assertEquals(300, pcm[100].toInt())
        assertEquals(16_000, SongId.resample(List(44_100) { 0f }, 44_100).size)
        assertEquals("beyonce jay z", SongId.norm("Beyoncé & JAY-Z"))
    }

    @Test
    fun readsTheAnswer() {
        assertNull(ShazamSignature.songOf("""{"matches":[]}"""))
        assertNull(ShazamSignature.songOf("not json"))
        val song = ShazamSignature.songOf(
            """{"matches":[{}],"track":{"title":"Song","subtitle":"Artist","url":"https://www.shazam.com/track/1/song",
            "images":{"coverart":"https://img/1.jpg","coverarthq":"http://insecure/1.jpg"},
            "sections":[{"type":"SONG","metadata":[{"title":"Album","text":"Record"}]}]}}""",
        )
        assertEquals(ShazamSignature.Song("Song", "Artist", "Record", "https://img/1.jpg", "https://www.shazam.com/track/1/song"), song)
        val links = ShazamSignature.links(song!!)
        assertEquals(listOf("shazam", "spotify", "youtube", "apple"), links.map { it.first })
        assertEquals("https://open.spotify.com/search/Artist%20Song", links[1].second)
    }
}
