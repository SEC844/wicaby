package com.wika.wicaby.mobile.music

import android.app.Application
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.media3.exoplayer.ExoPlayer
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Server
import com.wika.wicaby.core.music.Lrc
import com.wika.wicaby.core.music.MusicSession
import com.wika.wicaby.mobile.player.PlayerHolder
import com.wika.wicaby.mobile.ui.Accents
import com.wika.wicaby.mobile.ui.Cache
import com.wika.wicaby.mobile.ui.LibrariesRoute
import com.wika.wicaby.mobile.ui.LibrariesScreen
import com.wika.wicaby.mobile.ui.WicabyTheme
import com.wika.wicaby.mobile.ui.contentDestinations
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

// Music spec MU-08 AC1-AC6 under Robolectric: a canned server (FakeApi, nothing is contacted) and a real ExoPlayer that
// is never prepared, so nothing decodes and nothing sounds.
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "en")
class MusicUiTest {
    @get:Rule
    val rule = createComposeRule()

    // The music fixture's shape (tools/mock-server/music-fixture.mjs): invented names only.
    private class FakeApi : Api(Server("srv", "Mock", "http://127.0.0.1:9", "jellyfin"), "dev", "tok", "u1") {
        val asked = mutableListOf<String>()

        private fun track(n: Int, disc: Int) =
            """{"Id":"t$disc$n","Name":"Piste $disc.$n","Type":"Audio","AlbumId":"alb2","Album":"Deux disques","Artists":["Ensemble test"],"IndexNumber":$n,"ParentIndexNumber":$disc,"RunTimeTicks":60000000}"""

        override suspend fun raw(method: String, path: String, body: String?, vararg query: Pair<String, Any?>): String {
            val q = query.associate { it.first to it.second?.toString() }
            asked += "$method $path ${q["IncludeItemTypes"] ?: ""}"
            return when {
                path == "/UserViews" -> """{"Items":[{"Id":"lib-movies","Name":"Films","CollectionType":"movies","Type":"CollectionFolder"},{"Id":"lib-music","Name":"Musique","CollectionType":"music","Type":"CollectionFolder"}]}"""
                path == "/Items/alb2" -> """{"Id":"alb2","Name":"Deux disques","Type":"MusicAlbum","IsFolder":true,"AlbumArtist":"Ensemble test"}"""
                path == "/Items" && q["IncludeItemTypes"] == "MusicAlbum" -> """{"Items":[{"Id":"alb2","Name":"Deux disques","Type":"MusicAlbum","IsFolder":true}],"TotalRecordCount":1}"""
                path == "/Items" && q["ParentId"] == "alb2" -> """{"Items":[${(1..3).map { track(it, 1) }.plus((1..3).map { track(it, 2) }).joinToString(",")}],"TotalRecordCount":6}"""
                path.startsWith("/Sessions/") -> ""
                else -> """{"Items":[],"TotalRecordCount":0}"""
            }
        }
    }

    private val api = FakeApi()
    private val songs = (1..8).map { Item("s$it", "Song $it", "Audio", artists = listOf("Test band"), runTimeTicks = 60_000_000L) }

    @Before
    fun setUp() = Cache.map.clear()

    @After
    fun tearDown() {
        PlayerHolder.music?.let { it.release(); it.player.release() }
        PlayerHolder.music = null
    }

    private fun session(): MusicSession {
        val s = MusicSession(api, ExoPlayer.Builder(RuntimeEnvironment.getApplication()).build(), songs, onReleased = { PlayerHolder.music = null })
        s.load()
        return s
    }

    @Test
    fun theMusicLibraryIsListedAndOpensWithFiveTabs() {
        rule.setContent {
            WicabyTheme(Accents[0]) {
                val nav = rememberNavController()
                NavHost(nav, LibrariesRoute) {
                    composable<LibrariesRoute> { LibrariesScreen(api, nav) }
                    contentDestinations(api, nav)
                }
            }
        }
        rule.waitUntilAtLeastOneExists(hasText("Musique"), 5_000)
        rule.onNodeWithText("Musique").performClick()
        for (tab in listOf("Albums", "Artists", "Songs", "Genres", "Playlists")) rule.waitUntilAtLeastOneExists(hasText(tab), 5_000)
        rule.waitUntilAtLeastOneExists(hasText("Deux disques"), 5_000)
    }

