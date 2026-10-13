package com.wika.wicaby.core.player

// X-02 quality switching (feature-specs.md §2): the preset table, the coversSource rule, the size
// estimate and the version label/signature. Pure (JVM-tested by QualityTest against
// CK/fixtures/quality/quality.json, the vectors of D/shared/quality-presets.ts).
object Quality {
    // "Original": always sent, because a posted profile otherwise caps the stream at 8 Mbps.
    const val ORIGINAL = 100_000_000
    private const val AUDIO_BITRATE = 192_000L

    class Preset(val bitrate: Int, val height: Int)

    val PRESETS = listOf(
        Preset(20_000_000, 1080), Preset(12_000_000, 1080), Preset(10_000_000, 1080), Preset(8_000_000, 1080),
        Preset(4_000_000, 720), Preset(3_000_000, 720), Preset(2_000_000, 720),
        Preset(1_500_000, 480), Preset(720_000, 320), Preset(320_000, 240),
    )

    // A preset no smaller than the source in both bitrate and height lowers nothing. An unknown source covers nothing.
    fun coversSource(p: Preset, bitrate: Int?, height: Int?): Boolean =
        bitrate != null && bitrate > 0 && height != null && height > 0 && p.bitrate >= bitrate && p.height >= height

    fun estimateSize(bitrate: Int, durationMs: Long): Long = Math.round((bitrate + AUDIO_BITRATE) * durationMs / 8000.0)

    // maxBitrate null = Original; size and percent only when known.
    data class Row(val maxBitrate: Int?, val bitrate: Int?, val height: Int?, val size: Long?, val percent: Int?)

    fun rows(bitrate: Int?, height: Int?, size: Long?, durationMs: Long): List<Row> {
        val original = size?.takeIf { it > 0 } ?: if (bitrate != null && durationMs > 0) estimateSize(bitrate, durationMs) else null
        val out = mutableListOf(Row(null, bitrate, height, original, original?.let { 100 }))
        for (p in PRESETS) {
            if (coversSource(p, bitrate, height)) continue
            val s = if (durationMs > 0) estimateSize(p.bitrate, durationMs) else null
            out += Row(p.bitrate, p.bitrate, p.height, s, if (s != null && original != null) Math.round(s * 100.0 / original).toInt() else null)
        }
        return out
    }

    // Height bucket of a version: a cropped 2160p (3840x1600) is still "2160p".
    fun heightClass(width: Int?, height: Int?): Int? {
        val w = width ?: 0
        val h = height ?: 0
        return when {
            w == 0 && h == 0 -> null
            w >= 3200 || h >= 1600 -> 2160
            w >= 1800 || h >= 900 -> 1080
            w >= 1200 || h >= 650 -> 720
            h >= 500 -> 576
            h >= 400 || w >= 640 -> 480
            else -> h.takeIf { it > 0 }
        }
    }

    // hdr: "sdr", "hdr10", "hdr10+", "hlg", "dv" (null = unknown). Brand names, never translated.
    fun versionLabel(width: Int?, height: Int?, codec: String?, hdr: String?): String {
        val h = heightClass(width, height)
        val c = codec.orEmpty().lowercase().replace("h265", "hevc").replace("h264", "avc")
        val codecText = if (c == "avc") "H.264" else c.uppercase()
        val hdrText = when (hdr) {
            "hdr10" -> "HDR10"
            "hdr10+" -> "HDR10+"
            "hlg" -> "HLG"
            "dv" -> "DV"
            else -> ""
        }
        return listOf(h?.let { "${it}p" }.orEmpty(), codecText, hdrText).filter { it.isNotEmpty() }.joinToString(" ")
    }

    fun signature(width: Int?, height: Int?, codec: String?, hdr: String?): String = versionLabel(width, height, codec, hdr).lowercase()
}
