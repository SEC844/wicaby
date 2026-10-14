package com.wika.wicaby.tv.music

import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import androidx.media3.exoplayer.ExoPlayer
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Profile
import com.wika.wicaby.core.data.Session
import com.wika.wicaby.core.data.SessionGate
import com.wika.wicaby.core.data.Snapshot
import com.wika.wicaby.tv.dreamApi
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.data.UserData
import com.wika.wicaby.core.music.Lrc
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.Nav
import com.wika.wicaby.tv.Route
import com.wika.wicaby.tv.play
import com.wika.wicaby.tv.playRemote
import com.wika.wicaby.core.player.RemotePlay
import com.wika.wicaby.tv.player.PlayerActivity
import com.wika.wicaby.tv.playsAsMusic
import com.wika.wicaby.tv.ui.Accents
import com.wika.wicaby.tv.ui.Cache
import com.wika.wicaby.tv.ui.LibraryTab
import com.wika.wicaby.tv.ui.Screensaver
import com.wika.wicaby.tv.ui.WicabyTheme
import com.wika.wicaby.tv.ui.route
import com.wika.wicaby.tv.ui.tabViews
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper
import java.util.concurrent.TimeUnit

// Music spec MU-09 AC1-AC4: the music library's tab and its rows, the album page's D-pad (Enter on track 3 starts the
// session at index 2), Back from now playing back on the album page with the session playing, no FLAG_KEEP_SCREEN_ON,
// ambient after 2 min idle and back on any key, the screensaver (what Dream composes) showing the ambient layout, the
// queue's edit mode (move, remove) never losing focus, and audio resume. A fake server answers the catalogue; its
// streams never answer (the player stays buffering, playWhenReady set: nothing decodes, nothing sounds).
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-w960dp-h540dp-land-mdpi")
class MusicTvTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private lateinit var server: MockWebServer
    private lateinit var api: Api
    private val app get() = RuntimeEnvironment.getApplication()

    private fun json(n: Int) =
        """{"Id":"t$n","Name":"Titre $n","Type":"Audio","MediaType":"Audio","AlbumId":"alb","Album":"Album test","AlbumArtist":"Groupe test",""" +
            """"Artists":["Groupe test"],"IndexNumber":$n,"ParentIndexNumber":1,"RunTimeTicks":80000000}"""

    private fun list(vararg items: String) = """{"Items":[${items.joinToString(",")}],"TotalRecordCount":${items.size}}"""

    private val tracks = (1..5).map { Item("t$it", "Titre $it", "Audio", mediaType = "Audio", albumId = "alb", album = "Album test", artists = listOf("Groupe test"), indexNumber = it) }

    @Before
    fun setUp() {
        Cache.map.clear()
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val url = request.url
                val path = url.encodedPath
                val body = when {
                    path.startsWith("/Items/t") -> json(path.removePrefix("/Items/t").toInt())
                    path == "/Items/v1" -> """{"Id":"v1","Name":"Film test","Type":"Movie","MediaType":"Video"}"""
                    else -> when (path) {
                    "/Items/alb" -> """{"Id":"alb","Name":"Album test","Type":"MusicAlbum","IsFolder":true,"AlbumArtist":"Groupe test","AlbumArtists":[{"Id":"ar1","Name":"Groupe test"}],"ProductionYear":2020}"""
                    "/Items/ar1" -> """{"Id":"ar1","Name":"Groupe test","Type":"MusicArtist"}"""
                    "/Items/ar1/Similar" -> list("""{"Id":"ar2","Name":"Voisin un","Type":"MusicArtist"}""", """{"Id":"ar3","Name":"Voisin deux","Type":"MusicArtist"}""")
                    "/Artists/AlbumArtists" -> list("""{"Id":"ar1","Name":"Groupe test","Type":"MusicArtist"}""")
                    "/Genres" -> list("""{"Id":"g1","Name":"Genre test","Type":"MusicGenre"}""")
                    "/Items" -> when (url.queryParameter("IncludeItemTypes")) {
                        "MusicAlbum" -> list(
                            """{"Id":"alb","Name":"Album test","Type":"MusicAlbum","IsFolder":true}""",
                            """{"Id":"alb2","Name":"Autre album","Type":"MusicAlbum","IsFolder":true}""",
                            """{"Id":"alb3","Name":"Dernier album","Type":"MusicAlbum","IsFolder":true}""",
                        )
                        "Playlist" -> list(
                            """{"Id":"pl1","Name":"Liste test","Type":"Playlist","MediaType":"Audio","IsFolder":true}""",
                            """{"Id":"pl2","Name":"Liste video","Type":"Playlist","MediaType":"Video","IsFolder":true}""",
                        )
                        else -> if (url.queryParameter("Filters") == "IsPlayed") list(json(4)) else {
                            val wanted = url.queryParameter("Ids")?.split(",")?.map { it.removePrefix("t").toInt() } ?: (1..5).toList()
                            list(*wanted.map(::json).toTypedArray())
                        }
                    }
                    // The streams: headers never come.
                    else -> return if (path.startsWith("/Audio/")) MockResponse.Builder().headersDelay(60, TimeUnit.SECONDS).code(200).build()
                    else MockResponse.Builder().code(204).build()
                    }
                }
                return MockResponse.Builder().code(200).body(body).build()
            }
        }
        server.start()
        api = Api(Server("s1", "Test", server.url("/").toString().trimEnd('/'), "jellyfin"), "tv", "tok", "u1")
    }

    @After
    fun tearDown() {
        Music.release()
        SessionGate.lock()
        Music.testPlayer = null
        Music.lyrics.clear()
        Core.api = null
        server.close()
    }

    private fun press(key: Key) {
        rule.onRoot().performKeyInput { pressKey(key) }
        rule.waitForIdle()
    }

    // NowPlaying tests run the clock by hand (no ambient by surprise): a key, then 200 ms.
    private fun key(k: Key) {
        press(k)
        rule.mainClock.advanceTimeBy(200)
    }

    private fun hold(key: Key) {
        rule.onRoot().performKeyInput {
            keyDown(key)
            advanceEventTime(1_000)
            keyUp(key)
        }
        rule.waitForIdle()
    }

    // The fake server answers on OkHttp's threads; what they resume lands on the paused main looper: run it until [ok].
    private fun waitFor(ok: () -> Boolean) {
        val end = System.currentTimeMillis() + 5_000
        while (!ok()) {
            check(System.currentTimeMillis() < end) { "timed out" }
            Thread.sleep(20)
            ShadowLooper.idleMainLooper()
            rule.mainClock.advanceTimeBy(16)
        }
    }

    // The focused card's left edge: which card of a row has the focus.
    private fun focusedLeft() = rule.onNode(isFocused()).fetchSemanticsNode().boundsInRoot.left

    private fun shown(text: String) = rule.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun theMusicLibraryHasATabOfRows() {
        val music = Item("lib-music", "Musique", "CollectionFolder", collectionType = "music")
        assertTrue(music in tabViews(listOf(Item("lib-pl", "Playlists", "CollectionFolder", collectionType = "playlists"), music)))
        val nav = Nav(mutableStateListOf<Route>(Route.Main))
        rule.setContent {
            WicabyTheme(Accents[0]) { CompositionLocalProvider(LocalNav provides nav) { LibraryTab(api, music) } }
        }
        waitFor { shown("Genre test") && shown("Liste test") && shown("Groupe test") && shown("Titre 4") && shown("Album test") }
        rule.onNodeWithTag("music-home").assertExists()
        for ((tag, title) in listOf(
            "recent-albums" to "Recent albums", "recently-played" to "Recently played", "playlists" to "Playlists", "artists" to "Artists", "genres" to "Genres",
        )) {
            rule.onNodeWithTag("music-row-$tag").assert(hasAnyDescendant(hasText(title)))
        }
        // Only audio playlists.
        assertFalse(shown("Liste video"))
        // An album (or an audio playlist) opens its page.
        assertEquals(Route.MusicAlbum("alb", "Album test"), Item("alb", "Album test", "MusicAlbum", isFolder = true).route())
        assertEquals(Route.MusicAlbum("pl1", "Liste test"), Item("pl1", "Liste test", "Playlist", mediaType = "Audio", isFolder = true).route())
    }

    @Test
    fun enterOnTrackThreeOfTheAlbumPageStartsTheSessionAtIndexTwoAndBackReturnsToIt() {
        Music.testPlayer = ExoPlayer.Builder(app).build()
        val nav = Nav(mutableStateListOf(Route.Main, Route.MusicAlbum("alb", "Album test")))
        rule.setContent {
            WicabyTheme(Accents[0]) { CompositionLocalProvider(LocalNav provides nav) { AlbumScreen(api, "alb", "Album test") } }
        }
        waitFor { shown("Titre 5") }
        rule.mainClock.advanceTimeBy(300)
        rule.onNodeWithTag("music-album-play").assertIsFocused()
        press(Key.DirectionDown)
        rule.onNodeWithTag("music-track-0").assertIsFocused()
        press(Key.DirectionDown)
        press(Key.DirectionDown)
        rule.onNodeWithTag("music-track-2").assertIsFocused()
        press(Key.DirectionCenter)
        waitFor { Music.session != null }
        val s = Music.session!!
        assertEquals(2, s.queue.index)
        assertEquals(listOf("t1", "t2", "t3", "t4", "t5"), s.queue.ids.toList())
        assertEquals("t3", s.player.getMediaItemAt(s.player.currentMediaItemIndex).mediaId)
        assertEquals("Titre 3", s.player.getMediaItemAt(s.player.currentMediaItemIndex).mediaMetadata.title.toString())
        // Now playing opens over the album page.
        assertEquals(MusicActivity::class.java.name, shadowOf(rule.activity).nextStartedActivity.component?.className)
        val now = Robolectric.buildActivity(MusicActivity::class.java).setup().get()
        ShadowLooper.idleMainLooper(500, TimeUnit.MILLISECONDS)
        now.onBackPressedDispatcher.onBackPressed()
        assertTrue(now.isFinishing)
        // Back lands on the album page, focus where it was, the music playing on.
        assertEquals(Route.MusicAlbum("alb", "Album test"), nav.top)
        rule.onNodeWithTag("music-album").assertExists()
        rule.onNodeWithTag("music-track-2").assertIsFocused()
        assertFalse(s.released)
        assertTrue(s.player.playWhenReady)
        assertEquals("t3", s.queue.id)
    }

    // Music spec C4/C7 rows on the D-pad: ↓ past the last track reaches "More from", which remembers its card when
    // focus leaves up and comes back; the artist page's "Similar artists" row the same, below the albums.
    @Test
    fun theMoreFromRowIsReachedBelowTheTracksAndKeepsItsCard() {
        val nav = Nav(mutableStateListOf(Route.Main, Route.MusicAlbum("alb", "Album test")))
        rule.setContent {
            WicabyTheme(Accents[0]) { CompositionLocalProvider(LocalNav provides nav) { AlbumScreen(api, "alb", "Album test") } }
        }
        waitFor { shown("Titre 5") && shown("Dernier album") }
        rule.mainClock.advanceTimeBy(300)
        rule.onNodeWithTag("music-album-play").assertIsFocused()
        repeat(5) { press(Key.DirectionDown) }
        rule.onNodeWithTag("music-track-4").assertIsFocused()
        press(Key.DirectionDown)
        rule.onNodeWithTag("music-album-more-from").assert(hasAnyDescendant(isFocused()))
        // The current album is not in it.
        rule.onNodeWithTag("music-album-more-from").assert(hasAnyDescendant(hasText("Album test")).not())
        // The first card (Left stops at the row's start), then the second.
        press(Key.DirectionLeft)
        val first = focusedLeft()
        press(Key.DirectionRight)
        val second = focusedLeft()
        assertTrue(second > first)
        press(Key.DirectionUp)
        rule.onNodeWithTag("music-track-4").assertIsFocused()
        press(Key.DirectionDown)
        assertEquals(second, focusedLeft())
    }

    @Test
    fun theSimilarArtistsRowIsReachedBelowTheAlbumsAndKeepsItsCard() {
        val nav = Nav(mutableStateListOf(Route.Main, Route.MusicArtist("ar1", "Groupe test")))
        rule.setContent {
            WicabyTheme(Accents[0]) { CompositionLocalProvider(LocalNav provides nav) { ArtistScreen(api, "ar1", "Groupe test") } }
        }
        waitFor { shown("Dernier album") && shown("Voisin deux") }
        rule.mainClock.advanceTimeBy(300)
        rule.onNodeWithTag("music-artist-play").assertIsFocused()
        press(Key.DirectionDown)
        rule.onNodeWithTag("music-artist-albums").assert(hasAnyDescendant(isFocused()))
        press(Key.DirectionDown)
        rule.onNodeWithTag("music-artist-similar").assert(hasAnyDescendant(isFocused()))
        // The first card (Left stops at the row's start), then the second.
        press(Key.DirectionLeft)
        val first = focusedLeft()
        press(Key.DirectionRight)
        val second = focusedLeft()
        assertTrue(second > first)
        press(Key.DirectionUp)
        rule.onNodeWithTag("music-artist-albums").assert(hasAnyDescendant(isFocused()))
        press(Key.DirectionDown)
        assertEquals(second, focusedLeft())
        // OK opens the similar artist's page.
        press(Key.DirectionCenter)
        assertEquals(Route.MusicArtist("ar3", "Voisin deux"), nav.top)
    }

    @Test
    fun backFromNowPlayingKeepsPlayingAndNeverHoldsTheScreenOn() {
        Music.start(app, api, tracks, 2, player = ExoPlayer.Builder(app).build())
        ShadowLooper.idleMainLooper()
        val activity = Robolectric.buildActivity(MusicActivity::class.java).setup().get()
        ShadowLooper.idleMainLooper(500, TimeUnit.MILLISECONDS)
        assertEquals(0, activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        assertFalse(activity.window.decorView.keepScreenOn)
        assertTrue(Music.session!!.player.playWhenReady)
        activity.onBackPressedDispatcher.onBackPressed()
        assertTrue(activity.isFinishing)
        val s = Music.session
        assertNotNull(s)
        s!!
        assertFalse(s.released)
        assertTrue(s.player.playWhenReady)
        assertEquals("t3", s.queue.id)
    }

    // At 960x540dp (a 1080p TV) the art leaves the controls row its full width: no squashed button.
    @Test
    fun controlsKeepTheirSizeNextToTheArt() {
        val s = Music.start(app, api, tracks, 0, player = ExoPlayer.Builder(app).build())
        rule.setContent { WicabyTheme(Accents[0]) { NowPlaying(s) } }
        rule.waitForIdle()
        rule.onNodeWithTag("music-play").assertWidthIsEqualTo(56.dp)
        rule.onNodeWithTag("music-lyrics-toggle").assertWidthIsEqualTo(44.dp).assertHeightIsEqualTo(44.dp)
    }

    @Test
    fun ambientAfterTwoIdleMinutesAndBackOnAnyKey() {
        val s = Music.start(app, api, tracks, 0, player = ExoPlayer.Builder(app).build())
        rule.mainClock.autoAdvance = false
        rule.setContent { WicabyTheme(Accents[0]) { NowPlaying(s) } }
        rule.mainClock.advanceTimeBy(1_000)
        rule.onNodeWithTag("music-play").assertIsFocused()
        rule.onNodeWithTag("music-ambient").assertDoesNotExist()
        rule.mainClock.advanceTimeBy(AMBIENT_AFTER_MS - 2_000)
        rule.onNodeWithTag("music-ambient").assertDoesNotExist()
        rule.mainClock.advanceTimeBy(3_000)
        rule.onNodeWithTag("music-ambient").assertExists()
        // Any key only brings the screen back: Play/Pause does not pause.
        press(Key.MediaPlayPause)
        rule.mainClock.advanceTimeBy(1_000)
        rule.onNodeWithTag("music-ambient").assertDoesNotExist()
        assertTrue(s.player.playWhenReady)
        rule.onNodeWithTag("music-play").assertIsFocused()
        // Out of ambient, the remote's Play/Pause toggles the session.
        press(Key.MediaPlayPause)
        assertFalse(s.player.playWhenReady)
        press(Key.MediaPlayPause)
        assertTrue(s.player.playWhenReady)
    }

    @Test
    fun ambientLyricLineFollowsThePosition() {
        val synced = Lrc.parse(listOf("[00:01.00]Ligne 1", "[00:02.00]Ligne 2", "[00:03.00]").joinToString("\n"))
        assertEquals(null, currentLine(synced, 500))
        assertEquals("Ligne 1", currentLine(synced, 1_500))
        assertEquals("Ligne 2", currentLine(synced, 2_999))
        assertEquals(null, currentLine(synced, 3_500)) // an empty stamped line is a pause
        assertEquals(1, currentIndex(synced, 2_000))
        assertEquals(null, currentLine(Lrc.parse("Sans temps"), 10_000))
    }

    @Test
    fun screensaverShowsTheAmbientLayoutWhileMusicPlays() {
        Music.start(app, api, tracks, 1, player = ExoPlayer.Builder(app).build())
        rule.mainClock.autoAdvance = false
        // Dream composes Screensaver(api): the same layout as the system screensaver.
        rule.setContent { WicabyTheme(Accents[0]) { Screensaver(api) } }
        rule.mainClock.advanceTimeBy(500)
        rule.onNodeWithTag("music-ambient").assertExists()
        rule.onNodeWithText("Titre 2").assertExists()
    }

    // TP-10 and §4.7: the screensaver (Dream: dreamApi, in-app: LocalApi) shows the music only for the account the gate
    // opened and only while it plays; "Who is watching?" (sign out, switch user) ends the session.
    @Test
    fun ambientOnlyForTheOpenAccountWhileItPlays() {
        val s = Music.start(app, api, tracks, 0, player = ExoPlayer.Builder(app).build())
        val kid = Session(api.server, "u1", "Kid", "tok")
        val snap = Snapshot("tv", api.server, kid, 0, 0, 0, profiles = listOf(Profile(kid, hasPin = true)))
        assertNull(Music.ambient(dreamApi(snap)))
        SessionGate.unlock(kid)
        assertSame(s, Music.ambient(dreamApi(snap)))
        assertNull(Music.ambient(Api(api.server, "tv", "tok2", "u2")))
        s.playPause()
        ShadowLooper.idleMainLooper()
        assertNull(Music.ambient(api))
        s.playPause()
        ShadowLooper.idleMainLooper()
        assertSame(s, Music.ambient(api))
        Nav(mutableStateListOf<Route>(Route.Main)).reset(Route.Login(api.server))
        assertNull(SessionGate.active(kid))
        assertNull(Music.session)
        assertTrue(s.released)
        assertNull(Music.ambient(api))
    }

    // Spec §4.7: "Déplacer" with the arrows in an edit mode; held OK opens it, OK closes it, focus follows the entry.
    @Test
    fun theQueueEditModeMovesTheFocusedEntry() {
        val s = Music.start(app, api, tracks, 0, player = ExoPlayer.Builder(app).build())
        rule.mainClock.autoAdvance = false
        rule.setContent { WicabyTheme(Accents[0]) { NowPlaying(s) } }
        rule.mainClock.advanceTimeBy(500)
        rule.onNodeWithTag("music-queue-1").requestFocus()
        hold(Key.DirectionCenter)
        rule.mainClock.advanceTimeBy(200)
        // Holding OK neither jumped nor removed: edit mode, the hint shown.
        assertEquals(0, s.queue.index)
        assertEquals(5, s.queue.ids.size)
        rule.onNodeWithText("move", substring = true).assertExists()
        key(Key.DirectionDown)
        assertEquals(listOf("t1", "t3", "t2", "t4", "t5"), s.queue.ids.toList())
        rule.onNodeWithTag("music-queue-2").assertIsFocused()
        key(Key.DirectionRight)
        assertEquals(listOf("t1", "t3", "t4", "t2", "t5"), s.queue.ids.toList())
        rule.onNodeWithTag("music-queue-3").assertIsFocused()
        key(Key.DirectionUp)
        assertEquals(listOf("t1", "t3", "t2", "t4", "t5"), s.queue.ids.toList())
        rule.onNodeWithTag("music-queue-2").assertIsFocused()
        // OK is done (no jump); the arrows browse again.
        key(Key.DirectionCenter)
        assertEquals(0, s.queue.index)
        rule.onNodeWithText("move", substring = true).assertDoesNotExist()
        key(Key.DirectionRight)
        rule.onNodeWithTag("music-queue-3").assertIsFocused()
        assertEquals(listOf("t1", "t3", "t2", "t4", "t5"), s.queue.ids.toList())
    }

    // Removing the focused entry hands focus to its neighbour, down to a queue of one (the row stays).
    @Test
    fun removingAQueueEntryKeepsTheFocusOnTheRow() {
        val s = Music.start(app, api, tracks.take(3), 0, player = ExoPlayer.Builder(app).build())
        rule.mainClock.autoAdvance = false
        rule.setContent { WicabyTheme(Accents[0]) { NowPlaying(s) } }
        rule.mainClock.advanceTimeBy(500)
        rule.onNodeWithTag("music-queue-1").requestFocus()
        // Held OK opens edit mode, held OK again removes.
        hold(Key.DirectionCenter)
        rule.mainClock.advanceTimeBy(200)
        hold(Key.DirectionCenter)
        rule.mainClock.advanceTimeBy(200)
        assertEquals(listOf("t1", "t3"), s.queue.ids.toList())
        rule.mainClock.advanceTimeBy(100)
        rule.onNodeWithTag("music-queue-1").assertIsFocused()
        // The last entry: focus goes to the one before it. Menu opens edit mode and removes too.
        key(Key.Menu)
        key(Key.Menu)
        assertEquals(listOf("t1"), s.queue.ids.toList())
        rule.mainClock.advanceTimeBy(100)
        rule.onNodeWithTag("music-queue-0").assertIsFocused()
        assertFalse(s.released)
    }

    // Plain lyrics scroll with the D-pad once their column has focus.
    @Test
    fun plainLyricsScrollWithTheDpad() {
        Music.lyrics["t1"] = Lrc.parse((1..80).joinToString("\n") { "Ligne $it" })
        val s = Music.start(app, api, tracks, 0, player = ExoPlayer.Builder(app).build())
        rule.mainClock.autoAdvance = false
        rule.setContent { WicabyTheme(Accents[0]) { NowPlaying(s) } }
        rule.mainClock.advanceTimeBy(500)
        rule.onNodeWithTag("music-lyrics-toggle").requestFocus()
        key(Key.DirectionCenter)
        rule.mainClock.advanceTimeBy(500)
        rule.onNodeWithText("Ligne 1").assertExists()
        rule.onNodeWithTag("music-lyrics").requestFocus()
        rule.onNodeWithTag("music-lyrics").assertIsFocused()
        repeat(6) { key(Key.DirectionDown) }
        rule.mainClock.advanceTimeBy(1_000)
        rule.onNodeWithTag("music-lyrics").assertIsFocused()
        rule.onNodeWithText("Ligne 1").assertIsNotDisplayed()
    }

    // A track resumes where it stopped in the music session (play(): resume setting, then MU-09); an audiobook is no
    // music track and keeps the player.
    @Test
    fun aTrackResumesInTheMusicSessionAndAnAudiobookKeepsThePlayer() {
        Music.testPlayer = ExoPlayer.Builder(app).build()
        Core.api = api
        val book = Item("b1", "Livre", "AudioBook", mediaType = "Audio")
        assertTrue(book.isAudio)
        assertFalse(book.playsAsMusic)
        play(rule.activity, book)
        assertEquals(PlayerActivity::class.java.name, shadowOf(rule.activity).nextStartedActivity.component?.className)
        val track = tracks[3].copy(runTimeTicks = 6_000_000_000L, userData = UserData(playbackPositionTicks = 1_200_000_000L))
        assertEquals(120_000L, track.resumeMs)
        play(rule.activity, track)
        waitFor { Music.session != null }
        val s = Music.session!!
        assertEquals("t4", s.queue.id)
        assertEquals(120_000L, s.player.currentPosition)
        assertEquals(MusicActivity::class.java.name, shadowOf(rule.activity).nextStartedActivity.component?.className)
    }

    // A server's remote Play of a track (its queue's tracks with it) goes to the music session at the asked position;
    // of anything else, to the player.
    @Test
    fun aRemotePlayOfATrackStartsTheMusicSession() {
        Music.testPlayer = ExoPlayer.Builder(app).build()
        Core.api = api
        assertTrue(playRemote(rule.activity, RemotePlay("t2", 5_000, null, null, null, queue = listOf("t1", "t2", "t3"))))
        waitFor { Music.session != null }
        val s = Music.session!!
        assertEquals(listOf("t1", "t2", "t3"), s.queue.ids.toList())
        assertEquals(1, s.queue.index)
        assertEquals(5_000L, s.player.currentPosition)
        assertEquals(MusicActivity::class.java.name, shadowOf(rule.activity).nextStartedActivity.component?.className)
        playRemote(rule.activity, RemotePlay("v1", null, null, null, null))
        waitFor { shadowOf(rule.activity).peekNextStartedActivity() != null }
        assertEquals(PlayerActivity::class.java.name, shadowOf(rule.activity).nextStartedActivity.component?.className)
    }
}
