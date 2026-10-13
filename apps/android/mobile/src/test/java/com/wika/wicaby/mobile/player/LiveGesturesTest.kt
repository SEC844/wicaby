package com.wika.wicaby.mobile.player

import org.junit.Assert.assertEquals
import org.junit.Test

class LiveGesturesTest {
    @Test
    fun swipeCommitsPastAQuarterOrOnAFling() {
        assertEquals(1, zapSwipe(-300f, 1000f, 0f)) // left past 25 %: next
        assertEquals(-1, zapSwipe(260f, 1000f, 0f)) // right past 25 %: previous
        assertEquals(0, zapSwipe(-200f, 1000f, -500f)) // short and slow: snap back
        assertEquals(1, zapSwipe(-80f, 1000f, -1_500f)) // short fling left
        assertEquals(0, zapSwipe(-80f, 1000f, 1_500f)) // fling against the drag
        assertEquals(0, zapSwipe(0f, 1000f, 2_000f))
    }
}
