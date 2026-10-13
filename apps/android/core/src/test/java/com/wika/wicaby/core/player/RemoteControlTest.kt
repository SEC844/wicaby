package com.wika.wicaby.core.player

import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.SocketMessage
import com.wika.wicaby.core.data.json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Socket messages -> player and device actions; chapter jumps (FF/REW) and Emby marker filtering.
class RemoteControlTest {
    private val calls = mutableListOf<String>()

    private val target = object : RemoteTarget {
        override fun pause() { calls += "pause" }
        override fun unpause() { calls += "unpause" }
        override fun playPause() { calls += "playPause" }
        override fun stop() { calls += "stop" }
        override fun seek(ms: Long) { calls += "seek $ms" }
        override fun next() { calls += "next" }
        override fun previous() { calls += "previous" }
        override fun audio(index: Int) { calls += "audio $index" }
        override fun subtitle(index: Int) { calls += "subtitle $index" }
        override fun enqueue(ids: List<String>, next: Boolean): Boolean {
            calls += "enqueue $ids $next"
            return queueing
        }
    }
    private var queueing = true

    private val host = object : RemoteHost {
        override fun play(request: RemotePlay) { calls += "play $request" }
        override fun volume(command: String, level: Int?) { calls += "volume $command $level" }
        override fun message(header: String?, text: String) { calls += "message $header $text" }
    }

    private fun send(text: String) {
        val m = SocketMessage.parse(text)!!
        RemoteControl.parse(m)?.let { RemoteControl.dispatch(it, target, host) }
    }

    @Test
    fun playNowStartsAtThePosition() {
        send("""{"MessageType":"Play","Data":{"ItemIds":["a1","b2"],"StartIndex":1,"StartPositionTicks":1234560000,"PlayCommand":"PlayNow","MediaSourceId":"ms9","AudioStreamIndex":2,"SubtitleStreamIndex":"4"}}""")
        val req = RemotePlay("b2", 123_456, "ms9", 2, 4, queue = listOf("a1", "b2"))
        assertEquals(listOf("play $req"), calls)
        // The new Playback takes it once, for that item only.
        assertNull(RemoteControl.take("a1"))
        assertEquals(req, RemoteControl.take("b2"))
        assertNull(RemoteControl.take("b2"))
    }

    @Test
    fun playDropsBadIds() {
        send("""{"MessageType":"Play","Data":{"ItemIds":["../../x"],"PlayCommand":"PlayNow"}}""")
        send("""{"MessageType":"Play","Data":{"ItemIds":["a1","../x"],"PlayCommand":"PlayNext"}}""")
        send("""{"MessageType":"Play","Data":{"ItemIds":[]}}""")
        assertEquals(emptyList<String>(), calls)
    }

    // TP-04: PlayNext / PlayLast go into the playing queue, else play now as a queue (desktop playback-service).
    @Test
    fun playNextAndLastQueue() {
        send("""{"MessageType":"Play","Data":{"ItemIds":["a1","b2"],"PlayCommand":"PlayNext"}}""")
        send("""{"MessageType":"Play","Data":{"ItemIds":["c3"],"PlayCommand":"PlayLast"}}""")
        assertEquals(listOf("enqueue [a1, b2] true", "enqueue [c3] false"), calls)
        calls.clear()
        queueing = false
        send("""{"MessageType":"Play","Data":{"ItemIds":["a1","b2"],"PlayCommand":"PlayLast"}}""")
        val req = RemotePlay("a1", null, null, null, null, queue = listOf("a1", "b2"))
        assertEquals(listOf("enqueue [a1, b2] false", "play $req"), calls)
        assertEquals(req, RemoteControl.take("a1"))
        calls.clear()
        RemoteControl.parse(SocketMessage.parse("""{"MessageType":"Play","Data":{"ItemIds":["d4"],"PlayCommand":"PlayNext"}}""")!!)?.let { RemoteControl.dispatch(it, null, host) }
        assertEquals(listOf("play ${RemotePlay("d4", null, null, null, null)}"), calls)
    }

    @Test
    fun playstateAndGeneralCommands() {
        send("""{"MessageType":"Playstate","Data":{"Command":"Pause"}}""")
        send("""{"MessageType":"Playstate","Data":{"Command":"Unpause"}}""")
        send("""{"MessageType":"Playstate","Data":{"Command":"Seek","SeekPositionTicks":600000000}}""")
        send("""{"MessageType":"Playstate","Data":{"Command":"NextTrack"}}""")
        send("""{"MessageType":"Playstate","Data":{"Command":"Stop"}}""")
        send("""{"MessageType":"GeneralCommand","Data":{"Name":"SetSubtitleStreamIndex","Arguments":{"Index":"3"}}}""")
        send("""{"MessageType":"GeneralCommand","Data":{"Name":"SetAudioStreamIndex","Arguments":{"Index":"1"}}}""")
        send("""{"MessageType":"GeneralCommand","Data":{"Name":"SetVolume","Arguments":{"Volume":"40"}}}""")
        send("""{"MessageType":"GeneralCommand","Data":{"Name":"ToggleMute"}}""")
        send("""{"MessageType":"GeneralCommand","Data":{"Name":"DisplayMessage","Arguments":{"Header":"Living room","Text":"À table","TimeoutMs":"5000"}}}""")
        send("""{"MessageType":"GeneralCommand","Data":{"Name":"GoHome"}}""")
        send("""{"MessageType":"LibraryChanged","Data":{}}""")
        assertEquals(
            listOf(
                "pause", "unpause", "seek 60000", "next", "stop", "subtitle 3", "audio 1",
                "volume SetVolume 40", "volume ToggleMute null", "message Living room À table", "stop",
            ),
            calls,
        )
    }

