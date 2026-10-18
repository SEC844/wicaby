package com.wika.wicaby.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import android.text.format.DateUtils
import androidx.compose.ui.platform.LocalResources
import com.wika.wicaby.core.data.Pin
import com.wika.wicaby.core.data.PinCheck
import com.wika.wicaby.tv.R
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// TP-10: the 4-digit PIN of a saved profile. A keypad the D-pad walks (and the remote's digit keys, when it has
// them); the 4th digit submits. [reset] changing clears the entry (wrong PIN, next step).
@Composable
private fun PinPad(title: String, error: String?, reset: Int, onComplete: (String) -> Unit) {
    var pin by remember(reset) { mutableStateOf("") }
    fun type(d: Char) {
        if (pin.length >= Pin.LENGTH) return
        pin += d
        if (pin.length == Pin.LENGTH) onComplete(pin)
    }
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        delay(60)
        runCatching { first.requestFocus() }
    }
    Column(
        Modifier.fillMaxWidth().onPreviewKeyEvent { e ->
            val c = e.utf16CodePoint.toChar()
            if (c !in '0'..'9') return@onPreviewKeyEvent false
            if (e.type == KeyEventType.KeyDown) type(c)
            true
        },
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, style = Type.title3, color = C.label, textAlign = TextAlign.Center)
        Row(Modifier.padding(top = 18.dp, bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            repeat(Pin.LENGTH) { i -> Box(Modifier.size(14.dp).background(if (i < pin.length) C.label else C.fill2, CircleShape)) }
        }
        Text(error.orEmpty(), style = Type.callout, color = C.red, textAlign = TextAlign.Center, modifier = Modifier.height(24.dp))
        Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            listOf("123", "456", "789", " 0<").forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    row.forEach { k ->
                        when (k) {
                            ' ' -> Box(Modifier.size(64.dp))
                            '<' -> PinKey(null, { pin = pin.dropLast(1) }, label = stringResource(R.string.pin_delete))
                            else -> PinKey(k.toString(), { type(k) }, modifier = if (k == '1') Modifier.focusRequester(first) else Modifier)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PinKey(digit: String?, onClick: () -> Unit, modifier: Modifier = Modifier, label: String? = null) {
    var focused by remember { mutableStateOf(false) }
    val bg = if (focused) TvFocus.bg else C.fill2
    val fg = if (focused) TvFocus.fg else C.label
    Box(
        modifier
            .size(64.dp)
            .tvFocus(CircleShape, focusedScale = 1.1f, sheen = false, elevation = 10.dp, onFocusChange = { focused = it }, onClick = onClick)
            .background(bg)
            .semantics { if (label != null) contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        if (digit != null) Text(digit, style = Type.title2, color = fg) else Icon(Ic.Backspace, null, tint = fg, modifier = Modifier.size(24.dp))
    }
}

// Asks [name]'s PIN; [check] ok closes it through [onOk], else it says so (and how long to wait) and clears.
@Composable
fun PinEntrySheet(name: String, onDismiss: () -> Unit, check: suspend (String) -> PinCheck, onOk: () -> Unit) {
    val scope = rememberCoroutineScope()
    var reset by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    val res = LocalResources.current
    TvSheet(onDismiss, width = 360.dp) {
        PinPad(stringResource(R.string.pin_for, name), error, reset) { pin ->
            scope.launch {
                val r = check(pin)
                if (r.ok) onOk() else {
                    error = if (r.waitMs <= 0) res.getString(R.string.pin_wrong)
                    else res.getString(R.string.pin_wait, DateUtils.formatElapsedTime((r.waitMs + 999) / 1000))
                    reset++
                }
            }
        }
    }
}

// A new PIN, typed twice.
@Composable
fun SetPinSheet(onDismiss: () -> Unit, save: suspend (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var first by remember { mutableStateOf<String?>(null) }
    var reset by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    val mismatch = stringResource(R.string.pin_mismatch)
    TvSheet(onDismiss, width = 360.dp) {
        PinPad(stringResource(if (first == null) R.string.pin_new else R.string.pin_confirm), error, reset) { pin ->
            val f = first
            when {
                f == null -> { first = pin; error = null }
                f == pin -> scope.launch { save(pin); onDismiss() }
                else -> { first = null; error = mismatch }
            }
            reset++
        }
    }
}
