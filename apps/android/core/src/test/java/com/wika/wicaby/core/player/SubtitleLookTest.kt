package com.wika.wicaby.core.player

import org.junit.Assert.assertEquals
import org.junit.Test

class SubtitleLookTest {
    @Test fun assUntouchedWhenOverrideOff() {
        SubtitleLook.SIZES.indices.forEach { assertEquals(1f, SubtitleLook.assFontScale(it, overrideAss = false), 0f) }
        assertEquals(1.5f, SubtitleLook.assFontScale(3, overrideAss = true), 0f)
    }

    @Test fun positionRaisesFromTheDefaultPadding() {
        assertEquals(0.08f, SubtitleLook.bottomPadding(0), 1e-6f)
        assertEquals(0.13f, SubtitleLook.bottomPadding(1), 1e-6f)
        assertEquals(0.20f, SubtitleLook.bottomPadding(2), 1e-6f)
    }

    @Test fun staleIndexesClamp() {
        assertEquals(0.75f, SubtitleLook.size(-1), 0f)
        assertEquals(1.5f, SubtitleLook.size(9), 0f)
        assertEquals("serif", SubtitleLook.font(9))
        assertEquals(0xFFD1D1D6.toInt(), SubtitleLook.color(9))
        assertEquals(SubtitleLook.bottomPadding(2), SubtitleLook.bottomPadding(9), 0f)
    }
}
