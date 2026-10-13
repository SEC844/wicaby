package com.wika.wicaby.mobile.cast

import android.app.Application
import androidx.media3.common.MediaItem
import com.google.android.gms.cast.HlsVideoSegmentFormat
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaTrack
import com.wika.wicaby.core.cast.CastStream
import com.wika.wicaby.core.cast.CastSubtitle
import com.wika.wicaby.core.data.Item
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// CA-10 acceptance 4b: the Default Media Receiver gets the stream CastController prepared (Emby: LAN origin, api_key),
// with VTT tracks, never the local MediaItem's URI. CastControllerTest.castDeviceGetsPreparedEmbyStream covers how that
// stream is prepared. org.json needs Android, hence Robolectric.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class CastMediaItemsTest {
    private val base = "http://192.168.1.5:8096"
    private val film = Item("42", "Film", "Movie", mediaType = "Video")
    private val direct = CastStream(
        film, "$base/Videos/42/stream.mp4?Static=true&MediaSourceId=s1&PlaySessionId=ps&DeviceId=phone&api_key=tok", "mp4", true, 7_200_000,
        listOf(
            CastSubtitle(3, "$base/Videos/42/s1/Subtitles/3/Stream.vtt?api_key=tok", "fre", "Français"),
            CastSubtitle(4, "$base/Videos/42/s1/Subtitles/4/Stream.vtt?api_key=tok", "eng", "English"),
        ),
        4,
    )
    private val streams = mutableMapOf("42" to direct)
    private val conv = CastMediaItems { streams[it] }

    // What the local player holds: header auth, the phone's own stream. It must never reach the receiver.
    private fun local(id: String) = MediaItem.Builder().setMediaId(id).setUri("$base/Videos/$id/stream?static=true").build()

    @Test
    fun mapsToPreparedUrlWithVttTracks() {
        val q = conv.toMediaQueueItem(local("42"))
        val info = q.media!!
        assertEquals(direct.url, info.contentId)
        assertEquals(direct.url, info.contentUrl)
        assertEquals("tok", android.net.Uri.parse(info.contentUrl).getQueryParameter("api_key"))
        assertEquals("video/mp4", info.contentType)
        assertEquals(MediaInfo.STREAM_TYPE_BUFFERED, info.streamType)
        assertEquals(7_200_000L, info.streamDuration)
        assertNull(info.hlsVideoSegmentFormat)
        val tracks = info.mediaTracks!!
        assertEquals(listOf(3L, 4L), tracks.map { it.id })
        tracks.forEach { t ->
            assertEquals(MediaTrack.TYPE_TEXT, t.type)
            assertEquals(MediaTrack.SUBTYPE_SUBTITLES, t.subtype)
            assertEquals("text/vtt", t.contentType)
        }
        assertEquals(direct.subtitles[1].url, tracks[1].contentId)
        assertEquals("eng", tracks[1].language)
        // The subtitle picked before the handoff is on.
        assertArrayEquals(longArrayOf(4), q.activeTrackIds)
        // Back from the receiver's queue: the same item.
        assertEquals("42", conv.toMediaItem(q).mediaId)
    }

    @Test
    fun hlsTranscode() {
        streams["42"] = direct.copy(url = "$base/videos/42/master.m3u8?MediaSourceId=s1&api_key=tok", container = "m3u8", direct = false, subtitle = -1)
        val info = conv.toMediaQueueItem(local("42")).media!!
        assertEquals("application/x-mpegURL", info.contentType)
        assertEquals(HlsVideoSegmentFormat.MPEG2_TS, info.hlsVideoSegmentFormat)
        streams["42"] = streams.getValue("42").copy(url = "$base/videos/42/master.m3u8?SegmentContainer=mp4&ApiKey=tok")
        assertEquals(HlsVideoSegmentFormat.FMP4, conv.toMediaQueueItem(local("42")).media!!.hlsVideoSegmentFormat)
    }

    @Test
    fun missingPreparedStreamThrows() {
        assertThrows(IllegalStateException::class.java) { conv.toMediaQueueItem(local("7")) }
    }
}
