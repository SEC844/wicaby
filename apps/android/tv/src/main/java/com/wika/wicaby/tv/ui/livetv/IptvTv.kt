package com.wika.wicaby.tv.ui.livetv

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.text.format.DateFormat
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.iptv.Iptv
import com.wika.wicaby.core.iptv.IptvSource
import com.wika.wicaby.core.iptv.iptvErrorText
import com.wika.wicaby.core.iptv.liveSetupUrl
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.ui.AlertAction
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Ic
import com.wika.wicaby.tv.ui.LocalOverlay
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.SheetButton
import com.wika.wicaby.tv.ui.TvAlert
import com.wika.wicaby.tv.ui.TvSheet
import com.wika.wicaby.tv.ui.TvTextField
import com.wika.wicaby.tv.ui.Type
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import java.util.Date

// The "TV en direct" tab when no signed-in server has Live TV (where to set it up), and the IPTV tab: client-side
// sources (core/iptv) shown by the regular Live TV screen through IptvApi, an add sheet and a sources sheet.

/** No server with Live TV: what it needs, each server's setup page (or its address when no browser opens it), IPTV. */
@Composable
fun LiveSetupTab(top: Dp, onIptv: () -> Unit) {
    val context = LocalContext.current
    var shown by rememberSaveable { mutableStateOf<String?>(null) }
    val servers = remember { Servers.all.mapNotNull { a -> liveSetupUrl(a.server)?.let { a.server.name to it } } }
    Column(
        Modifier.fillMaxSize().padding(start = 96.dp, end = 96.dp, top = top + 24.dp).verticalScroll(rememberScrollState()).focusGroup(),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(stringResource(CoreR.string.livesetup_title), style = Type.title1, color = C.label)
        Text(stringResource(CoreR.string.livesetup_body), style = Type.body, color = C.label2, modifier = Modifier.width(620.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(top = 6.dp).focusGroup()) {
            servers.forEach { (name, url) ->
                Pill(stringResource(CoreR.string.livesetup_open, name), icon = Ic.External, onClick = {
                    // A TV without a browser: the address, to type on another device.
                    try {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    } catch (_: ActivityNotFoundException) {
                        shown = url
                    } catch (_: SecurityException) {
                        shown = url
                    }
                })
            }
        }
        shown?.let {
            Text(stringResource(CoreR.string.livesetup_url), style = Type.footnote, color = C.label3)
            Text(it, style = Type.mono, color = C.label)
        }
        Spacer(Modifier.height(10.dp))
        Text(stringResource(CoreR.string.livesetup_iptv), style = Type.body, color = C.label2, modifier = Modifier.width(620.dp))
        Row { Pill(stringResource(CoreR.string.livesetup_go_iptv), onClick = onIptv) }
    }
}

/** The IPTV tab: the add prompt without a source, else the Live TV screen over every source. */
@Composable
fun IptvTab(top: Dp, onScrolled: (Boolean) -> Unit) {
    val sources by Iptv.sources.collectAsState()
    val overlay = LocalOverlay.current
    if (sources.isEmpty()) {
        Column(Modifier.fillMaxSize().padding(start = 96.dp, end = 96.dp, top = top + 24.dp).focusGroup(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(stringResource(CoreR.string.iptv_title), style = Type.title1, color = C.label)
            Text(stringResource(CoreR.string.iptv_empty_body), style = Type.body, color = C.label2, modifier = Modifier.width(620.dp))
            Row(Modifier.padding(top = 6.dp)) { Pill(stringResource(CoreR.string.iptv_add), icon = Ic.Plus, onClick = { overlay.show { AddIptvSheet(onDismiss = overlay::close) } }) }
            Text(stringResource(CoreR.string.iptv_no_dvr), style = Type.footnote, color = C.label3)
        }
        return
    }
    val context = LocalContext.current
    val api = Iptv.api
    val repo = remember(api) { LiveTv.repo(context, api) }
    // A playlist or a guide changed (added, refreshed, loaded in the background): channels again, every slab revalidated.
    LaunchedEffect(repo) {
        Iptv.changes.drop(1).collect {
            repo.loadChannels(force = true)
            repo.markGuideStale()
        }
    }
    LiveTvScreen(api, top = top, onScrolled = onScrolled, manage = { overlay.show { IptvSourcesSheet(onDismiss = overlay::close) } })
}

/** Name, playlist URL, optional XMLTV URL; Add loads the playlist first and says why it failed. */
@Composable
fun AddIptvSheet(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var name by rememberSaveable { mutableStateOf("") }
    var url by rememberSaveable { mutableStateOf("") }
    var guide by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        delay(60)
        runCatching { first.requestFocus() }
    }
    fun add() {
        if (busy) return
        busy = true
        status = context.getString(CoreR.string.iptv_adding)
        scope.launch {
            try {
                Iptv.add(name, url, guide)
                onDismiss()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                status = context.getString(iptvErrorText(e))
            } finally {
                busy = false
            }
        }
    }
    TvSheet(onDismiss, width = 620.dp) {
        Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState())) {
            Text(stringResource(CoreR.string.iptv_add), style = Type.title2, color = C.label, modifier = Modifier.padding(bottom = 16.dp))
            TvTextField(url, { url = it.take(4096) }, "https://", Modifier.fillMaxWidth().focusRequester(first), imeAction = ImeAction.Next, label = stringResource(CoreR.string.iptv_field_url))
            Spacer(Modifier.height(10.dp))
            TvTextField(guide, { guide = it.take(4096) }, stringResource(CoreR.string.iptv_field_guide), Modifier.fillMaxWidth(), imeAction = ImeAction.Next)
            Text(stringResource(CoreR.string.iptv_guide_help), style = Type.footnote, color = C.label3, modifier = Modifier.padding(top = 6.dp))
            Spacer(Modifier.height(10.dp))
            TvTextField(name, { name = it.take(80) }, stringResource(CoreR.string.iptv_field_name), Modifier.fillMaxWidth(), onSubmit = ::add)
            Text(stringResource(CoreR.string.iptv_private), style = Type.footnote, color = C.label3, modifier = Modifier.padding(top = 10.dp))
            status?.let { Text(it, style = Type.callout, color = C.label2, modifier = Modifier.padding(top = 12.dp)) }
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Pill(stringResource(CoreR.string.iptv_add_action), icon = Ic.Plus, onClick = ::add)
                Pill(stringResource(R.string.cancel), onClick = onDismiss)
            }
        }
    }
}

