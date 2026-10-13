package com.wika.wicaby.core.music

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.wika.wicaby.core.player.AudioFx

/**
 * Music settings kept on this device (music spec wave 5): the LRCLIB toggle (MU-13, off by default) and the
 * equalizer (MU-11, flat by default), which [load] hands to [AudioFx] at start-up and every set updates.
 */
object MusicPrefs {
    private const val FILE = "wicaby_music"

    var lyricsOnline by mutableStateOf(false)
        private set
    var eq by mutableStateOf(AudioFx.Eq())
        private set

    private fun sp(context: Context) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun load(context: Context) {
        val p = sp(context)
        lyricsOnline = p.getBoolean("lyrics_online", false)
        val bands = p.getString("eq_bands", null)?.split(',')?.mapNotNull { it.toFloatOrNull() }?.takeIf { it.size == AudioFx.EQ_FREQS.size }
        eq = AudioFx.Eq(bands?.map(::clampDb) ?: AudioFx.FLAT, clampDb(p.getFloat("eq_preamp", 0f)))
        AudioFx.eq = eq
    }

    fun setLyricsOnline(context: Context, on: Boolean) {
        lyricsOnline = on
        sp(context).edit().putBoolean("lyrics_online", on).apply()
    }

    fun setEq(context: Context, next: AudioFx.Eq) {
        eq = next.copy(bands = next.bands.map(::clampDb), preampDb = clampDb(next.preampDb))
        AudioFx.eq = eq
        sp(context).edit().putString("eq_bands", eq.bands.joinToString(",")).putFloat("eq_preamp", eq.preampDb).apply()
    }

    private fun clampDb(v: Float) = v.coerceIn(-AudioFx.EQ_MAX_DB, AudioFx.EQ_MAX_DB)
}
