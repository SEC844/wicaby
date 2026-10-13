package com.wika.wicaby.core.data

// The dynamic range of a video stream, read from either server's fields:
//  - Emby: VideoRange ("HDR"/"SDR"), ExtendedVideoType ("DolbyVision", "Hdr10Plus", "Hdr10",
//    "HyperLogGamma"), ExtendedVideoSubType ("DoviProfile81"…) and ColorTransfer
//    (smpte2084 = PQ, arib-std-b67 = HLG);
//  - Jellyfin: VideoRangeType (DOVI, DOVIWithHDR10, DOVIWithHLG, DOVIWithSDR, HDR10, HDR10Plus,
//    HLG…) and DvProfile / DvBlSignalCompatibilityId.
// Brand names are never translated. Same rules as the desktop src/shared/hdr.ts: both run
// tools/checks/fixtures/hdr.json.
data class VideoRange(
    // "Dolby Vision", "HDR10+", "HDR10", "HLG", "HDR" (HDR of an unknown kind), or null for SDR.
    val primary: String?,
    // What a Dolby Vision file falls back to on a non-DV screen: "HDR10", "HLG", or null.
    val fallback: String? = null,
    // Dolby Vision profile: "8.1", "7.6", "5".
    val dvProfile: String? = null,
) {
    val isDolbyVision get() = primary == DV

    // The detail page chip: "Dolby Vision · HDR10", "HDR10+", "HLG"… null for SDR.
    val badge: String? get() = primary?.let { p -> listOfNotNull(p, fallback).joinToString(" · ") }

    companion object {
        const val DV = "Dolby Vision"
        val SDR = VideoRange(null)

        fun of(v: MediaStream?): VideoRange {
            if (v == null) return SDR
            jellyfin(v)?.let { return it }
            return emby(v)
        }

        private fun jellyfin(v: MediaStream): VideoRange? {
            val t = v.videoRangeType?.trim().orEmpty().uppercase()
            if (t.isEmpty() || t == "UNKNOWN") return null
            val profile = profileOf(v.dvProfile, v.dvBlSignalCompatibilityId)
            return when (t) {
                "SDR" -> SDR
                // DOVIWithEL is profile 7, whose base layer is HDR10.
                "DOVIWITHHDR10", "DOVIWITHEL" -> VideoRange(DV, "HDR10", profile)
                "DOVIWITHHDR10PLUS", "DOVIWITHELHDR10PLUS" -> VideoRange(DV, "HDR10+", profile)
                "DOVIWITHHLG" -> VideoRange(DV, "HLG", profile)
                "HDR10" -> VideoRange("HDR10")
                "HDR10PLUS" -> VideoRange("HDR10+")
                "HLG" -> VideoRange("HLG")
                // DOVI, DOVIWithSDR and newer DV kinds: the compatibility id says. DOVIInvalid and
                // anything else: decide from the transfer below.
                else -> if (t.startsWith("DOVI") && t != "DOVIINVALID") VideoRange(DV, fallbackOf(v.dvBlSignalCompatibilityId, v.colorTransfer), profile) else null
            }
        }

        private fun emby(v: MediaStream): VideoRange {
            val ext = v.extendedVideoType.orEmpty()
            val sub = v.extendedVideoSubType.orEmpty()
            val transfer = v.colorTransfer.orEmpty().lowercase()
            if (ext.equals("DolbyVision", true) || sub.startsWith("Dovi", true)) {
                // "DoviProfile81" → profile 8, compatibility 1 (HDR10). Jellyfin fields win when present.
                val digits = sub.filter(Char::isDigit)
                val profile = profileOf(v.dvProfile, v.dvBlSignalCompatibilityId)
                    ?: digits.takeIf { it.isNotEmpty() }?.let { d -> profileOf(d.take(1).toInt(), d.drop(1).take(1).toIntOrNull()) }
                val compat = v.dvBlSignalCompatibilityId ?: digits.drop(1).take(1).toIntOrNull()
                return VideoRange(DV, fallbackOf(compat, transfer), profile)
            }
            return when {
                ext.equals("Hdr10Plus", true) -> VideoRange("HDR10+")
                ext.equals("Hdr10", true) -> VideoRange("HDR10")
                ext.equals("HyperLogGamma", true) || ext.equals("Hlg", true) -> VideoRange("HLG")
                transfer == "arib-std-b67" -> VideoRange("HLG")
                transfer == "smpte2084" -> VideoRange("HDR10")
                v.videoRange.equals("HDR", true) -> VideoRange("HDR")
                else -> SDR
            }
        }

        // Profile 8 with compatibility 1 reads "8.1"; profile 5 (no base-layer fallback) reads "5".
        private fun profileOf(profile: Int?, compat: Int?): String? {
            val p = profile?.takeIf { it > 0 } ?: return null
            return if (compat != null && compat > 0) "$p.$compat" else "$p"
        }

        // Base-layer signal compatibility: 1 and 6 are HDR10, 4 is HLG, 0 and 2 have none.
        // Unknown (older Emby): the stream's transfer is the base layer's.
        private fun fallbackOf(compat: Int?, transfer: String?): String? = when (compat) {
            1, 6 -> "HDR10"
            4 -> "HLG"
            null -> when (transfer?.lowercase()) {
                "smpte2084" -> "HDR10"
                "arib-std-b67" -> "HLG"
                else -> null
            }
            else -> null
        }
    }
}
