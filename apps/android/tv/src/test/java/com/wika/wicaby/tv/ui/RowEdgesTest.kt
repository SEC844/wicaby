package com.wika.wicaby.tv.ui

import androidx.compose.foundation.focusGroup
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.focusProperties
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// The D-pad at a row's ends (a reported bug: RIGHT on the last card jumped to the row above or the tab bar).
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@OptIn(ExperimentalComposeUiApi::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
class RowEdgesTest {
    @get:Rule
    val rule = createComposeRule()

    private fun cell(tag: String) = Modifier.size(40.dp).testTag(tag).focusable()

    private fun press(key: Key) = rule.onRoot().performKeyInput { pressKey(key) }

    @Test
    fun theEndsOfARowAreDeadEnds() {
        rule.setContent {
            Column {
                // What the 2D search would jump to: a tab bar to the right, above.
                Row { Box(Modifier.size(40.dp)); Box(Modifier.size(40.dp)); Box(Modifier.size(40.dp)); Box(cell("tab")) }
                Row { Box(cell("left")); LazyRow(Modifier.dpadEdges()) { items(3) { Box(cell("r$it")) } } }
            }
        }
        rule.onNodeWithTag("r2").requestFocus()
        press(Key.DirectionRight)
        rule.onNodeWithTag("r2").assertIsFocused()
        press(Key.DirectionLeft)
        press(Key.DirectionLeft)
        rule.onNodeWithTag("r0").assertIsFocused()
        press(Key.DirectionLeft)
        rule.onNodeWithTag("r0").assertIsFocused()
        // Up still leaves the row.
        press(Key.DirectionUp)
        rule.onNodeWithTag("r0").assertIsNotFocused()
    }

    @Test
    fun aGridKeepsItsRightEdgeAndCanLetLeftThrough() {
        rule.setContent {
            Column {
                Row { Box(Modifier.size(40.dp)); Box(Modifier.size(40.dp)); Box(Modifier.size(40.dp)); Box(cell("tab")) }
                Row {
                    Box(cell("rail"))
                    LazyVerticalGrid(GridCells.Fixed(2), Modifier.size(80.dp, 200.dp).dpadEdges(left = false)) { items(4) { Box(cell("g$it")) } }
                }
            }
        }
        rule.onNodeWithTag("g1").requestFocus()
        press(Key.DirectionRight)
        rule.onNodeWithTag("g1").assertIsFocused()
        rule.onNodeWithTag("g2").requestFocus()
        press(Key.DirectionLeft)
        rule.onNodeWithTag("rail").assertIsFocused()
    }


    // As in the app (Main.kt): the tab content sits in a focus group with its own exit rule and focusRestorer, the tab bar
    // outside it. Without that box's own focusGroup() its properties replaced the grid's exit rule (the reported bug).
    @Test
    fun aGridInsideTheTabContentKeepsItsRightEdge() {
        rule.setContent {
            Column {
                Row { Box(Modifier.size(40.dp)); Box(Modifier.size(40.dp)); Box(Modifier.size(40.dp)); Box(cell("tab")) }
                Box(
                    Modifier.size(200.dp)
                        .focusProperties {
                            @Suppress("DEPRECATION")
                            exit = { androidx.compose.ui.focus.FocusRequester.Default }
                        }
                        .focusRestorer()
                        .focusGroup(),
                ) {
                    LazyVerticalGrid(GridCells.Fixed(2), Modifier.size(80.dp, 200.dp).dpadEdges()) { items(4) { Box(cell("g$it")) } }
                }
            }
        }
        rule.onNodeWithTag("g1").requestFocus()
        press(Key.DirectionRight)
        rule.onNodeWithTag("g1").assertIsFocused()
    }

    // Detail.kt: the page provides HeroSpec (vertical scroll); a horizontal row under it must provide its own EdgeSpec,
    // or HeroSpec shifts the row by the page's small vertical offset whenever focus lands on a visible season (review POLISH).
    @Test
    fun aRowOnTheHeroPageKeepsTheFocusedCardInView() {
        rule.setContent {
            val page = rememberScrollState()
            val margin = with(LocalDensity.current) { 56.dp.toPx() }
            CompositionLocalProvider(LocalBringIntoViewSpec provides HeroSpec(page, margin)) {
                Column(Modifier.size(400.dp).verticalScroll(page)) {
                    // The seasons row sits just below the first screen: the page scrolls only a little to show it.
                    Box(Modifier.height(300.dp))
                    CompositionLocalProvider(LocalBringIntoViewSpec provides EdgeSpec(margin)) {
                        LazyRow(Modifier.width(400.dp).dpadEdges()) { items(12) { Box(Modifier.size(80.dp).testTag("s$it").focusable()) } }
                    }
                    Box(Modifier.height(300.dp))
                }
            }
        }
        rule.onNodeWithTag("s0").requestFocus()
        repeat(8) { press(Key.DirectionRight) }
        rule.onNodeWithTag("s8").assertIsFocused().assertIsDisplayed()
        val before = rule.onNodeWithTag("s8").fetchSemanticsNode().boundsInRoot.left
        // s7 is already clear of the edges: the row must not move.
        press(Key.DirectionLeft)
        rule.onNodeWithTag("s7").assertIsFocused().assertIsDisplayed()
        assertEquals(before, rule.onNodeWithTag("s8").fetchSemanticsNode().boundsInRoot.left, 0.5f)
    }

    // Guard for the screen itself: every LazyRow on the Detail page sits under its own EdgeSpec.
    @Test
    fun everyDetailRowHasItsOwnEdgeSpec() {
        val src = java.io.File("src/main/java/com/wika/wicaby/tv/ui/Detail.kt").readText()
        val rows = src.split("LazyRow(").size - 1
        val guarded = Regex("""EdgeSpec\(margin\) \}\) \{\s+LazyRow\(""").findAll(src).count()
        assertEquals(3, rows) // seasons, episodes, Bonus
        assertEquals(rows, guarded)
    }
}
