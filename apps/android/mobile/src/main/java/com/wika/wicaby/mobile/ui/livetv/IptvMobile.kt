package com.wika.wicaby.mobile.ui.livetv

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.text.format.DateFormat
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.iptv.Iptv
import com.wika.wicaby.core.iptv.IptvSource
import com.wika.wicaby.core.iptv.iptvErrorText
import com.wika.wicaby.core.iptv.liveSetupUrl
import com.wika.wicaby.mobile.R
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.PillButton
import com.wika.wicaby.mobile.ui.TopBar
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.WicabyField
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import java.util.Date
import com.wika.wicaby.core.R as CoreR

// Phones and tablets: the Live TV entry when no server has Live TV (where to set it up), and IPTV (core/iptv): the add
// form without a source, else the regular Live TV screen over IptvApi with a Sources chip (refresh, remove, add).

@Composable
fun LiveSetupScreen(title: String, onBack: () -> Unit, onIptv: () -> Unit) {
    val context = LocalContext.current
    var shown by rememberSaveable { mutableStateOf<String?>(null) }
    val servers = remember { Servers.all.mapNotNull { a -> liveSetupUrl(a.server)?.let { a.server.name to it } } }
    Column(Modifier.fillMaxSize()) {
        TopBar(title, onBack)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 8.dp).widthIn(max = 560.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(stringResource(CoreR.string.livesetup_body), style = Type.body, color = G.label2)
            servers.forEach { (name, url) ->
                PillButton(stringResource(CoreR.string.livesetup_open, name), icon = Ic.External, onClick = {
                    try {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    } catch (_: ActivityNotFoundException) {
                        shown = url
                    }
                })
            }
            shown?.let {
                Text(stringResource(CoreR.string.livesetup_url), style = Type.footnote, color = G.label2)
                SelectionContainer { Text(it, style = Type.callout, color = G.label) }
            }
            Text(stringResource(CoreR.string.livesetup_iptv), style = Type.body, color = G.label2, modifier = Modifier.padding(top = 8.dp))
            Row { PillButton(stringResource(CoreR.string.livesetup_go_iptv), onClick = onIptv) }
        }
    }
}

@Composable
fun IptvScreen(title: String, onBack: () -> Unit) {
    val sources by Iptv.sources.collectAsState()
    var adding by rememberSaveable { mutableStateOf(false) }
    var managing by rememberSaveable { mutableStateOf(false) }
    when {
        adding -> {
            BackHandler { adding = false }
            AddIptvForm(onDone = { adding = false })
        }
        sources.isEmpty() -> Column(Modifier.fillMaxSize()) {
            TopBar(title, onBack)
            Column(Modifier.padding(horizontal = 20.dp, vertical = 8.dp).widthIn(max = 560.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text(stringResource(CoreR.string.iptv_empty_body), style = Type.body, color = G.label2)
                Row { PillButton(stringResource(CoreR.string.iptv_add), icon = Ic.Plus, onClick = { adding = true }) }
                Text(stringResource(CoreR.string.iptv_no_dvr), style = Type.footnote, color = G.label2)
            }
        }
        managing -> {
            BackHandler { managing = false }
            IptvSources(sources, onBack = { managing = false }, onAdd = { adding = true })
        }
        else -> {
            val context = LocalContext.current
            val repo = remember { LiveRepos.of(context, Iptv.api) }
            // A playlist or a guide changed (added, refreshed, loaded in the background): channels again, slabs revalidated.
            LaunchedEffect(repo) {
                Iptv.changes.drop(1).collect {
                    repo.loadChannels(force = true)
                    repo.markGuideStale()
                }
            }
            LiveScreen(Iptv.api, title, onBack, manage = { managing = true })
        }
    }
}

@Composable
private fun AddIptvForm(onDone: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var name by rememberSaveable { mutableStateOf("") }
    var url by rememberSaveable { mutableStateOf("") }
    var guide by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    fun add() {
        if (busy) return
        busy = true
        status = context.getString(CoreR.string.iptv_adding)
        scope.launch {
            try {
                Iptv.add(name, url, guide)
                onDone()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                status = context.getString(iptvErrorText(e))
            } finally {
                busy = false
            }
        }
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        TopBar(stringResource(CoreR.string.iptv_add), onDone)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 8.dp).widthIn(max = 560.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            WicabyField(url, { url = it.take(4096) }, stringResource(CoreR.string.iptv_field_url), keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next)
            WicabyField(guide, { guide = it.take(4096) }, stringResource(CoreR.string.iptv_field_guide), keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next)
            Text(stringResource(CoreR.string.iptv_guide_help), style = Type.footnote, color = G.label2)
            WicabyField(name, { name = it.take(80) }, stringResource(CoreR.string.iptv_field_name), onSubmit = ::add)
            Text(stringResource(CoreR.string.iptv_private), style = Type.footnote, color = G.label2)
            status?.let { Text(it, style = Type.callout, color = G.label) }
            Spacer(Modifier.height(4.dp))
            Row { PillButton(stringResource(CoreR.string.iptv_add_action), icon = Ic.Plus, onClick = ::add) }
        }
    }
}

@Composable
private fun IptvSources(sources: List<IptvSource>, onBack: () -> Unit, onAdd: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val changes by Iptv.changes.collectAsState()
    var status by remember { mutableStateOf<String?>(null) }
    var removing by remember { mutableStateOf<IptvSource?>(null) }
    Column(Modifier.fillMaxSize()) {
        TopBar(stringResource(CoreR.string.iptv_sources), onBack)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 8.dp).widthIn(max = 560.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(stringResource(CoreR.string.iptv_no_dvr), style = Type.footnote, color = G.label2)
            sources.forEach { s ->
                val n = remember(changes, s.id) { Iptv.channelCount(s.id) }
                val at = remember(changes, s.id) { Iptv.updatedAt(s.id)?.let { DateFormat.getTimeFormat(context).format(Date(it)) } }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(s.name, style = Type.headline, color = G.label)
                        val info = listOfNotNull(n?.let { pluralStringResource(CoreR.plurals.iptv_channels, it, it) }, at).joinToString(" · ")
                        if (info.isNotEmpty()) Text(info, style = Type.footnote, color = G.label2)
                    }
                    PillButton(null, icon = Ic.Trash, compact = true, contentDescription = stringResource(CoreR.string.iptv_remove), onClick = { removing = s })
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PillButton(stringResource(CoreR.string.iptv_refresh), icon = Ic.Refresh, compact = true, onClick = {
                    if (status == null) {
                        status = context.getString(CoreR.string.iptv_refreshing)
                        scope.launch { status = if (Iptv.refreshAll()) null else context.getString(CoreR.string.iptv_refresh_failed) }
                    }
                })
            }
            Row { PillButton(stringResource(CoreR.string.iptv_add), icon = Ic.Plus, compact = true, onClick = onAdd) }
            status?.let { Text(it, style = Type.callout, color = G.label2) }
        }
    }
    removing?.let { s ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text(stringResource(CoreR.string.iptv_remove_title, s.name)) },
            confirmButton = {
                TextButton({
                    removing = null
                    scope.launch {
                        Iptv.remove(s.id)
                        if (Iptv.sources.value.isEmpty()) onBack()
                    }
                }) { Text(stringResource(CoreR.string.iptv_remove), color = G.red) }
            },
            dismissButton = { TextButton({ removing = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}
