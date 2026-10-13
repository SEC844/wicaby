package com.wika.wicaby.core.plex

import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.player.ExternalPlayer
import okhttp3.OkHttpClient
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The Plex token never goes in a URL: not through an unmapped route (an item no play has read yet), not through
// the external player's link. Nothing is sent: url() only builds strings.
class PlexUrlTest {
    private val client = PlexClient("wicaby-test-device", "Test device", "0.8.0-test", "14")
    private fun api(unbound: Boolean = false) = PlexApi(
        Server("machine1", "PMS", "http://192.168.1.5:32400", "plex"), "dev", "SECRET-TOKEN", "acct",
        PlexApi.Options(unbound = unbound), OkHttpClient(), client,
    )

    @Test
    fun noTokenInAnyUrl() {
        for (a in listOf(api(), api(unbound = true))) {
            val stream = ExternalPlayer.streamUrl(a, "123", "456")
            assertFalse(stream, stream.contains("SECRET-TOKEN"))
            val other = a.url("/Videos/123/stream", "static" to true, "api_key" to "SECRET-TOKEN", "x" to "SECRET-TOKEN")
            assertFalse(other, other.contains("SECRET-TOKEN"))
            assertTrue(other, other.contains("static=true"))
        }
    }
}
