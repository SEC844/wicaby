package com.wika.wicaby.mobile.cast

import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.edit
import com.wika.wicaby.core.R
import com.wika.wicaby.core.cast.CastController
import com.wika.wicaby.core.cast.CastTarget
import com.wika.wicaby.core.cast.DlnaRenderers
import com.wika.wicaby.core.cast.RemoteTargets
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.caps
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.net.LocalNetwork
import com.wika.wicaby.mobile.BuildConfig
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Group
import com.wika.wicaby.mobile.ui.GroupDivider
import com.wika.wicaby.mobile.ui.GroupRow
import com.wika.wicaby.mobile.ui.Ic
import com.wika.wicaby.mobile.ui.Radius
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.rememberLocalNetworkGranted
import kotlinx.coroutines.delay

// "Lire sur…" (cast spec §2.2): "Cet appareil" first while casting, then Applications, then TVs and players: those
// the server drives over DLNA ("via {server}"), then the renderers this phone finds by SSDP (CA-08; one row per UDN,
// the server's wins), then Chromecast and Google TV (CA-10, gplay only: MediaRouter's Cast routes, the section shows only
// once one is found). Sessions refresh every 2 s; SSDP runs once, 3 s, and MediaRouter scans, while the sheet is open.
// An empty list is normal (§2.2: permissions), not an error.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CastPicker(api: Api, item: Item, casting: Boolean, onPick: (CastTarget) -> Unit, onHere: () -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    var targets by remember { mutableStateOf<List<CastTarget>?>(null) }
    var unavailable by remember { mutableStateOf(false) }
    LaunchedEffect(api, item.id) {
        val rt = RemoteTargets(api)
        while (true) {
            runCatching { rt.list(item) }
                .onSuccess { targets = it }
                .onFailure { if (targets == null) unavailable = true }
            delay(2_000)
        }
    }
    // Direct DLNA: only with Réglages > Diffusion on, and never for a channel, a programme (a renderer cannot tune,
    // §1 Live TV) nor a recording in progress (§8.4); hidden until that is known. Android 17 asks for the local
    // network first (CA-00).
    val enabled = remember { CastSettings.discovery(context) }
    val allowed by produceState<Boolean?>(null, api, item.id) { value = enabled && CastController.directAllowed(api, item) }
    val direct = allowed == true
    var granted by rememberLocalNetworkGranted()
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    LaunchedEffect(direct) { if (direct && !granted) ask.launch(LocalNetwork.PERMISSION) }
    var renderers by remember(direct) { mutableStateOf(if (direct) DlnaRenderers.recent() else emptyList()) }
    var searching by remember(allowed) { mutableStateOf(allowed != false) }
    // Same rules as direct DLNA: a Cast device fetches the server itself (or, Jellyfin's receiver, calls its API).
    val google = remember { GoogleCastProvider.get(context) }
    // A speaker or a speaker group takes songs, not films.
    val media = item.mediaType ?: "Video"
    val chromecasts by produceState(emptyList<CastTarget>(), direct, granted) {
        value = emptyList()
        if (direct && granted) google?.routes?.collect { list -> value = list.filter { media in it.mediaTypes } }
    }
    // Whether a renderer can fetch the server: a LAN address, not the mesh (§2.6.4). Otherwise its rows say why.
    var lan by remember { mutableStateOf(true) }
    LaunchedEffect(direct, granted) {
        if (allowed == null) return@LaunchedEffect
        if (!direct || !granted) {
            searching = false
            return@LaunchedEffect
        }
        searching = true
        lan = CastController.lanBase(api) != null
        DlnaRenderers.discover(context, CastSettings.seeds(context)).collect { r -> renderers = renderers.filter { it.key != r.key } + r }
        searching = false
    }

    ModalBottomSheet(onDismiss, containerColor = G.elevated, contentColor = G.label, shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl)) {
        Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 28.dp)) {
            Text(stringResource(R.string.cast_picker_title), style = Type.title3, color = G.label, modifier = Modifier.padding(bottom = 4.dp))
            Text(item.name, style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = 16.dp))
            if (casting) {
                Group { GroupRow(stringResource(R.string.cast_this_device), onHere, subtitle = stringResource(R.string.cast_play_here), icon = Ic.Play) }
            }
            val list = targets.orEmpty()
            // §2.2 dedupe: a renderer the server already drives shows once, as the server's session.
            val found = renderers.filter { r -> list.none { it.kind == CastTarget.Kind.Dlna && it.deviceId.equals(r.key.removePrefix("d:"), true) } }.map { it.target() }
                .filter { media in it.mediaTypes }
            val none = list.isEmpty() && found.isEmpty() && chromecasts.isEmpty()
            when {
                none && targets == null && unavailable && !searching -> Text(stringResource(com.wika.wicaby.mobile.R.string.play_on_unavailable), style = Type.body, color = G.label2)
                none && (targets == null || searching) -> Text(stringResource(R.string.cast_searching), style = Type.body, color = G.label2)
                none -> Text(stringResource(R.string.cast_empty), style = Type.body, color = G.label2)
                else -> {
                    // caps.sessionsRemote: no "apps" rows for a plex server (plex spec §8).
                    if (api.server.caps.sessionsRemote) Section(R.string.cast_section_apps, list.filter { it.kind == CastTarget.Kind.Session }, onPick)
                    Section(R.string.cast_section_dlna, list.filter { it.kind == CastTarget.Kind.Dlna } + found, onPick, lan)
                    Section(R.string.cast_section_chromecast, chromecasts, onPick, lan)
                }
            }
            if (direct && !granted) {
                Group(Modifier.padding(top = 18.dp)) {
                    GroupRow(stringResource(R.string.local_network_denied), { LocalNetwork.openSettings(context) }, subtitle = stringResource(R.string.local_network_open_settings), icon = Ic.WifiOff)
                }
            }
        }
    }
}

