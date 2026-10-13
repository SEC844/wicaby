package com.wika.wicaby.core.player

import android.app.ActivityManager
import android.content.Context
import android.os.Handler
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.audio.ForwardingAudioSink
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.ForwardingRenderer
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.RenderersFactory
import androidx.media3.exoplayer.audio.AudioRendererEventListener
import androidx.media3.exoplayer.metadata.MetadataOutput
import androidx.media3.exoplayer.text.TextOutput
import androidx.media3.exoplayer.text.TextRenderer
import androidx.media3.exoplayer.video.VideoRendererEventListener
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.extractor.DefaultExtractorsFactory
import com.wika.wicaby.core.Core
import io.github.peerless2012.ass.media.AssHandler
import io.github.peerless2012.ass.media.factory.AssRenderersFactory
import io.github.peerless2012.ass.media.kt.withAssMkvSupport
import io.github.peerless2012.ass.media.parser.AssSubtitleParserFactory
import io.github.peerless2012.ass.media.render.AssRenderer
import io.github.peerless2012.ass.media.type.AssRenderType

// ExoPlayer plus the libass handler its subtitle overlay needs (AssSubtitleView(ctx, ass)).
class Engine(val player: ExoPlayer, val ass: AssHandler)

// The one player setup both apps use: platform decoders first, FFmpeg audio for the rest,
// libass for ASS/SSA, and every byte through Core.http (ServerTransport, ServerAuthInterceptor).
// file:// and content:// (downloads) go through DefaultDataSource's local branches.
// [headers] is ignored: default request properties went to every host (subtitles, trailers,
// redirect targets); Core.http's ServerAuthInterceptor now adds them for the active server only.
fun buildEngine(context: Context, @Suppress("UNUSED_PARAMETER") headers: Map<String, String>, userAgent: String): Engine {
    // FileSources.calls: Core.http, except under a WebDAV file source (its password and pin, spec §5.2).
    val http = OkHttpDataSource.Factory(com.wika.wicaby.core.files.FileSources.calls)
        .setUserAgent(userAgent)
    // libass renders ASS/SSA on an overlay above the SurfaceView, which keeps the HDR path intact.
    val ass = AssHandler(AssRenderType.OVERLAY_OPEN_GL)
    val assParser = AssSubtitleParserFactory(ass)
    // The engine is built before the item is known (and mobile reuses it): ExoLivePort switches the load
    // control and the TS flags to the live profile while a channel plays (LiveLoadControl.kt, §8.9).
    val extractors = DefaultExtractorsFactory()
    val profile = LiveProfileSwitch(extractors, vodBufferBytes(context.getSystemService(ActivityManager::class.java).memoryClass))
    val sources = DefaultMediaSourceFactory(DefaultDataSource.Factory(context, http), extractors.withAssMkvSupport(assParser, ass))
        .setSubtitleParserFactory(assParser)
    val renderers = PassthroughAwareRenderers(context)
        .setEnableDecoderFallback(true)
        .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
    // Re-pick the audio track when the sink changes (AVR switched on, passthrough appears, headphones).
    val selector = DefaultTrackSelector(context, DefaultTrackSelector.Parameters.Builder(context).setAllowInvalidateSelectionsOnRendererCapabilitiesChange(true).build())
    val exo = ExoPlayer.Builder(context)
        .setMediaSourceFactory(sources)
        .setRenderersFactory(subtitleShift(AssRenderersFactory(ass, renderers)))
        .setTrackSelector(selector)
        .setAudioAttributes(audioAttributes(music = false), true)
        .setHandleAudioBecomingNoisy(true)
        // VOD capped at vodBufferBytes (LiveLoadControl.kt), the live profile while a channel plays.
        .setLoadControl(profile)
        .build()
    profile.register(exo)
    ass.init(exo)
    return Engine(exo, ass)
}

// Music spec MU-07: MUSIC while a music session owns the player (core/music/MusicSession.kt), MOVIE otherwise.
fun audioAttributes(music: Boolean): AudioAttributes =
    AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(if (music) C.AUDIO_CONTENT_TYPE_MUSIC else C.AUDIO_CONTENT_TYPE_MOVIE).build()

// Codecs the user turned passthrough off for (Core.passthroughOverride) are refused by the
// sink as bitstream, so ExoPlayer decodes them (platform decoder or FFmpeg) to PCM instead.
private val PASS_MIMES = mapOf(
    "ac3" to listOf(MimeTypes.AUDIO_AC3),
    "eac3" to listOf(MimeTypes.AUDIO_E_AC3, MimeTypes.AUDIO_E_AC3_JOC),
    "dts" to listOf(MimeTypes.AUDIO_DTS, MimeTypes.AUDIO_DTS_HD, MimeTypes.AUDIO_DTS_EXPRESS, MimeTypes.AUDIO_DTS_X),
    "truehd" to listOf(MimeTypes.AUDIO_TRUEHD),
)

private class PassthroughAwareRenderers(context: Context) : DefaultRenderersFactory(context) {
    override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink? {
        // super's sink plus AudioFx (dialogue, night mode, normalisation, boost) on decoded PCM.
        val sink = DefaultAudioSink.Builder(context)
            .setEnableFloatOutput(enableFloatOutput)
            .setEnableAudioOutputPlaybackParameters(enableAudioTrackPlaybackParams)
            .setAudioProcessors(arrayOf(AudioFxProcessor()))
            .build()
        return object : ForwardingAudioSink(sink) {
            // AvSync audio delay: the audio clock (which drives the video) runs ahead of the sound by the
            // delay, so the sound comes that much later. No sample is touched: a bitstream works too.
            override fun getCurrentPositionUs(sourceEnded: Boolean): Long {
                val p = super.getCurrentPositionUs(sourceEnded)
                return if (p == AudioSink.CURRENT_POSITION_NOT_SET) p else p + AvSync.audioUs
            }

            override fun configure(config: AudioSink.AudioSinkConfig) {
                super.configure(config)
                AudioFx.bitstream = config.format.sampleMimeType != MimeTypes.AUDIO_RAW
            }

            private fun blocked(f: Format): Boolean {
                val mime = f.sampleMimeType ?: return false
                return Core.passthroughOverride.any { (k, on) -> !on && PASS_MIMES[k]?.contains(mime) == true }
            }

            override fun supportsFormat(format: Format) = !blocked(format) && super.supportsFormat(format)

            override fun getFormatSupport(format: Format) = if (blocked(format)) AudioSink.SINK_FORMAT_UNSUPPORTED else super.getFormatSupport(format)
        }
    }
}

// AvSync subtitle offset: the text renderer (SRT, VTT, PGS...) and libass's AssRenderer (which sets the
// time it draws at) see the clock moved back by the offset, so a positive offset shows subtitles later.
private fun subtitleShift(inner: RenderersFactory) = object : RenderersFactory by inner {
    override fun createRenderers(
        handler: Handler, video: VideoRendererEventListener, audio: AudioRendererEventListener, text: TextOutput, metadata: MetadataOutput,
    ): Array<Renderer> = inner.createRenderers(handler, video, audio, text, metadata).map { r ->
        if (r !is TextRenderer && r !is AssRenderer) r
        else object : ForwardingRenderer(r) {
            override fun render(positionUs: Long, elapsedRealtimeUs: Long) = super.render(positionUs - AvSync.subtitleUs, elapsedRealtimeUs)
        }
    }.toTypedArray()
}