/** Each source (channels, last update) with Remove; Refresh everything now; Add another. */
@Composable
fun IptvSourcesSheet(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val overlay = LocalOverlay.current
    val sources by Iptv.sources.collectAsState()
    val changes by Iptv.changes.collectAsState()
    var status by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf<IptvSource?>(null) }
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        delay(60)
        runCatching { first.requestFocus() }
    }
    confirm?.let { s ->
        TvAlert(
            stringResource(CoreR.string.iptv_remove_title, s.name), null,
            listOf(
                AlertAction(stringResource(CoreR.string.iptv_remove), destructive = true) {
                    confirm = null
                    scope.launch { Iptv.remove(s.id) }
                    if (sources.size <= 1) onDismiss()
                },
                AlertAction(stringResource(R.string.cancel)) { confirm = null },
            ),
            focusIndex = 1, onDismiss = { confirm = null },
        )
        return
    }
    TvSheet(onDismiss, width = 620.dp) {
        Text(stringResource(CoreR.string.iptv_sources), style = Type.title2, color = C.label)
        Text(stringResource(CoreR.string.iptv_no_dvr), style = Type.footnote, color = C.label3, modifier = Modifier.padding(top = 4.dp, bottom = 16.dp))
        Column(Modifier.heightIn(max = 300.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            sources.forEachIndexed { i, s ->
                // Read with [changes]: a refresh updates the counts while the sheet is open.
                val n = remember(changes, s.id) { Iptv.channelCount(s.id) }
                val at = remember(changes, s.id) { Iptv.updatedAt(s.id)?.let { DateFormat.getTimeFormat(context).format(Date(it)) } }
                val info = listOfNotNull(n?.let { pluralStringResource(CoreR.plurals.iptv_channels, it, it) }, at).joinToString(" · ")
                SheetButton(
                    if (info.isEmpty()) s.name else "${s.name}  ·  $info", centered = false,
                    onClick = { confirm = s },
                    modifier = if (i == 0) Modifier.focusRequester(first) else Modifier,
                )
            }
            SheetButton(stringResource(CoreR.string.iptv_refresh), icon = Ic.Refresh, onClick = {
                if (status == null) {
                    status = context.getString(CoreR.string.iptv_refreshing)
                    scope.launch { status = if (Iptv.refreshAll()) null else context.getString(CoreR.string.iptv_refresh_failed) }
                }
            })
            SheetButton(stringResource(CoreR.string.iptv_add), icon = Ic.Plus, onClick = { overlay.show { AddIptvSheet(onDismiss = overlay::close) } })
        }
        status?.let { Text(it, style = Type.callout, color = C.label2, modifier = Modifier.padding(top = 12.dp)) }
    }
}

