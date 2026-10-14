package com.wika.wicaby.core.music

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.MediaSource
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.player.AudioFx
import com.wika.wicaby.core.player.AudioFxChain
import com.wika.wicaby.core.player.LocalMedia
import com.wika.wicaby.core.player.audioAttributes
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

// Music spec MU-07 AC1-AC4 and AC6: a real ExoPlayer that is never prepared (nothing decodes, nothing sounds), the
// reports on a MockWebServer.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MusicSessionTest {
    private lateinit var server: MockWebServer
    private val reports = CopyOnWriteArrayList<RecordedRequest>()
    private lateinit var player: ExoPlayer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.url.encodedPath.startsWith("/Sessions/")) reports += request
                return MockResponse.Builder().code(204).build()
            }
        }
        server.start()
        player = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).build()
        MusicGain.mode = GainMode.Track
        MusicGain.preampDb = 0.0
    }

    @After
    fun tearDown() {
        player.release()
        server.close()
        MusicGain.mode = GainMode.Album
        MusicGain.preampDb = 0.0
        AudioFx.musicGainDb = 0f
    }

    private fun api(kind: String = "jellyfin") = Api(Server("s", "S", server.url("/").toString().trimEnd('/'), kind), "phone", "t", "u")

    private fun track(n: Int, gain: Double? = null) = Item(
        id = "t$n", name = "Titre $n", type = "Audio", album = "Album test", albumId = "alb", albumArtist = "Groupe test",
        artists = listOf("Groupe test"), indexNumber = n, parentIndexNumber = 1, runTimeTicks = 80_000_000L,
        imageTags = mapOf("Primary" to "tag$n"), normalizationGain = gain,
    )

    private val album = listOf(track(1, -3.0), track(2, -6.5), track(3, -9.0))

    // The reports in the order the server got them, as "path itemId".
    private fun awaitReports(n: Int): List<String> {
        val end = System.currentTimeMillis() + 5_000
        while (reports.size < n && System.currentTimeMillis() < end) Thread.sleep(20)
        return reports.map { r -> r.url.encodedPath + " " + Json.parseToJsonElement(r.body!!.utf8()).jsonObject["ItemId"]!!.jsonPrimitive.content }
    }

    // What ExoPlayer does at the end of a track: the next item plays, then AUTO is heard (the seek alone is not).
    private fun autoAdvance(s: MusicSession) {
        player.removeListener(s.listener)
        player.seekTo(1, 0)
        player.addListener(s.listener)
        s.listener.onMediaItemTransition(player.currentMediaItem, Player.MEDIA_ITEM_TRANSITION_REASON_AUTO)
    }

    @Test
    fun anAlbumBuildsOneItemPerTrackWithItsMetadata() {
        val s = MusicSession(api(), player, album)
        s.load()
        assertEquals(3, player.mediaItemCount)
        for (i in 0..2) {
            val m = player.getMediaItemAt(i)
            assertEquals("t${i + 1}", m.mediaId)
            assertEquals("Titre ${i + 1}", m.mediaMetadata.title)
            assertEquals("Groupe test", m.mediaMetadata.artist)
            assertEquals("Album test", m.mediaMetadata.albumTitle)
            assertEquals(i + 1, m.mediaMetadata.trackNumber)
            assertTrue(m.mediaMetadata.artworkUri.toString(), m.mediaMetadata.artworkUri.toString().contains("/Items/t${i + 1}/Images/Primary"))
            assertTrue(m.localConfiguration!!.uri.toString().contains("/Audio/t${i + 1}/stream?static=true"))
        }
        s.release()
    }

    // The 0.10.1 bug: Emby answered 400 to /Audio/{id}/stream?static=true&MediaSourceId=<item id> (no DeviceId, and an
    // Emby source id is not the item id). Now as desktop: the track's own source id, DeviceId and a PlaySessionId that
    // the reports carry too; a track listed without its MediaSources sends none (the server's default source).
    @Test
    fun theStreamNamesTheSourceTheDeviceAndThePlaySession() {
        val withSource = track(1).copy(mediaSources = listOf(MediaSource(id = "mediasource_1")))
        val s = MusicSession(api(), player, listOf(withSource, track(2)))
        s.load()
        val u1 = player.getMediaItemAt(0).localConfiguration!!.uri
        val u2 = player.getMediaItemAt(1).localConfiguration!!.uri
        assertEquals("/Audio/t1/stream", u1.path)
        assertEquals("mediasource_1", u1.getQueryParameter("MediaSourceId"))
        assertEquals("phone", u1.getQueryParameter("DeviceId"))
        assertEquals(null, u2.getQueryParameter("MediaSourceId"))
        assertEquals("phone", u2.getQueryParameter("DeviceId"))
        val psid = u1.getQueryParameter("PlaySessionId")!!
        assertTrue(psid.length == 32 && psid != u2.getQueryParameter("PlaySessionId"))
        awaitReports(1)
        val playing = Json.parseToJsonElement(reports[0].body!!.utf8()).jsonObject
        assertEquals(psid, playing["PlaySessionId"]!!.jsonPrimitive.content)
        assertEquals("mediasource_1", playing["MediaSourceId"]!!.jsonPrimitive.content)
        // The next track reports under the session its stream was opened with.
        autoAdvance(s)
        awaitReports(3)
        assertEquals(psid, Json.parseToJsonElement(reports[1].body!!.utf8()).jsonObject["PlaySessionId"]!!.jsonPrimitive.content)
        assertEquals(u2.getQueryParameter("PlaySessionId"), Json.parseToJsonElement(reports[2].body!!.utf8()).jsonObject["PlaySessionId"]!!.jsonPrimitive.content)
        s.release()
    }

    @Test
    fun aQueueMoveRebuildsOnlyTheItemsAfterTheCurrentOne() {
        val s = MusicSession(api(), player, album)
        s.load()
        player.seekTo(0, 1_234)
        val first = player.getMediaItemAt(0)
        s.move(2, 1)
        assertEquals(listOf("t1", "t3", "t2"), s.queue.ids.toList())
        assertEquals(0, player.currentMediaItemIndex)
        assertEquals(1_234, player.currentPosition)
        assertSame(first, player.getMediaItemAt(0))
        assertEquals(listOf("t1", "t3", "t2"), (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId })
        s.release()
    }

    @Test
    fun anAutoTransitionReportsStoppedThenPlaying() {
        val s = MusicSession(api(), player, album)
        s.load()
        assertEquals(listOf("/Sessions/Playing t1"), awaitReports(1))
        autoAdvance(s)
        assertEquals(listOf("/Sessions/Playing t1", "/Sessions/Playing/Stopped t1", "/Sessions/Playing t2"), awaitReports(3))
        // The full track as the Stopped position: scrobbling plugins count it as played.
        assertEquals(80_000_000L, Json.parseToJsonElement(reports[1].body!!.utf8()).jsonObject["PositionTicks"]!!.jsonPrimitive.content.toLong())
        assertEquals(1, s.queue.index)
        assertEquals("t2", s.current?.id)
        // The window moved on: the played item is gone, the current one first.
        assertEquals(listOf("t2", "t3"), (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId })
        s.release()
    }

    @Test
    fun audioAttributesAreMusicOnlyWhileTheSessionLives() {
        player.setAudioAttributes(audioAttributes(music = false), false)
        val s = MusicSession(api(), player, album)
        s.load()
        assertEquals(C.AUDIO_CONTENT_TYPE_MUSIC, player.audioAttributes.contentType)
        s.release()
        assertEquals(C.AUDIO_CONTENT_TYPE_MOVIE, player.audioAttributes.contentType)
    }

    @Test
    fun theGainFollowsEachTrackPlusThePreamp() {
        MusicGain.preampDb = 2.0
        val s = MusicSession(api(), player, album)
        s.load()
        assertEquals(-1.0f, AudioFx.musicGainDb, 0.001f)
        autoAdvance(s)
        assertEquals(-4.5f, AudioFx.musicGainDb, 0.001f)
        s.release()
        assertEquals(0f, AudioFx.musicGainDb)
        // Emby sends no NormalizationGain: 0 dB (preamp 0).
        MusicGain.preampDb = 0.0
        val emby = MusicSession(api("emby"), player, listOf(track(1), track(2)))
        emby.load()
        assertEquals(0f, AudioFx.musicGainDb)
        emby.release()
    }

    @Test
    fun gainRulesAndClipping() {
        assertEquals(-5.0, MusicGain.db(-3.0, -5.0, GainMode.Album, 0.0), 0.0)
        assertEquals(-3.0, MusicGain.db(-3.0, null, GainMode.Album, 0.0), 0.0)
        assertEquals(-1.0, MusicGain.db(-3.0, -5.0, GainMode.Track, 2.0), 0.0)
        assertEquals(0.0, MusicGain.db(-3.0, -5.0, GainMode.Off, 2.0), 0.0)
        assertEquals(MusicGain.MAX_DB, MusicGain.db(20.0, null, GainMode.Track, 6.0), 0.0)
        assertEquals(MusicGain.MIN_DB, MusicGain.db(-40.0, null, GainMode.Track, 0.0), 0.0)
        // +6 dB on a 0.9 peak: the limiter holds it under the ceiling when clipping is prevented, not otherwise.
        val clipped = FloatArray(2) { 0.9f }
        AudioFxChain(44_100, 2).process(clipped, 1, AudioFx.Config(), 6f, clip = true)
        assertTrue(clipped.all { it <= AudioFxChain.CEILING })
        val raw = FloatArray(2) { 0.9f }
        AudioFxChain(44_100, 2).process(raw, 1, AudioFx.Config(), 6f, clip = false)
        assertEquals(0.9f * 1.9953f, raw[0], 0.001f)
    }

    @Test
    fun aDownloadedTrackPlaysFromItsFile() {
        val file = Uri.parse("file:///data/downloads/t2.wav")
        val s = MusicSession(api(), player, album, local = { id -> if (id == "t2") LocalMedia(track(2), file) else null })
        s.load()
        assertEquals(file, player.getMediaItemAt(1).localConfiguration!!.uri)
        assertTrue(player.getMediaItemAt(0).localConfiguration!!.uri.toString().startsWith("http"))
        s.release()
    }

    @Test
    fun repeatOneKeepsTheTrackAndNextStillMovesOn() {
        val s = MusicSession(api(), player, album)
        s.load()
        s.cycleRepeat()
        s.cycleRepeat()
        assertEquals(Repeat.One, s.queue.repeat)
        assertEquals(listOf("t1", "t1", "t1"), (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId })
        s.next()
        assertEquals("t2", s.current?.id)
        assertEquals(listOf("t2", "t2", "t2"), (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId })
        s.release()
    }
}
