package com.wika.wicaby.core.livetv

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

// GuideCache (spec §7.1): bucketed files keyed by channel (a lens change reuses them), atomic
// writes, the 2 s idle flush, the disk cap, the startup purge and freshness.
class GuideCacheTest {
    private lateinit var dir: File
    private lateinit var scope: CoroutineScope
    private val t0 = slabStart(slabOf(1_760_200_000_000L)) // a slab boundary
    private var now = t0 + 60_000

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("guide").toFile()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }

    @After
    fun tearDown() {
        scope.cancel()
        dir.deleteRecursively()
    }

    private fun cache(tuning: PlatformTuning = PlatformTuning.TV_LOW, idleMs: Long = DISK_IDLE_MS) = GuideCache(dir, tuning, { now }, scope, idleMs)

    private fun prog(ch: String, start: Long, end: Long, id: String = "$ch-$start", title: String = "P") =
        ProgramLite(id = id, channelId = ch, start = start, end = end, title = title, flags = 0)

    @Test
    fun bucketIsFnv1aMod32() {
        // Values from the same fnv1a32 in Node (Math.imul over the UTF-8 bytes).
        assertEquals(20, bucketOf("ltc-001"))
        assertEquals(13, bucketOf("ltc-002"))
        assertEquals(5, bucketOf(""))
        assertEquals(3, bucketOf("Chaîne é"))
    }

    @Test
    fun lensChangeReusesTheBucketFiles() = runBlocking {
        val k = slabOf(t0)
        // Lens "Favoris" fetched channels a and b in one tile.
        val first = cache()
        first.put("a", listOf(k), listOf(prog("a", t0, t0 + 3_600_000)), now)
        first.put("b", listOf(k), listOf(prog("b", t0, t0 + 1_800_000)), now)
        first.flush()
        // Lens "Toutes", sorted by name: b now sits next to c, in another batch. Same files.
        val second = cache()
        val b = second.unit("b", k)
        assertNotNull(b)
        assertEquals(listOf("b-$t0"), b!!.programs.map { it.id })
        assertTrue(second.isFresh(b))
        assertNull(second.unit("c", k))
        // Files are per (slab, bucket), never per request.
        assertTrue(File(dir, "$k/${bucketOf("a")}.json").isFile)
        assertTrue(File(dir, "$k/${bucketOf("b")}.json").isFile)
    }

    @Test
    fun writesAreAtomicAndMergeTheBucket() = runBlocking {
        val k = slabOf(t0)
        val c = cache()
        // Two channels in the same bucket, written by two flushes: the second keeps the first.
        val ids = (0 until 200).map { "ch$it" }.groupBy { bucketOf(it) }.values.first { it.size >= 2 }
        c.put(ids[0], listOf(k), listOf(prog(ids[0], t0, t0 + 600_000)), now)
        c.flush()
        c.put(ids[1], listOf(k), listOf(prog(ids[1], t0, t0 + 600_000)), now)
        c.flush()
        val files = dir.walkTopDown().filter { it.isFile }.toList()
        assertTrue("no .tmp left", files.none { it.name.endsWith(".tmp") })
        val fresh = cache()
        assertNotNull(fresh.unit(ids[0], k))
        assertNotNull(fresh.unit(ids[1], k))
    }

    @Test
    fun idleFlushWritesAfterTheQuietPeriod() = runBlocking {
        val k = slabOf(t0)
        val c = cache(idleMs = 150)
        c.put("a", listOf(k), listOf(prog("a", t0, t0 + 600_000)), now)
        val f = File(dir, "$k/${bucketOf("a")}.json")
        assertFalse("nothing written on the put path", f.exists())
        withTimeout(5_000) { while (!f.isFile) delay(20) }
    }

    @Test
    fun spanningProgrammeIsSplitPerSlabAndMergedBack() {
        val k = slabOf(t0)
        val c = GuideCache(null, PlatformTuning.TV_LOW, { now }, scope)
        val span = prog("a", t0 + SLAB_MS - 600_000, t0 + SLAB_MS + 600_000, "span")
        c.put("a", listOf(k, k + 1), listOf(prog("a", t0, t0 + SLAB_MS - 600_000), span), now)
        assertEquals(2, c.unit("a", k)!!.programs.size)
        assertEquals(listOf("span"), c.unit("a", k + 1)!!.programs.map { it.id })
        assertEquals(2, c.programs("a", t0, t0 + 2 * SLAB_MS).size) // "span" once
    }

    @Test
    fun freshness() {
        val c = GuideCache(null, PlatformTuning.TV_LOW, { now }, scope)
        val airing = slabOf(now)
        c.put("a", listOf(airing, airing + 1), emptyList(), now)
        val u = c.unit("a", airing)!!
        val later = c.unit("a", airing + 1)!!
        assertTrue(c.isFresh(u, now + FRESH_AIRING_MS - 1))
        assertFalse("the airing slab revalidates after 20 min", c.isFresh(u, now + FRESH_AIRING_MS))
        assertTrue(c.isFresh(later, now + FRESH_AIRING_MS))
        now += 1
        c.markAllStale()
        assertFalse(c.isFresh(later, now))
    }

    @Test
    fun startupPurgeDropsSlabsEndedMoreThan6hAgo() = runBlocking {
        val c = cache()
        val old = slabOf(now - PURGE_ENDED_MS) - 1
        val current = slabOf(now)
        c.put("a", listOf(old, current), emptyList(), now)
        c.flush()
        File(dir, "$current/7.json.tmp").writeText("partial")
        c.purge()
        assertFalse(File(dir, "$old").exists())
        assertTrue(File(dir, "$current/${bucketOf("a")}.json").isFile)
        assertFalse(File(dir, "$current/7.json.tmp").exists())
    }

    @Test
    fun diskCapDeletesTheOldestFiles() = runBlocking {
        val tuning = PlatformTuning.TV_LOW.copy(persistMb = 1)
        val c = cache(tuning)
        val title = "x".repeat(400)
        // ≈ 2.5 MB: 6 slabs × 100 channels × 10 programmes × ~500 B.
        for (s in 0 until 6) {
            val k = slabOf(t0) + s
            for (ch in 0 until 100) {
                val id = "c$ch"
                c.put(id, listOf(k), (0 until 10).map { prog(id, slabStart(k) + it * 600_000L, slabStart(k) + (it + 1) * 600_000L, "$id-$k-$it", title) }, now)
            }
            c.flush()
        }
        val total = dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }
        assertTrue("$total bytes over the cap", total <= c.diskCapBytes)
        assertTrue(total > 0)
    }

    @Test
    fun channelsSnapshotRoundTrips() = runBlocking {
        val c = cache()
        val row = ChannelRow("ch1", "srv", "5.1", NumKey(5, 1), "Une", null, true, listOf("Info"), false, 0, null)
        c.writeChannels(ChannelsSnapshot(now, listOf(row)))
        val back = cache().readChannels()!!
        assertEquals(now, back.fetchedAt)
        assertEquals(listOf(row), back.rows)
    }

    @Test
    fun loadFromDiskCanonicalizesChannelIds() = runBlocking {
        val k = slabOf(t0)
        cache().apply {
            put("a", listOf(k), listOf(prog("a", t0, t0 + 600_000), prog("a", t0 + 600_000, t0 + 1_200_000)), now)
            flush()
        }
        val row = String(charArrayOf('a')) // a distinct instance, as ChannelRow.id after decoding
        val c = cache()
        c.canon = { if (it == row) row else it }
        val u = c.unit("a", k)!!
        assertSame(row, u.channelId)
        u.programs.forEach { assertSame(row, it.channelId) }
    }
}