    @Test
    fun aTwoDiscAlbumShowsDiscHeaders() {
        rule.setContent {
            WicabyTheme(Accents[0]) {
                MusicItemScreen(api, MusicRoute("alb2", "MusicAlbum", "Deux disques"), rememberNavController())
            }
        }
        rule.waitUntilAtLeastOneExists(hasScrollToNodeAction(), 5_000)
        // The list is lazy: scrolled to each header in turn.
        val list = rule.onNode(hasScrollToNodeAction())
        for (text in listOf("Disc 1", "Piste 1.3", "Disc 2", "Piste 2.3")) list.performScrollToNode(hasText(text))
        rule.onNodeWithText("Disc 2").assertExists()
    }

    @Test
    fun theMiniPlayerFollowsTheSession() {
        rule.setContent { WicabyTheme(Accents[0]) { MiniPlayerSlot() } }
        rule.onNodeWithText("Song 1").assertDoesNotExist()
        val s = session()
        PlayerHolder.music = s
        rule.waitUntilAtLeastOneExists(hasText("Song 1"), 5_000)
        rule.runOnIdle { s.release() }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("Song 1").fetchSemanticsNodes().isEmpty() }
        s.player.release()
    }

    @Test
    fun queueDragMovesAndSwipeRemoves() {
        val moves = mutableListOf<Pair<Int, Int>>()
        val removed = mutableListOf<Int>()
        rule.setContent {
            WicabyTheme(Accents[0]) {
                QueueList(api, songs.map { it.id }, 0, songs.associateBy { it.id }, onJump = {}, onMove = { a, b -> moves += a to b }, onRemove = { removed += it })
            }
        }
        val row = with(rule.density) { 56.dp.toPx() }
        rule.onNodeWithText("Song 6").performTouchInput {
            down(center)
            advanceEventTime(1_000)
            repeat(6) { moveBy(Offset(0f, -row / 2)) }
            up()
        }
        rule.runOnIdle { assertEquals(listOf(5 to 2), moves) }
        rule.onNodeWithText("Song 4").performTouchInput { swipeLeft() }
        rule.runOnIdle { assertEquals(listOf(3), removed) }
    }

    @Test
    fun lyricsHighlightTheLineAtThePosition() {
        val lyrics = Lrc.parse("[00:01.00]Line 1\n[00:02.00]Line 2\n[00:03.00]Line 3")
        rule.setContent { WicabyTheme(Accents[0]) { LyricsPane(lyrics, positionMs = 2_500, onSeek = {}) } }
        rule.onNodeWithText("Line 2").assertIsSelected()
        rule.onNodeWithText("Line 1").assertIsNotSelected()
        rule.onNodeWithText("Line 3").assertIsNotSelected()
    }

    @Test
    fun everyPlayerControlIsLabelled() {
        val s = session()
        rule.setContent { WicabyTheme(Accents[0]) { NowPlayingScreen(s) {}; MiniPlayer(s) {} } }
        rule.waitUntilAtLeastOneExists(hasText("Song 1"), 5_000)
        val unlabelled = rule.onAllNodes(hasClickAction() and SemanticsMatcher("no label") { n ->
            SemanticsProperties.ContentDescription !in n.config && SemanticsProperties.Text !in n.config &&
                n.children.none { c -> SemanticsProperties.ContentDescription in c.config || SemanticsProperties.Text in c.config }
        }).fetchSemanticsNodes()
        assertTrue("controls without a label: ${unlabelled.map { it.config }}", unlabelled.isEmpty())
        // The seek bar is announced too.
        rule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress) and SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("Position"))).assertExists()
        s.release()
        s.player.release()
    }
}

private val Int.dp get() = androidx.compose.ui.unit.Dp(this.toFloat())
