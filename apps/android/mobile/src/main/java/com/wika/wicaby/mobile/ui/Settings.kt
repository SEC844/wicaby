package com.wika.wicaby.mobile.ui

import com.wika.wicaby.core.music.MusicPrefs
import com.wika.wicaby.core.music.MusicSource
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.key
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.vector.ImageVector
import com.wika.wicaby.core.player.SegmentKind
import com.wika.wicaby.core.ui.themeLabel
import com.wika.wicaby.mobile.player.SkipSettings
import com.wika.wicaby.mobile.Lang
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.pair.pairable
import com.wika.wicaby.core.net.LocalNetwork
import com.wika.wicaby.mobile.BuildConfig
import com.wika.wicaby.mobile.cast.CastSettings
import com.wika.wicaby.mobile.cast.GoogleCastProvider
import com.wika.wicaby.mobile.cast.LicenceException
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import com.wika.wicaby.mobile.R
import kotlinx.coroutines.launch

// Réglages: a root list of categories, each opening an in-screen sub-page (no nav route: Back returns to the list).
// The open category outlives the screen (Ajouter un serveur, Lier un compte Plex, the wizard come back to it).
object SettingsNav {
    var last by mutableStateOf<String?>(null)
}

private class Category(val id: String, val label: Int, val icon: ImageVector)

private val GENERAL = Category("general", R.string.settings_general, Ic.Settings)
private val APPEARANCE = Category("appearance", R.string.settings_appearance, Ic.Sun)
private val PLAYBACK = Category("playback", R.string.settings_playback, Ic.Play)
private val MUSIC = Category("music", R.string.music_settings_title, Ic.Music)
private val CASTING = Category("cast", R.string.settings_cast_title, Ic.Cast)
private val ACCOUNTS = Category("accounts", R.string.settings_accounts, Ic.User)
private val SOURCES = Category("sources", R.string.settings_sources, Ic.Library)
private val ABOUT = Category("about", R.string.about, Ic.Info)
private val CATEGORIES = listOf(GENERAL, APPEARANCE, PLAYBACK, MUSIC, CASTING, ACCOUNTS, SOURCES, ABOUT)

