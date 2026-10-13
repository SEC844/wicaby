package com.wika.wicaby.core.player

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

// Audio delay and subtitle offset (desktop's audio-delay / sub-delay, Infuse T#1), in ms; positive = later.
// Engine reads the two shifts on the playback thread (Engine.kt: the audio sink's clock, the subtitle renderers).
//
// Remembered in ScopedPrefs' document under the desktop's prop names, in the title slot, per item
// ("server:itemId"): the next episode starts at 0. "Whole series" also writes them under the series
// key ("server:seriesId"), which an episode without its own value then uses.
object AvSync {
    const val AUDIO = "audioDelay"
    const val SUBTITLE = "subtitleDelay"
    const val AUDIO_STEP_MS = 50
    const val SUBTITLE_STEP_MS = 100
    const val MAX_MS = 5_000

    @Volatile
    var audioUs = 0L
        private set

    @Volatile
    var subtitleUs = 0L
        private set

    // The Playback that set the shifts: a player closing late must not clear the next one's.
    private var owner: Any? = null

    @Synchronized
    fun apply(owner: Any, audioMs: Int, subtitleMs: Int) {
        this.owner = owner
        audioUs = audioMs * 1000L
        subtitleUs = subtitleMs * 1000L
    }

    @Synchronized
    fun release(owner: Any) {
        if (this.owner !== owner) return
        this.owner = null
        audioUs = 0
        subtitleUs = 0
    }

    // ---- Pure (unit-tested on the JVM).

    data class Keys(val item: String, val series: String?)

    private fun num(doc: JsonObject, prop: String, key: String?): Int? =
        key?.let { (ScopedPrefs.read(doc, prop, ScopedPrefs.Scope.Title, ScopedPrefs.Ctx(it)) as? JsonPrimitive)?.intOrNull }

    /** The item's own value, else the series value, else 0. */
    fun read(doc: JsonObject, prop: String, keys: Keys): Int = num(doc, prop, keys.item) ?: num(doc, prop, keys.series) ?: 0

    /** True while the series has a saved value. */
    fun seriesWide(doc: JsonObject, keys: Keys): Boolean = keys.series != null && (num(doc, AUDIO, keys.series) != null || num(doc, SUBTITLE, keys.series) != null)

    fun clamp(ms: Int) = ms.coerceIn(-MAX_MS, MAX_MS)

    /** [ms] for this item, and for its series too while [seriesWide]. */
    fun write(doc: JsonObject, prop: String, keys: Keys, ms: Int, seriesWide: Boolean, now: Long): JsonObject {
        var d = put(doc, prop, keys.item, JsonPrimitive(clamp(ms)), now)
        if (seriesWide && keys.series != null) d = put(d, prop, keys.series, JsonPrimitive(clamp(ms)), now)
        return d
    }

    /** This item keeps the values shown; on: the series takes them too, off: the series values are dropped. */
    fun setSeriesWide(doc: JsonObject, keys: Keys, on: Boolean, audioMs: Int, subtitleMs: Int, now: Long): JsonObject {
        val series = keys.series ?: return doc
        var d = write(doc, AUDIO, keys, audioMs, false, now)
        d = write(d, SUBTITLE, keys, subtitleMs, false, now)
        d = put(d, AUDIO, series, if (on) JsonPrimitive(clamp(audioMs)) else JsonNull, now)
        return put(d, SUBTITLE, series, if (on) JsonPrimitive(clamp(subtitleMs)) else JsonNull, now)
    }

    private fun put(doc: JsonObject, prop: String, key: String, v: JsonElement, now: Long) =
        ScopedPrefs.write(doc, prop, ScopedPrefs.Scope.Title, ScopedPrefs.Ctx(key), v, now)
}