// [lan] false: the server is out of the renderers' reach, so this phone's own DLNA and Cast rows ("d:", "c:" keys) are
// shown, not offered.
@Composable
private fun Section(title: Int, rows: List<CastTarget>, onPick: (CastTarget) -> Unit, lan: Boolean = true) {
    if (rows.isEmpty()) return
    Text(stringResource(title).uppercase(), style = Type.eyebrow, color = G.label3, modifier = Modifier.padding(top = 18.dp, bottom = 8.dp, start = 4.dp))
    Group {
        rows.forEachIndexed { i, t ->
            if (i > 0) GroupDivider()
            val own = t.key.startsWith("d:") || t.key.startsWith("c:")
            val detail = when {
                own && !lan -> stringResource(R.string.cast_error_lan_only, t.name)
                t.device == CastTarget.Device.Group -> stringResource(R.string.cast_speaker_group)
                own -> t.detail.ifBlank { if (t.device == CastTarget.Device.Speaker) stringResource(R.string.cast_speaker) else if (t.kind == CastTarget.Kind.Cast) "Chromecast" else "DLNA/UPnP" }
                t.kind == CastTarget.Kind.Dlna -> stringResource(R.string.cast_via_server, t.detail)
                else -> t.detail
            }
            val icon = when (t.device) {
                CastTarget.Device.Group -> Ic.SpeakerGroup
                CastTarget.Device.Speaker -> Ic.Speaker
                null -> Ic.Cast
            }
            GroupRow(t.name, if (own && !lan) null else ({ onPick(t) }), subtitle = detail, icon = icon)
        }
    }
}

// Réglages > Diffusion (CA-08), SharedPreferences so the picker reads them synchronously.
object CastSettings {
    private fun prefs(context: Context) = context.getSharedPreferences("wicaby_cast", Context.MODE_PRIVATE)

    fun discovery(context: Context): Boolean = prefs(context).getBoolean("discovery", true)

    fun setDiscovery(context: Context, on: Boolean) = prefs(context).edit { putBoolean("discovery", on) }

    // Debug builds only: renderer description URLs typed by hand ("http://10.0.2.2:8970/desc.xml", the mock renderer
    // seen from an emulator). Release builds never read it.
    fun seed(context: Context): String = if (BuildConfig.DEBUG) prefs(context).getString("dlna_seed", "").orEmpty() else ""

    fun setSeed(context: Context, v: String) = prefs(context).edit { putString("dlna_seed", v.trim()) }

    // §2.6.6, gplay: HEVC on any Chromecast (built-in TVs that decode it), AC3/EAC3 when the TV or amplifier takes Dolby.
    fun allowHevc(context: Context): Boolean = prefs(context).getBoolean("allow_hevc", false)

    fun setAllowHevc(context: Context, on: Boolean) = prefs(context).edit { putBoolean("allow_hevc", on) }

    fun dolby(context: Context): Boolean = prefs(context).getBoolean("dolby", false)

    fun setDolby(context: Context, on: Boolean) = prefs(context).edit { putBoolean("dolby", on) }

    fun seeds(context: Context): List<String> = seed(context).split(',', ' ').map(String::trim).filter { it.startsWith("http://") }
}
