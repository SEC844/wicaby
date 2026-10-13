package com.wika.wicaby.core.livetv

import android.app.ActivityManager
import android.content.Context
import android.os.Process
import android.util.Log

// Live TV device classes (spec §2.2, §21.3; Plezy device_performance.dart as a behaviour
// reference only). The guide's paging, tile sizes, caches and overscan follow the device class,
// not the platform: a 32-bit or low-RAM TV gets the "-low" tuning. Mirrors
// D/shared/livetv/tiles.ts (TUNING, DeviceFacts, deviceClass); vectors: CK/fixtures/livetv/tiles.json.
// Pure Kotlin except DeviceClassDetector, which reads the facts from Android.

enum class DeviceClass(val id: String) {
    DESKTOP("desktop"),
    TV_LOW("tv-low"),
    TV("tv"),
    MOBILE_LOW("mobile-low"),
    MOBILE("mobile");

    val tuning: PlatformTuning get() = PlatformTuning.of(this)
    val isLow: Boolean get() = this == TV_LOW || this == MOBILE_LOW

    companion object {
        fun fromId(id: String?): DeviceClass? = id?.trim()?.lowercase()?.let { s -> entries.firstOrNull { it.id == s } }
    }
}

/** One constant set per device class (§2.2). [persistMb] caps the disk cache, [artDelayMs] delays detail art. */
data class PlatformTuning(
    val channelPage: Int,
    val channelPagesInFlight: Int,
    val tileChannels: Int,
    val tileMaxSlabs: Int,
    val concurrency: Int,
    val rowOverscan: Int,
    val timeOverscanMin: Int,
    val maxCells: Int,
    val lruPrograms: Int,
    val persistMb: Int,
    val idleFavoritesOnly: Boolean,
    val idleMax: Int,
    val artDelayMs: Int,
) {
    companion object {
        val DESKTOP = PlatformTuning(500, 2, 50, 4, 4, 4, 120, 250, 40_000, 60, false, 200, 0)

        // §2.2 "Android TV" column: a low-RAM 32-bit TV. mobile-low uses the same values.
        val TV_LOW = PlatformTuning(200, 1, 25, 2, 2, 2, 60, 80, 8_000, 16, true, 50, 400)

        // §21.3 Shield-class boxes.
        val TV = PlatformTuning(500, 2, 40, 3, 3, 3, 60, 140, 16_000, 32, true, 50, 250)
        val MOBILE = PlatformTuning(200, 2, 25, 2, 3, 3, 60, 100, 12_000, 24, true, 50, 0)

        fun of(c: DeviceClass): PlatformTuning = when (c) {
            DeviceClass.DESKTOP -> DESKTOP
            DeviceClass.TV_LOW, DeviceClass.MOBILE_LOW -> TV_LOW
            DeviceClass.TV -> TV
            DeviceClass.MOBILE -> MOBILE
        }
    }
}

enum class FormFactor { DESKTOP, TV, MOBILE }

/** What the classifier looks at. A null fact is unknown and never makes a device "-low". */
data class DeviceFacts(
    val platform: FormFactor,
    val is64Bit: Boolean? = null,
    /** ActivityManager.isLowRamDevice() */
    val lowRam: Boolean? = null,
    val totalMemBytes: Long? = null,
    /** ActivityManager.getMemoryClass(), in MB */
    val memoryClassMb: Int? = null,
    /** Debug setting: forces a class. */
    val override: DeviceClass? = null,
)

const val LOW_TOTAL_MEM_BYTES: Long = 2_362_232_012L // 2.2 GiB (2.2 × 1024³, rounded down)
const val LOW_MEMORY_CLASS_MB: Int = 192

/** §21.3: a 32-bit process, a low-RAM device, ≤ 2.2 GiB or a memoryClass ≤ 192 MB is "-low". */
fun classifyDevice(f: DeviceFacts): DeviceClass {
    f.override?.let { return it }
    if (f.platform == FormFactor.DESKTOP) return DeviceClass.DESKTOP
    val low = f.is64Bit == false ||
        f.lowRam == true ||
        (f.totalMemBytes != null && f.totalMemBytes <= LOW_TOTAL_MEM_BYTES) ||
        (f.memoryClassMb != null && f.memoryClassMb <= LOW_MEMORY_CLASS_MB)
    return when (f.platform) {
        FormFactor.TV -> if (low) DeviceClass.TV_LOW else DeviceClass.TV
        else -> if (low) DeviceClass.MOBILE_LOW else DeviceClass.MOBILE
    }
}

/**
 * Reads the device facts once per process and caches the class.
 *
 * Debug override, so that an emulator can run as `tv-low`, in this order:
 *  1. [forced] (in memory; for a debug settings entry);
 *  2. the system property `debug.wicaby.device_class` (`adb shell setprop debug.wicaby.device_class tv-low`,
 *     then restart the app). `debug.*` properties are writable from adb only, so it is read in every
 *     build type: the baseline profile is only installed on a release (non-debuggable) build.
 */
object DeviceClassDetector {
    const val DEBUG_PROPERTY = "debug.wicaby.device_class"
    private const val LOG_TAG = "WicabyLive"

    // Not keyed by platform: each app passes one FormFactor for the whole process.
    @Volatile
    private var cached: DeviceClass? = null

    @Volatile
    var forced: DeviceClass? = null
        set(value) {
            field = value
            cached = null
        }

    fun detect(context: Context, platform: FormFactor): DeviceClass =
        cached ?: facts(context, platform).let { f ->
            classifyDevice(f).also {
                cached = it
                // One line per process (and per forced change), so that `adb logcat -s WicabyLive`
                // shows which tuning the app runs with and whether an override applied (§16.3).
                Log.i(LOG_TAG, "device class ${it.id} (64-bit=${f.is64Bit}, lowRam=${f.lowRam}, " +
                    "totalMem=${f.totalMemBytes}, memoryClass=${f.memoryClassMb}, override=${f.override?.id})")
            }
        }

    fun tuning(context: Context, platform: FormFactor): PlatformTuning = detect(context, platform).tuning

    fun facts(context: Context, platform: FormFactor): DeviceFacts {
        val am = context.applicationContext.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        val total = am?.let { m -> ActivityManager.MemoryInfo().also { m.getMemoryInfo(it) }.totalMem }
        return DeviceFacts(
            platform = platform,
            is64Bit = Process.is64Bit(),
            lowRam = am?.isLowRamDevice,
            totalMemBytes = total?.takeIf { it > 0 },
            memoryClassMb = am?.memoryClass?.takeIf { it > 0 },
            override = forced ?: DeviceClass.fromId(systemProperty(DEBUG_PROPERTY)),
        )
    }

    // android.os.SystemProperties is not public API; a failed lookup simply means "no override".
    @Suppress("PrivateApi")
    private fun systemProperty(name: String): String? = try {
        Class.forName("android.os.SystemProperties")
            .getMethod("get", String::class.java)
            .invoke(null, name) as? String
    } catch (_: Throwable) {
        null
    }?.takeIf { it.isNotBlank() }
}