@Composable
fun SettingsScreen(api: Api, onRemote: () -> Unit) {
    val scope = rememberCoroutineScope()
    val prefs = Core.prefs

    fun leave(pickServer: Boolean, revoke: Boolean) {
        scope.launch {
            // No playback (music in the background) goes on reporting with the account being left.
            com.wika.wicaby.mobile.player.PlayerHolder.release()
            if (revoke) runCatching { api.raw("POST", "/Sessions/Logout") }
            Cache.map.clear()
            SetupRequest.pickServer = pickServer
            prefs.signOut()
        }
    }

    // The wizard's last step links here ("Réglages de l’accès à distance").
    LaunchedEffect(Unit) {
        if (SetupRequest.openRemote) {
            SetupRequest.openRemote = false
            onRemote()
        }
    }

    // Tapping the Settings tab again clears it (App.kt TabHost): back to the list.
    val cat = SettingsNav.last
    fun open(id: String?) {
        SettingsNav.last = id
    }
    BackHandler(cat != null) { open(null) }
    val page = CATEGORIES.firstOrNull { it.id == cat }

    key(cat) {
        Column(Modifier.fillMaxSize().imeAware()) {
            if (page != null) TopBar(stringResource(page.label), { open(null) })
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Column(Modifier.widthIn(max = 640.dp).fillMaxWidth()) {
                    when (page) {
                        null -> SettingsRoot(::open, onRemote)
                        GENERAL -> GeneralPage()
                        APPEARANCE -> AppearancePage()
                        PLAYBACK -> PlaybackPage(api)
                        MUSIC -> MusicPage()
                        CASTING -> CastPage()
                        ACCOUNTS -> AccountsPage(api, ::leave)
                        SOURCES -> SourcesPage()
                        ABOUT -> AboutPage()
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsRoot(open: (String) -> Unit, onRemote: () -> Unit) {
    val snap = LocalSnapshot.current
    val context = LocalContext.current
    val session = snap.session
    LargeTitle(stringResource(R.string.tab_settings))
    // Android 17, access refused or put off: the way back to the system toggle (the whole app needs it).
    if (session != null && !rememberLocalNetworkGranted().value) {
        Group(Modifier.padding(top = 12.dp)) {
            GroupRow(
                stringResource(com.wika.wicaby.core.R.string.local_network_denied), { LocalNetwork.openSettings(context) },
                subtitle = stringResource(com.wika.wicaby.core.R.string.local_network_open_settings), icon = Ic.WifiOff,
            )
        }
    }
    @Composable
    fun Row(c: Category, summary: String? = null) = GroupRow(stringResource(c.label), { open(c.id) }, subtitle = summary, icon = c.icon)
    val language = remember { Lang.current(context) }
    val languageLabel = stringResource(
        when (language) {
            "fr" -> R.string.language_fr
            "en" -> R.string.language_en
            else -> R.string.language_system
        },
    )
    Group(Modifier.padding(top = 22.dp)) {
        Row(GENERAL, languageLabel)
        GroupDivider()
        Row(APPEARANCE, stringResource(themeLabel(snap.theme)))
    }
    Group(Modifier.padding(top = 22.dp)) {
        Row(PLAYBACK)
        GroupDivider()
        Row(MUSIC)
        GroupDivider()
        Row(CASTING)
    }
    // OB-M2: Accès à distance keeps its own screen; the row says where the mesh stands.
    val mesh by Core.mesh.status.collectAsState()
    Group(Modifier.padding(top = 22.dp)) {
        Row(ACCOUNTS, if (session != null) stringResource(R.string.signed_in_as, session.userName, session.server.name) else stringResource(R.string.settings_not_signed_in))
        GroupDivider()
        Row(SOURCES)
        GroupDivider()
        GroupRow(stringResource(com.wika.wicaby.meshui.R.string.mesh_title), onRemote, subtitle = meshLine(mesh), icon = Ic.Lock)
    }
    Group(Modifier.padding(top = 22.dp)) {
        Row(ABOUT, "Wicaby ${BuildConfig.VERSION_NAME}")
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GeneralPage() {
    val context = LocalContext.current
    Eyebrow(stringResource(R.string.settings_language))
    Group {
        // Recreated on change, so this is read fresh each time.
        val language = remember { Lang.current(context) }
        FlowRow(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("" to R.string.language_system, "fr" to R.string.language_fr, "en" to R.string.language_en).forEach { (tag, label) ->
                Chip(stringResource(label), selected = language == tag) { if (language != tag) Lang.set(context, tag) }
            }
        }
    }
    Eyebrow(stringResource(R.string.settings_setup))
    Group {
        GroupRow(stringResource(com.wika.wicaby.core.R.string.onboarding_rerun), {
            SetupRequest.rerun = true
            SetupRequest.wizard = true
        }, icon = Ic.Restart)
    }
}

@Composable
private fun AppearancePage() {
    val snap = LocalSnapshot.current
    val scope = rememberCoroutineScope()
    val prefs = Core.prefs
    // The same themes as the TV and the desktop, plus Light and Automatic.
    Eyebrow(stringResource(R.string.settings_theme))
    Group {
        ThemePicker(snap.theme, snap.accent) { id -> scope.launch { prefs.setTheme(id) } }
        GroupDivider()
        Text(stringResource(R.string.settings_accent), style = Type.body, color = G.label, modifier = Modifier.padding(start = 16.dp, top = 14.dp))
        AccentPicker(snap.accent) { i -> scope.launch { prefs.setAccent(i) } }
    }
    Eyebrow(stringResource(R.string.settings_home))
    Group { FilesOnHomeRow() }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PlaybackPage(api: Api) {
    val snap = LocalSnapshot.current
    val scope = rememberCoroutineScope()
    val prefs = Core.prefs
    val context = LocalContext.current
    Eyebrow(stringResource(R.string.settings_quality))
    Group {
        Text(stringResource(R.string.settings_bitrate), style = Type.body, color = G.label, modifier = Modifier.padding(start = 16.dp, top = 14.dp))
        FlowRow(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(0, 80, 40, 20, 8, 4).forEach { m ->
                Chip(if (m == 0) stringResource(R.string.settings_bitrate_auto) else stringResource(R.string.mbps, m), selected = snap.maxMbps == m) {
                    scope.launch { prefs.setMaxMbps(m) }
                }
            }
        }
        GroupDivider()
        GroupRow(stringResource(R.string.wifi_only), { scope.launch { prefs.setWifiOnlyDownloads(!snap.wifiOnlyDownloads) } }, subtitle = stringResource(R.string.wifi_only_sub), chevron = false) {
            SettingSwitch(snap.wifiOnlyDownloads, { v -> scope.launch { prefs.setWifiOnlyDownloads(v) } })
        }
    }
    Eyebrow(stringResource(R.string.settings_skip))
    Group {
        // Recaps, previews and commercials are Jellyfin media segments: nothing to set on Emby.
        var skip by remember { mutableStateOf(SegmentKind.entries.associateWith { SkipSettings.mode(context, it) }) }
        val kinds = if (api.server.isEmby) listOf(SegmentKind.Intro) else SegmentKind.entries
        val labels = mapOf(
            SegmentKind.Intro to R.string.skip_intro_mode, SegmentKind.Recap to com.wika.wicaby.core.R.string.segment_recap,
            SegmentKind.Preview to com.wika.wicaby.core.R.string.segment_preview, SegmentKind.Commercial to com.wika.wicaby.core.R.string.segment_commercial,
        )
        kinds.forEachIndexed { i, kind ->
            if (i > 0) GroupDivider()
            Text(stringResource(labels.getValue(kind)), style = Type.body, color = G.label, modifier = Modifier.padding(start = 16.dp, top = 14.dp))
            FlowRow(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(SkipSettings.ASK to R.string.skip_ask, SkipSettings.AUTO to R.string.skip_auto, SkipSettings.OFF to R.string.skip_off).forEach { (mode, label) ->
                    Chip(stringResource(label), selected = skip[kind] == mode) {
                        SkipSettings.set(context, kind, mode)
                        skip = skip + (kind to mode)
                    }
                }
            }
        }
    }
}

@Composable
private fun MusicPage() {
    val context = LocalContext.current
    val accent = LocalAccent.current
    Eyebrow(stringResource(R.string.settings_music_source))
    Group {
        // "Source de la musique": which signed-in server the Music section shows (core MusicSource).
        val sources = MusicSource.choices(stringResource(com.wika.wicaby.core.R.string.music_source_auto))
        val chosen = remember(MusicSource.version) { MusicSource.current() }
        var sourceMenu by remember { mutableStateOf(false) }
        Box {
            GroupRow(
                stringResource(com.wika.wicaby.core.R.string.music_source), { sourceMenu = true },
                trailing = sources.firstOrNull { it.first == chosen }?.second ?: sources.first().second,
            )
            androidx.compose.material3.DropdownMenu(sourceMenu, { sourceMenu = false }, containerColor = G.elevated2) {
                sources.forEach { (id, label) ->
                    androidx.compose.material3.DropdownMenuItem(
                        text = { Text(label, style = Type.body, color = G.label) },
                        trailingIcon = { if (id == chosen) Icon(Ic.Check, null, tint = accent, modifier = Modifier.size(18.dp)) },
                        onClick = { sourceMenu = false; MusicSource.set(id) },
                    )
                }
            }
        }
    }
    // Music spec MU-13: lrclib.net when the server has no lyrics. Off by default: it learns what is playing.
    Eyebrow(stringResource(R.string.music_lyrics))
    Group {
        GroupRow(
            stringResource(R.string.music_lyrics_online), { MusicPrefs.setLyricsOnline(context, !MusicPrefs.lyricsOnline) },
            subtitle = stringResource(R.string.music_lyrics_online_hint), chevron = false,
        ) {
            SettingSwitch(MusicPrefs.lyricsOnline, { v -> MusicPrefs.setLyricsOnline(context, v) })
        }
    }
}

// CA-08: SSDP search for TVs while the Cast picker is open; debug builds can name a renderer by hand.
@Composable
private fun CastPage() {
    val snap = LocalSnapshot.current
    val scope = rememberCoroutineScope()
    val prefs = Core.prefs
    val context = LocalContext.current
    Eyebrow(stringResource(R.string.settings_cast_to_tv))
    Group {
        var discovery by remember { mutableStateOf(CastSettings.discovery(context)) }
        fun setDiscovery(v: Boolean) {
            discovery = v
            CastSettings.setDiscovery(context, v)
        }
        GroupRow(stringResource(R.string.settings_cast_discovery), { setDiscovery(!discovery) }, chevron = false) {
            SettingSwitch(discovery, ::setDiscovery)
        }
        // CA-10, gplay: what the Chromecast profile may ask the server for (§2.6.6).
        if (BuildConfig.CAST_SDK) {
            GroupDivider()
            CastToggle(R.string.settings_cast_allow_hevc, CastSettings.allowHevc(context)) { CastSettings.setAllowHevc(context, it) }
            GroupDivider()
            CastToggle(R.string.settings_cast_dolby, CastSettings.dolby(context)) { CastSettings.setDolby(context, it) }
        }
    }
    Eyebrow(stringResource(R.string.settings_other_devices))
    Group {
        // Off: SupportsMediaControl:false, so other apps' "Lire sur" lists drop this phone (CA-05).
        GroupRow(
            stringResource(com.wika.wicaby.core.R.string.settings_remote_control), { scope.launch { prefs.setRemoteControl(!snap.remoteControl) } },
            subtitle = stringResource(com.wika.wicaby.core.R.string.settings_remote_control_summary), chevron = false,
        ) {
            SettingSwitch(snap.remoteControl, { v -> scope.launch { prefs.setRemoteControl(v) } })
        }
    }
    if (BuildConfig.DEBUG) {
        Eyebrow(stringResource(R.string.settings_debug))
        Group {
            var seed by remember { mutableStateOf(CastSettings.seed(context)) }
            Column(Modifier.padding(16.dp)) {
                Text(stringResource(R.string.settings_cast_seed), style = Type.body, color = G.label, modifier = Modifier.padding(bottom = 8.dp))
                WicabyField(
                    seed, { v -> seed = v; CastSettings.setSeed(context, v) }, "http://10.0.2.2:8970/desc.xml",
                    keyboardType = androidx.compose.ui.text.input.KeyboardType.Uri,
                )
            }
        }
    }
}

@Composable
private fun AccountsPage(api: Api, leave: (pickServer: Boolean, revoke: Boolean) -> Unit) {
    val snap = LocalSnapshot.current
    val session = snap.session
    if (session != null) {
        Eyebrow(stringResource(R.string.settings_account))
        Group {
            GroupRow(stringResource(R.string.signed_in_as, session.userName, session.server.name), null, subtitle = session.server.address, icon = Ic.User)
            GroupDivider()
            GroupRow(stringResource(R.string.switch_user), { leave(false, false) }, icon = Ic.Users)
            GroupDivider()
            GroupRow(stringResource(R.string.switch_server), { leave(true, false) }, icon = Ic.Server)
            GroupDivider()
            GroupRow(stringResource(R.string.sign_out), { leave(false, true) }, icon = Ic.LogOut, titleColor = G.red, chevron = false)
        }
        // Plex: the connections plex.tv lists, chosen in the Plex section below.
        if (session.server.kind != "plex") AddressSettings(session.server)
        OtherServers(snap)
    }
    PlexSettings(snap)
    // Plex: the TV links its own account (its servers need the account's connections, not this token).
    // Navidrome: the token is the password, never sent over the cleartext pair channel.
    if (session != null && pairable(session.server.kind)) {
        Eyebrow(stringResource(R.string.settings_other_devices))
        Group { PairTvRow(api, session.userName) }
    }
}

@Composable
private fun SourcesPage() {
    // File sources (FS-10).
    FilesSettings()
    // Photo folders and the Immich photo source (photos spec PH-13).
    com.wika.wicaby.mobile.ui.photos.ImmichSettings()
}

@Composable
private fun AboutPage() {
    val snap = LocalSnapshot.current
    Eyebrow(stringResource(com.wika.wicaby.core.R.string.settings_updates))
    UpdateSettings(snap.updateUrl)
    GoogleCastProvider.exception?.let {
        Eyebrow(stringResource(R.string.settings_licences))
        LicenceExceptionRow(it)
    }
    Spacer(Modifier.height(4.dp))
    Text(
        stringResource(R.string.about_line, BuildConfig.VERSION_NAME) + "\n" + stringResource(R.string.plex_unofficial),
        style = Type.footnote, color = G.label2, modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
    )
}

// The settings switch: accent when on, the neutral control colours when off.
@Composable
internal fun SettingSwitch(checked: Boolean, onCheckedChange: (Boolean) -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val accent = LocalAccent.current
    Switch(
        checked, onCheckedChange, modifier, enabled = enabled,
        colors = SwitchDefaults.colors(checkedTrackColor = accent, checkedThumbColor = onAccent(accent), uncheckedTrackColor = G.control, uncheckedThumbColor = G.controlKnob, uncheckedBorderColor = androidx.compose.ui.graphics.Color.Transparent),
    )
}

@Composable
private fun CastToggle(label: Int, initial: Boolean, save: (Boolean) -> Unit) {
    var on by remember { mutableStateOf(initial) }
    fun set(v: Boolean) {
        on = v
        save(v)
    }
    GroupRow(stringResource(label), { set(!on) }, chevron = false) {
        SettingSwitch(on, ::set)
    }
}

// gplay: the GPL section 7 permission for Google Play services, its full text on tap (CA-10).
@Composable
private fun LicenceExceptionRow(e: LicenceException) {
    val res = LocalResources.current
    var open by remember { mutableStateOf(false) }
    Group { GroupRow(stringResource(e.title), { open = true }, subtitle = stringResource(e.summary)) }
    if (open) {
        val text = remember { res.openRawResource(e.text).bufferedReader().use { it.readText() } }
        AlertDialog(
            onDismissRequest = { open = false },
            confirmButton = { TextButton({ open = false }) { Text(stringResource(android.R.string.ok)) } },
            title = { Text(stringResource(e.title)) },
            text = { Text(text, style = Type.footnote, modifier = Modifier.verticalScroll(rememberScrollState())) },
        )
    }
}

// B09: the server's local and remote addresses (blank: what the server announces); requests go to whichever answers.
@Composable
private fun AddressSettings(server: com.wika.wicaby.core.data.Server) {
    val known = remember(server.id) { Core.addresses.known(server.id) }
    var local by androidx.compose.runtime.saveable.rememberSaveable(server.id) { mutableStateOf(known.local.orEmpty()) }
    var remote by androidx.compose.runtime.saveable.rememberSaveable(server.id) { mutableStateOf(known.remote.orEmpty()) }
    var invalid by remember { mutableStateOf(false) }
    var nonce by remember { androidx.compose.runtime.mutableIntStateOf(0) }
    val inUse = remember(nonce, server) { Core.addresses.inUse(server) }
    fun save() {
        invalid = !Core.addresses.edit(server, local, remote)
        nonce++
    }
    Eyebrow(stringResource(com.wika.wicaby.core.R.string.server_addresses))
    Group {
        Column(Modifier.padding(16.dp)) {
            Text(stringResource(com.wika.wicaby.core.R.string.server_address_local), style = Type.body, color = G.label, modifier = Modifier.padding(bottom = 8.dp))
            WicabyField(local, { local = it; invalid = false }, "http://192.168.1.10:8096", keyboardType = androidx.compose.ui.text.input.KeyboardType.Uri, imeAction = androidx.compose.ui.text.input.ImeAction.Next)
            Text(stringResource(com.wika.wicaby.core.R.string.server_address_remote), style = Type.body, color = G.label, modifier = Modifier.padding(top = 12.dp, bottom = 8.dp))
            WicabyField(remote, { remote = it; invalid = false }, "https://media.example.org", keyboardType = androidx.compose.ui.text.input.KeyboardType.Uri, onSubmit = ::save)
            val hint = if (invalid) com.wika.wicaby.core.R.string.server_address_invalid else com.wika.wicaby.core.R.string.server_addresses_hint
            Text(stringResource(hint), style = Type.footnote, color = if (invalid) G.red else G.label2, modifier = Modifier.padding(top = 6.dp))
        }
        GroupDivider()
        GroupRow(stringResource(com.wika.wicaby.core.R.string.server_address_save), ::save, subtitle = stringResource(com.wika.wicaby.core.R.string.server_address_in_use) + " · " + inUse, icon = Ic.Server, chevron = false)
    }
}

// Sideloaded updates: the manifest URL (empty = the GitHub default, saved on Done) and a manual check; the
// update card shows here too when the check finds something.
@Composable
private fun UpdateSettings(saved: String) {
    val scope = rememberCoroutineScope()
    var url by androidx.compose.runtime.saveable.rememberSaveable(saved) { androidx.compose.runtime.mutableStateOf(saved) }
    val state by com.wika.wicaby.core.update.Updater.state.collectAsState()
    fun save() {
        if (url.trim() != saved) scope.launch { Core.prefs.setUpdateUrl(url) }
    }
    Group {
        Column(Modifier.padding(16.dp)) {
            Text(stringResource(com.wika.wicaby.core.R.string.update_url), style = Type.body, color = G.label, modifier = Modifier.padding(bottom = 8.dp))
            WicabyField(
                url, { url = it }, com.wika.wicaby.core.update.UpdateLogic.DEFAULT_URL,
                keyboardType = androidx.compose.ui.text.input.KeyboardType.Uri, onSubmit = ::save,
            )
            Text(stringResource(com.wika.wicaby.core.R.string.update_url_hint), style = Type.footnote, color = G.label2, modifier = Modifier.padding(top = 6.dp))
        }
        run {
            GroupDivider()
            val status = when (val s = state) {
                com.wika.wicaby.core.update.UpdateState.Checking -> stringResource(com.wika.wicaby.core.R.string.update_checking)
                com.wika.wicaby.core.update.UpdateState.UpToDate -> stringResource(com.wika.wicaby.core.R.string.update_up_to_date)
                is com.wika.wicaby.core.update.UpdateState.Failed -> s.message.takeIf { s.info == null }
                else -> null
            }
            GroupRow(stringResource(com.wika.wicaby.core.R.string.update_check), {
                scope.launch {
                    if (url.trim() != saved) Core.prefs.setUpdateUrl(url)
                    com.wika.wicaby.core.update.Updater.check(manual = true)
                }
            }, icon = Ic.Refresh, subtitle = status, chevron = false)
        }
    }
    UpdateCard(Modifier.padding(top = 12.dp))
}
