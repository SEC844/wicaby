package com.wika.wicaby.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.R as CR
import com.wika.wicaby.core.update.UpdateState
import com.wika.wicaby.core.update.Updater

// A sideloaded update, as a card (Accueil, and Réglages after a manual check): notes, then
// "Mettre à jour" / "Plus tard"; the same card shows the download, the "unknown apps"
// guidance and errors. Nothing when there is no update in play.
@Composable
fun UpdateCard(modifier: Modifier = Modifier) {
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
    } ?: return
    Column(modifier.widthIn(max = 640.dp).fillMaxWidth().clip(RoundedCornerShape(Radius.lg)).background(G.elevated).padding(18.dp)) {
        Text(stringResource(CR.string.update_available), style = Type.headline, color = G.label)
        Text(stringResource(CR.string.update_version, info.versionName.ifEmpty { info.versionCode.toString() }), style = Type.footnote, color = G.label2)
        if (info.notes.isNotBlank()) {
            Text(info.notes, style = Type.callout, color = G.label, maxLines = 8, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 10.dp))
        }
        if (s is UpdateState.Downloading) {
            Box(Modifier.fillMaxWidth().padding(top = 14.dp).height(4.dp).clip(CircleShape).background(G.fill3)) {
                Box(Modifier.fillMaxWidth(s.fraction).fillMaxHeight().clip(CircleShape).background(G.label))
            }
        }
        val status = when (s) {
            is UpdateState.Downloading -> stringResource(CR.string.update_downloading, (s.fraction * 100).toInt())
            is UpdateState.Installing -> stringResource(CR.string.update_installing)
            is UpdateState.NeedsPermission -> stringResource(CR.string.update_permission)
            is UpdateState.Failed -> s.message
            else -> null
        }
        if (status != null) Text(status, style = Type.footnote, color = G.label2, modifier = Modifier.padding(top = 8.dp))
        val busy = s is UpdateState.Downloading || s is UpdateState.Installing
        Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (s is UpdateState.NeedsPermission) {
                PillButton(stringResource(CR.string.update_open_settings), { Updater.openInstallSettings(context) }, primary = true, compact = true)
                PillButton(stringResource(CR.string.update_now), { Updater.install(context) }, compact = true)
            } else if (!busy) {
                PillButton(stringResource(CR.string.update_now), { Updater.install(context) }, primary = true, compact = true)
            }
            PillButton(stringResource(CR.string.update_later), { Updater.later() }, compact = true)
        }
    }
}
