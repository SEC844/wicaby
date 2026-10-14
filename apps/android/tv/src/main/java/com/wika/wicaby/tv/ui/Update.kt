package com.wika.wicaby.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.R as CR
import com.wika.wicaby.core.update.UpdateState
import com.wika.wicaby.core.update.Updater
import kotlinx.coroutines.delay

// tvOS-style alert for a sideloaded update: notes, "Mettre à jour" / "Plus tard", then the
// download progress, the "unknown apps" guidance, or the error, in the same card.
@Composable
fun UpdateDialog(onClose: () -> Unit) {
    val context = LocalContext.current
    val state by Updater.state.collectAsState()
    val s = state
    val info = when (s) {
        is UpdateState.Available -> s.info
        is UpdateState.Downloading -> s.info
        is UpdateState.NeedsPermission -> s.info
        is UpdateState.Installing -> s.info
        is UpdateState.Failed -> s.info
        else -> null
    }
    // Plus tard, an install that went through, or a state with nothing to offer: the card goes.
    LaunchedEffect(info == null) { if (info == null) onClose() }
    if (info == null) return
    val later = {
        Updater.later()
        onClose()
    }
    TvSheet(later, width = 520.dp) {
        Text(stringResource(CR.string.update_available), style = Type.title2, color = C.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        Text(
            stringResource(CR.string.update_version, info.versionName.ifEmpty { info.versionCode.toString() }), style = Type.callout, color = C.label2,
            textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
        )
        if (info.notes.isNotBlank()) {
            Text(
                info.notes, style = Type.body, color = C.label,
                modifier = Modifier.fillMaxWidth().padding(top = 18.dp).heightIn(max = 150.dp).verticalScroll(rememberScrollState()),
            )
        }
        val status: String? = when (s) {
            is UpdateState.NeedsPermission -> stringResource(CR.string.update_permission)
            is UpdateState.Failed -> s.message
            else -> null
        }
        if (s is UpdateState.Downloading) {
            Box(Modifier.fillMaxWidth().padding(top = 18.dp).height(6.dp).clip(CircleShape).background(C.fill3)) {
                Box(Modifier.fillMaxWidth(s.fraction).fillMaxHeight().clip(CircleShape).background(Color.White))
            }
        }
        if (status != null) Text(status, style = Type.callout, color = C.label2, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
        Spacer(Modifier.height(22.dp))
        val first = remember { FocusRequester() }
        LaunchedEffect(Unit) {
            delay(60)
            runCatching { first.requestFocus() }
        }
        // One primary button whose label and action follow the state: it keeps focus throughout
        // (a focused button that vanished would drop focus onto the tab bar behind the sheet).
        val primary = when (s) {
            is UpdateState.NeedsPermission -> stringResource(CR.string.update_open_settings)
            is UpdateState.Downloading -> stringResource(CR.string.update_downloading, (s.fraction * 100).toInt())
            is UpdateState.Installing -> stringResource(CR.string.update_installing)
            else -> stringResource(CR.string.update_now)
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SheetButton(primary, modifier = Modifier.focusRequester(first), onClick = {
                when (s) {
                    is UpdateState.NeedsPermission -> Updater.openInstallSettings(context)
                    is UpdateState.Downloading, is UpdateState.Installing -> {}
                    else -> Updater.install(context)
                }
            })
            if (s is UpdateState.NeedsPermission) SheetButton(stringResource(CR.string.update_now), onClick = { Updater.install(context) })
            SheetButton(stringResource(CR.string.update_later), onClick = later)
        }
    }
}

// Réglages > À propos: the manifest URL, typed in a sheet.
@Composable
fun UpdateUrlSheet(current: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var url by remember { mutableStateOf(current) }
    TvSheet(onDismiss, width = 560.dp) {
        Text(stringResource(CR.string.update_url), style = Type.title3, color = C.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        Text(
            stringResource(CR.string.update_url_hint), style = Type.callout, color = C.label2, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp, bottom = 18.dp),
        )
        TvTextField(
            url, { url = it }, com.wika.wicaby.core.update.UpdateLogic.DEFAULT_URL, Modifier.fillMaxWidth(), autoEdit = current.isEmpty(),
            imeAction = androidx.compose.ui.text.input.ImeAction.Done, onSubmit = { onSave(url) },
            label = stringResource(CR.string.update_url),
        )
        Spacer(Modifier.height(18.dp))
        SheetButton(stringResource(CR.string.save), onClick = { onSave(url) })
    }
}
