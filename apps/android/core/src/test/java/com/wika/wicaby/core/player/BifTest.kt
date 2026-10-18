package com.wika.wicaby.core.player

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class BifTest {
    // A BIF with frames every 10 s whose "JPEG" payloads are single distinct bytes.
    private fun bif(frames: Int, multiplier: Int = 1000, step: Int = 10): ByteArray {
        val header = 64
        val index = (frames + 1) * 8
        val buf = ByteBuffer.allocate(header + index + frames).order(ByteOrder.LITTLE_ENDIAN)
        buf.put(byteArrayOf(0x89.toByte(), 0x42, 0x49, 0x46, 0x0D, 0x0A, 0x1A, 0x0A))
        buf.putInt(0).putInt(frames).putInt(multiplier)
        buf.position(header)
        for (i in 0 until frames) buf.putInt(i * step).putInt(header + index + i)
        buf.putInt(-1).putInt(header + index + frames)
        for (i in 0 until frames) buf.put((i + 1).toByte())
        return buf.array()
    }

    @Test
    fun parsesIndexAndFrames() {
        val b = Bif.parse(bif(5))!!
        assertEquals(5, b.count)
        assertEquals(0, b.indexAt(0))
        assertEquals(0, b.indexAt(9_999))
        assertEquals(1, b.indexAt(10_000))
        assertEquals(4, b.indexAt(3_600_000))
        assertArrayEquals(byteArrayOf(3), b.jpeg(2))
        assertNull(b.jpeg(5))
    }

    @Test
    fun zeroMultiplierMeansSeconds() {
        val b = Bif.parse(bif(3, multiplier = 0))!!
        assertEquals(2, b.indexAt(20_000))
    }

    @Test
    fun rejectsGarbage() {
        assertNull(Bif.parse(ByteArray(10)))
        assertNull(Bif.parse(ByteArray(200)))
        val truncated = bif(50).copyOf(100)
        assertNull(Bif.parse(truncated))
    }

    @Test
    fun hugeCountDoesNotOverflowTheBoundsCheck() {
        // 0x1FFFFFFF frames: (n + 1) * 8 wraps to 0 in Int.
        val b = bif(1).also { ByteBuffer.wrap(it).order(ByteOrder.LITTLE_ENDIAN).putInt(12, 0x1FFFFFFF) }
        assertNull(Bif.parse(b))
    }
}