    @Test
    fun noPlayerNoCrash() {
        RemoteControl.parse(SocketMessage.parse("""{"MessageType":"Playstate","Data":{"Command":"Pause"}}""")!!)?.let { RemoteControl.dispatch(it, null, host) }
        assertEquals(emptyList<String>(), calls)
    }

    // CA-05: on mobile, with no player, Play and messages still reach the host; volume and transport do not.
    @Test
    fun mobileHostWithNoPlayer() {
        fun mobile(text: String) = RemoteControl.parse(SocketMessage.parse(text)!!)?.let { RemoteControl.dispatch(it, null, host, playerOnly = true) }
        mobile("""{"MessageType":"GeneralCommand","Data":{"Name":"SetVolume","Arguments":{"Volume":"40"}}}""")
        mobile("""{"MessageType":"GeneralCommand","Data":{"Name":"Mute"}}""")
        mobile("""{"MessageType":"GeneralCommand","Data":{"Name":"DisplayMessage","Arguments":{"Text":"Salut"}}}""")
        mobile("""{"MessageType":"Playstate","Data":{"Command":"Stop"}}""")
        // Browsing, no film: the admin's message shows all the same.
        assertEquals(listOf("message null Salut"), calls)
        calls.clear()
        mobile("""{"MessageType":"Play","Data":{"ItemIds":["123"],"StartPositionTicks":50000000,"ControllingUserId":"u-wika"}}""")
        val req = RemotePlay("123", 5_000, null, null, null, controller = "u-wika")
        assertEquals(listOf("play $req"), calls)
        assertEquals(req, RemoteControl.take("123"))
        // The same commands with a player, and on TV (playerOnly off) with none.
        RemoteControl.parse(SocketMessage.parse("""{"MessageType":"GeneralCommand","Data":{"Name":"Mute"}}""")!!)?.let { RemoteControl.dispatch(it, target, host, playerOnly = true) }
        RemoteControl.parse(SocketMessage.parse("""{"MessageType":"GeneralCommand","Data":{"Name":"SetVolume","Arguments":{"Volume":"7"}}}""")!!)?.let { RemoteControl.dispatch(it, null, host, playerOnly = false) }
        assertEquals(listOf("play $req", "volume Mute null", "volume SetVolume 7"), calls)
    }

    // Remote control off: every command is dropped but DisplayMessage, a notification.
    @Test
    fun remoteControlOffKeepsMessagesOnly() {
        fun c(text: String) = RemoteControl.parse(SocketMessage.parse(text)!!)!!
        val message = c("""{"MessageType":"GeneralCommand","Data":{"Name":"DisplayMessage","Arguments":{"Text":"Salut"}}}""")
        assertTrue(RemoteControl.accepts(message, enabled = false))
        for (other in listOf(
            """{"MessageType":"GeneralCommand","Data":{"Name":"SetVolume","Arguments":{"Volume":"40"}}}""",
            """{"MessageType":"GeneralCommand","Data":{"Name":"GoHome"}}""",
            """{"MessageType":"Playstate","Data":{"Command":"Pause"}}""",
            """{"MessageType":"Play","Data":{"ItemIds":["a1"]}}""",
        )) {
            assertFalse(other, RemoteControl.accepts(c(other), enabled = false))
            assertTrue(other, RemoteControl.accepts(c(other), enabled = true))
        }
    }

    @Test
    fun badControllerIdIsDropped() {
        send("""{"MessageType":"Play","Data":{"ItemIds":["a1"],"ControllingUserId":"../x"}}""")
        assertEquals(listOf("play ${RemotePlay("a1", null, null, null, null)}"), calls)
    }

    @Test
    fun armedRequestIsTakenOnce() {
        val req = RemotePlay("n9", 42_000, null, 1, -1)
        RemoteControl.arm(req)
        assertEquals(req, RemoteControl.take("n9"))
        assertNull(RemoteControl.take("n9"))
    }

    @Test
    fun disabledIgnoresEverything() {
        // handle() returns before touching the main looper when remote control is off.
        RemoteControl.handle(SocketMessage.parse("""{"MessageType":"Play","Data":{"ItemIds":["zz1"]}}""")!!, enabled = false)
        assertNull(RemoteControl.take("zz1"))
    }

    @Test
    fun chapterJumps() {
        val starts = listOf(0L, 60_000, 120_000, 300_000)
        assertEquals(60_000L, chapterTarget(starts, 10_000, forward = true))
        assertEquals(120_000L, chapterTarget(starts, 60_000, forward = true))
        assertNull(chapterTarget(starts, 300_000, forward = true))
        // Back: to the current start, or the one before within 3 s of it; nothing near 0.
        assertEquals(60_000L, chapterTarget(starts, 90_000, forward = false))
        assertEquals(0L, chapterTarget(starts, 61_000, forward = false))
        assertNull(chapterTarget(starts, 300, forward = false))
    }

    @Test
    fun embyMarkersAreNotChapters() {
        val item = json.decodeFromString<Item>(
            """{"Id":"i","Chapters":[{"StartPositionTicks":0,"Name":"Début","MarkerType":"Chapter","ImageTag":"t0"},
               {"StartPositionTicks":100,"MarkerType":"IntroStart"},{"StartPositionTicks":200,"MarkerType":"IntroEnd"},
               {"StartPositionTicks":300,"Name":"Deux"},{"StartPositionTicks":900,"MarkerType":"CreditsStart"}]}""",
        )
        assertEquals(listOf(0, 3), item.chapters.withIndex().filter { it.value.isChapter }.map { it.index })
        assertEquals("t0", item.chapters[0].imageTag)
    }
}
