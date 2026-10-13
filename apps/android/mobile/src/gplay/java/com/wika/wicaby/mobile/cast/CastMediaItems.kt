package com.wika.wicaby.mobile.cast

import androidx.media3.cast.MediaItemConverter
import androidx.media3.common.MediaItem
import com.google.android.gms.cast.HlsVideoSegmentFormat
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaMetadata
import com.google.android.gms.cast.MediaQueueItem
import com.google.android.gms.cast.MediaTrack
import com.wika.wicaby.core.cast.CastStream
import org.json.JSONObject
import androidx.media3.common.MediaMetadata as Media3Metadata

// What RemoteCastPlayer sends the Default Media Receiver for a MediaItem (cast spec CA-10). Only a stream
// CastController prepared is cast (§2.6: the receiver's own PlaybackInfo, a LAN URL, the token in the URL), looked up by
// the item id in mediaId. A local MediaItem's URI relies on header auth and this phone's DeviceProfile, so it would not
// play there: a missing prepared stream throws instead of falling back to it.
class CastMediaItems(private val prepared: (itemId: String) -> CastStream?) : MediaItemConverter {
    override fun toMediaQueueItem(mediaItem: MediaItem): MediaQueueItem {
        val s = prepared(mediaItem.mediaId) ?: throw IllegalStateException("no prepared cast stream for item ${mediaItem.mediaId}")
        val meta = MediaMetadata(if (s.audio) MediaMetadata.MEDIA_TYPE_MUSIC_TRACK else MediaMetadata.MEDIA_TYPE_MOVIE)
        meta.putString(MediaMetadata.KEY_TITLE, s.item.name)
        // §2.6.6: text subtitles as External VTT, one track per stream, its id the server's stream index.
        val tracks = s.subtitles.map { t ->
            MediaTrack.Builder(t.index.toLong(), MediaTrack.TYPE_TEXT).setSubtype(MediaTrack.SUBTYPE_SUBTITLES)
                .setContentId(t.url).setContentType("text/vtt").setLanguage(t.language).setName(t.title).build()
        }
        val info = MediaInfo.Builder(s.url).setContentUrl(s.url).setStreamType(MediaInfo.STREAM_TYPE_BUFFERED)
            .setContentType(mime(s)).setMetadata(meta).setMediaTracks(tracks).setCustomData(JSONObject().put(ITEM_ID, s.item.id))
            .apply {
                s.durationMs?.let(::setStreamDuration)
                // HLS transcode (§2.6.6): TS segments, fMP4 when Jellyfin sends HEVC.
                if (s.hls) setHlsVideoSegmentFormat(if (s.url.contains("SegmentContainer=mp4", true)) HlsVideoSegmentFormat.FMP4 else HlsVideoSegmentFormat.MPEG2_TS)
            }
            .build()
        val active = s.subtitles.filter { it.index == s.subtitle }.map { it.index.toLong() }.toLongArray()
        return MediaQueueItem.Builder(info).setActiveTrackIds(active).build()
    }

    // The receiver's queue back as MediaItems: the item id comes back in the custom data.
    override fun toMediaItem(mediaQueueItem: MediaQueueItem): MediaItem {
        val info = mediaQueueItem.media
        return MediaItem.Builder().setMediaId(info?.customData?.optString(ITEM_ID).orEmpty()).setUri(info?.contentUrl ?: info?.contentId)
            .setMediaMetadata(Media3Metadata.Builder().setTitle(info?.metadata?.getString(MediaMetadata.KEY_TITLE)).build()).build()
    }

    companion object {
        private const val ITEM_ID = "itemId"

        // An HLS transcode: the URL CastDevice.container named m3u8 (the server's master playlist).
        private val CastStream.hls get() = !direct && container == "m3u8"

        fun mime(s: CastStream): String = when {
            s.hls -> "application/x-mpegURL"
            s.audio -> when (s.container) {
                "flac" -> "audio/flac"
                "aac", "m4a" -> "audio/mp4"
                "ogg", "opus" -> "audio/ogg"
                "webm" -> "audio/webm"
                else -> "audio/mpeg"
            }
            s.container == "webm" -> "video/webm"
            else -> "video/mp4"
        }
    }
}
