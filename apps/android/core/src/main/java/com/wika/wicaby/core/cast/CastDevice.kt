package com.wika.wicaby.core.cast

import com.wika.wicaby.core.data.Item
import kotlinx.serialization.json.JsonObject

// What a CastController feeds and reports for (cast spec §2.5): a DLNA renderer (DlnaDevice, CA-08) or, in the mobile
// gplay flavour, a Google Cast Default Media Receiver (CA-10). Transport states use DLNA's names.
interface CastDevice {
    // The picker row it was picked from (its synthetic §2.3 commands).
    val target: CastTarget
    val name: String
    // DeviceId and Client of the session the remote panel draws.
    val id: String
    val client: String
    val bitrate: Int

    // The DeviceProfile its PlaybackInfo is asked with (§2.6); a Cast device connects first.
    suspend fun profile(): JsonObject

    // The container a stream's URL names: for a direct stream, from the source's "mov,mp4,m4a" list.
    fun container(direct: Boolean, containers: List<String>, audio: Boolean): String

    suspend fun load(stream: CastStream)

    // PLAYING, PAUSED_PLAYBACK, TRANSITIONING, STOPPED or NO_MEDIA_PRESENT.
    suspend fun state(): String

    // Where it is in the stream (ms from the stream's start, null unknown) and the URI it plays ("" unknown).
    suspend fun position(): Pair<Long?, String>

    suspend fun play()
    suspend fun pause()
    suspend fun stop()
    suspend fun seek(ms: Long)

    // 0–100 (null unknown) and muted; null when it has no volume control.
    suspend fun volume(): Pair<Int?, Boolean>?
    suspend fun setVolume(v: Int)
    suspend fun setMute(on: Boolean)
}

// One stream for a device: the server URL it fetches itself (token in the URL, §2.6.3) and the external subtitles,
// [subtitle] the one to show (null or -1: none).
data class CastStream(
    val item: Item,
    val url: String,
    val container: String,
    val direct: Boolean,
    val durationMs: Long?,
    val subtitles: List<CastSubtitle>,
    val subtitle: Int?,
) {
    val audio get() = item.mediaType.equals("Audio", true)
}

data class CastSubtitle(val index: Int, val url: String, val language: String?, val title: String?)

// A DLNA/UPnP renderer (CA-08): SOAP through [dlna], the MIME types from its Sink.
class DlnaDevice(val renderer: Renderer, private val dlna: DlnaClient = DlnaClient()) : CastDevice {
    @Volatile private var sink = ""
    override val target get() = renderer.target()
    override val name get() = renderer.name
    override val id get() = renderer.udn
    override val client get() = "DLNA"
    override val bitrate get() = CastProfiles.DLNA_BITRATE

    override suspend fun profile(): JsonObject {
        sink = dlna.sink(renderer)
        return CastProfiles.dlna(sink, renderer.model, renderer.sony)
    }

    // A transcode is HTTP TS (never HLS), mp3 for audio.
    override fun container(direct: Boolean, containers: List<String>, audio: Boolean) = when {
        direct -> containers.firstOrNull(CastProfiles::known) ?: containers.firstOrNull() ?: "mp4"
        audio -> "mp3"
        else -> "ts"
    }

    override suspend fun load(stream: CastStream) {
        val mime = CastProfiles.mime(stream.container, stream.audio, sink)
        val flags = if (stream.direct) Dlna.FLAGS_DIRECT else Dlna.FLAGS_TRANSCODE
        val sub = stream.subtitles.firstOrNull { it.index == stream.subtitle }?.url
        dlna.load(renderer, stream.url) { flagged -> Dlna.didl(stream.item.name, stream.audio, stream.url, mime, flags.takeIf { flagged }, stream.durationMs, sub) }
    }

    override suspend fun state() = dlna.transportState(renderer)

    override suspend fun position() = dlna.position(renderer).let { Dlna.parseHms(it["RelTime"]) to it["TrackURI"].orEmpty().trim() }

    override suspend fun play() {
        dlna.play(renderer)
    }

    override suspend fun pause() {
        dlna.pause(renderer)
    }

    override suspend fun stop() {
        dlna.stop(renderer)
    }

    override suspend fun seek(ms: Long) {
        dlna.seek(renderer, ms)
    }

    override suspend fun volume() = dlna.volume(renderer)

    override suspend fun setVolume(v: Int) {
        dlna.setVolume(renderer, v)
    }

    override suspend fun setMute(on: Boolean) {
        dlna.setMute(renderer, on)
    }
}
