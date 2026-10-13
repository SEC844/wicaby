package com.wika.wicaby.mobile.music

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.music.MusicPrefs
import com.wika.wicaby.core.player.AudioFx
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.ui.Chip
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Radius
import com.wika.wicaby.mobile.ui.Type
import kotlin.math.roundToInt

private val PRESETS = listOf(
    "flat" to R.string.music_eq_preset_flat,
    "bass" to R.string.music_eq_preset_bass,
    "vocal" to R.string.music_eq_preset_vocal,
    "treble" to R.string.music_eq_preset_treble,
)

private fun hz(f: Int) = if (f >= 1000) "${f / 1000}k" else "$f"
private fun signed(db: Float) = db.roundToInt().let { if (it > 0) "+$it" else "$it" }

/**
 * The music equalizer (music spec MU-11): presets, the 10 bands and the preamp, saved by MusicPrefs and applied by
 * AudioFx on decoded PCM. A passthrough bitstream never reaches it: the sheet then says so and turns its controls off.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun EqualizerSheet(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val eq = MusicPrefs.eq
    val off = AudioFx.bitstream
    val preset = AudioFx.presetOf(eq.bands)
    fun save(next: AudioFx.Eq) = MusicPrefs.setEq(context, next)
    ModalBottomSheet(onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = G.elevated, contentColor = G.label, shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl)) {
        Column(Modifier.navigationBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.music_eq_title), style = Type.title3, color = G.label, modifier = Modifier.weight(1f))
                TextButton(onClick = { save(AudioFx.Eq()) }, enabled = !off && eq.active) { Text(stringResource(R.string.music_eq_reset), color = G.label2) }
            }
            if (off) Text(stringResource(R.string.music_eq_passthrough), style = Type.footnote, color = G.label2, modifier = Modifier.padding(vertical = 8.dp))
            FlowRow(Modifier.padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PRESETS.forEach { (key, label) ->
                    Chip(stringResource(label), selected = preset == key) { if (!off) save(eq.copy(bands = AudioFx.EQ_PRESETS.getValue(key))) }
                }
                if (preset == "custom") Chip(stringResource(R.string.music_eq_preset_custom), selected = true) {}
            }
            Band(stringResource(R.string.music_eq_preamp), stringResource(R.string.music_eq_preamp), eq.preampDb, !off) { save(eq.copy(preampDb = it)) }
            AudioFx.EQ_FREQS.forEachIndexed { i, f ->
                Band(hz(f), stringResource(R.string.music_eq_band, hz(f)), eq.bands[i], !off) { v -> save(eq.copy(bands = eq.bands.mapIndexed { j, g -> if (j == i) v else g })) }
            }
        }
    }
}

// One row: label, a −12…+12 dB slider in 1 dB steps (saved on release), the value.
@Composable
private fun Band(label: String, description: String, db: Float, enabled: Boolean, onChange: (Float) -> Unit) {
    var drag by remember(db) { mutableStateOf<Float?>(null) }
    val v = drag ?: db
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = Type.footnote, color = G.label2, modifier = Modifier.width(64.dp))
        Slider(
            value = v,
            onValueChange = { drag = it.roundToInt().toFloat() },
            onValueChangeFinished = { drag?.let(onChange); drag = null },
            valueRange = -AudioFx.EQ_MAX_DB..AudioFx.EQ_MAX_DB,
            steps = (AudioFx.EQ_MAX_DB * 2).toInt() - 1,
            enabled = enabled,
            colors = SliderDefaults.colors(thumbColor = G.label, activeTrackColor = G.label, inactiveTrackColor = G.fill3),
            modifier = Modifier.weight(1f).semantics { contentDescription = description },
        )
        Text(stringResource(R.string.music_eq_value, signed(v)), style = Type.mono, color = G.label2, textAlign = TextAlign.End, modifier = Modifier.width(56.dp))
    }
}
