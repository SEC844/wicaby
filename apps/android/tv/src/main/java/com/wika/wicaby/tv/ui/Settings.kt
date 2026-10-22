package com.wika.wicaby.tv.ui

import com.wika.wicaby.tv.player.SUB_POSITION_LABELS
import android.content.pm.PackageManager
import android.os.Build
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.focusProperties
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.activity.compose.LocalActivity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import android.widget.Toast
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.photos.photoAlbums
import com.wika.wicaby.core.player.AniSkip
import com.wika.wicaby.core.player.CommunitySegments
import com.wika.wicaby.core.player.ScopedPrefs
import com.wika.wicaby.core.data.DeviceCaps
import com.wika.wicaby.core.data.HomeRows
import com.wika.wicaby.core.data.User
import com.wika.wicaby.core.data.caps
import com.wika.wicaby.core.data.json
import com.wika.wicaby.tv.BuildConfig
import com.wika.wicaby.tv.LocalNav
import com.wika.wicaby.tv.LocalSnapshot
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.Route
import com.wika.wicaby.tv.Wicaby
import com.wika.wicaby.tv.data.AppLanguage
import com.wika.wicaby.tv.data.TvSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// Réglages, tvOS-style: sections on the left (focus switches them), detail on the right.

private val LocalSectionFocus = staticCompositionLocalOf<FocusRequester?> { null }

// Onboarding Done (step 6) → Réglages > Accès à distance: MainScreen opens the Settings tab, which opens that section.
object SettingsLink {
    var remote by mutableStateOf(false)
}

// The shared category order (desktop, TV, phone); TV folds Video into Playback, Music into Sources, Casting into General.
private enum class Section(val label: Int) {
    General(R.string.section_general),
    Appearance(R.string.section_appearance),
    Home(R.string.section_home),
    Playback(R.string.section_playback),
    Audio(R.string.section_audio),
    Subtitles(R.string.section_subtitles),
    Accounts(R.string.section_accounts), // with Trakt (TP-09) and music scrobbling
    Files(R.string.sources_title), // FS-10 file sources, photo sources, music source
    Remote(R.string.section_remote),
    About(R.string.section_about),
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun SettingsTab(api: Api, user: User?, tabs: List<TopTab>, onScrolled: (Boolean) -> Unit) {
    val initial = remember { if (SettingsLink.remote) Section.Remote else Section.General }
    var section by rememberSaveable { mutableStateOf(initial) }
    LaunchedEffect(SettingsLink.remote) {
        if (SettingsLink.remote) section = Section.Remote
        SettingsLink.remote = false
    }
    val memory = rememberFocusMemory()
    val first = remember { FocusRequester() }
    Row(Modifier.fillMaxSize().padding(start = 64.dp, end = 64.dp, top = 100.dp)) {
        Column(
            // Ten sections do not fit a 540 dp screen: the list scrolls to keep the focused one in view.
            Modifier.width(240.dp).fillMaxHeight().verticalScroll(rememberScrollState()).padding(bottom = 48.dp).focusRestorer(first).focusGroup(),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(stringResource(R.string.tab_settings), style = Type.largeTitle, color = C.label, modifier = Modifier.padding(start = 16.dp, bottom = 18.dp))
            Section.entries.forEach { s ->
                SectionItem(
                    stringResource(s.label), s == section, onFocus = { section = s },
                    modifier = Modifier.remembered(memory, "section-${s.name}", default = s == initial)
                        .then(if (s == section) Modifier.focusRequester(first) else Modifier),
                )
            }
        }
        Spacer(Modifier.width(48.dp))
        AnimatedContent(section, transitionSpec = { fadeIn(tween(220, 60)) togetherWith fadeOut(tween(120)) }, label = "section",
            modifier = Modifier
                .weight(1f)
                .fillMaxHeight()
                .focusGroup(),
        ) { s ->
            val scroll = rememberScrollState()
            LaunchedEffect(scroll) { snapshotFlow { scroll.value > 40 }.collect(onScrolled) }
            // Left from a row goes back to the current section, not the nearest one.
            CompositionLocalProvider(LocalSectionFocus provides first) {
            Column(Modifier.fillMaxSize().verticalScroll(scroll).padding(top = 66.dp, bottom = 64.dp)) {
                when (s) {
                    Section.General -> GeneralSection(api)
                    Section.Appearance -> AppearanceSection(api)
                    Section.Home -> HomeSection(api, tabs)
                    Section.Playback -> PlaybackSection(api)
                    Section.Audio -> AudioSection(api)
                    Section.Subtitles -> SubtitlesSection(api)
                    Section.Accounts -> AccountsSection(api, user)
                    Section.Files -> FilesSection()
                    Section.Remote -> RemoteSection()
                    Section.About -> AboutSection()
                }
            }
            }
        }
    }
}

@Composable
private fun SectionItem(text: String, selected: Boolean, onFocus: () -> Unit, modifier: Modifier) {
    var focused by remember { mutableStateOf(false) }
    val bg =
        when {
            focused -> TvFocus.bg
            selected -> C.fill2
            else -> Color.Transparent
        }
    Row(
        modifier
            .fillMaxWidth()
            .tvFocus(RoundedCornerShape(Radius.md), focusedScale = 1.04f, sheen = false, elevation = 10.dp, onFocusChange = { focused = it; if (it) onFocus() }, onClick = {})
            .background(bg)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, style = Type.headline, color = if (focused) TvFocus.fg else if (selected) C.label else C.label2, modifier = Modifier.weight(1f))
        if (focused) Icon(Ic.Chevron, null, tint = Color.Black.copy(alpha = 0.5f), modifier = Modifier.size(18.dp))
    }
}

// ---------------------------------------------------------------------------
// Rows.

@Composable
internal fun Group(title: String?, hint: String? = null, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(bottom = 26.dp)) {
        if (title != null) Text(title, style = Type.callout, color = C.label3, modifier = Modifier.padding(start = 18.dp, bottom = 8.dp))
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) { content() }
        if (hint != null) Text(hint, style = Type.footnote, color = C.label3, modifier = Modifier.padding(start = 18.dp, end = 18.dp, top = 10.dp))
    }
}

@Composable
internal fun SettingRow(
    label: String,
    value: String? = null,
    modifier: Modifier = Modifier,
    chevron: Boolean = false,
    mono: Boolean = false,
    onClick: () -> Unit = {},
) {
    var focused by remember { mutableStateOf(false) }
    val bg = if (focused) TvFocus.bg else C.fill1
    val section = LocalSectionFocus.current
    Row(
        modifier
            .fillMaxWidth()
            .focusProperties { if (section != null) left = section }
            .tvFocus(RoundedCornerShape(Radius.md), focusedScale = 1.025f, sheen = false, elevation = 10.dp, onFocusChange = { focused = it }, onClick = onClick)
            .background(bg)
            .padding(horizontal = 18.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(label, style = Type.headline, color = if (focused) TvFocus.fg else C.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (value != null) {
            Text(
                value, style = if (mono) Type.mono else Type.callout, color = if (focused) TvFocus.fg.copy(alpha = 0.62f) else C.label2,
                maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = androidx.compose.ui.text.style.TextAlign.End, modifier = Modifier.widthIn(max = 340.dp),
            )
        }
        if (chevron) Icon(Ic.Chevron, null, tint = if (focused) TvFocus.fg.copy(alpha = 0.5f) else C.label3, modifier = Modifier.size(18.dp))
    }
}

@Composable
internal fun ChoiceRow(label: String, options: List<String>, selected: Int, onSelect: (Int) -> Unit, enabled: Boolean = true) {
    val overlay = LocalOverlay.current
    val me = remember { FocusRequester() }
    SettingRow(
        label, options.getOrNull(selected) ?: "—", Modifier.focusRequester(me), chevron = true,
        onClick = {
            if (enabled) overlay.show(me) { TvPicker(label, options, selected, onSelect = onSelect, onDismiss = overlay::close) }
        },
    )
}

@Composable
internal fun ToggleRow(label: String, value: Boolean, onChange: (Boolean) -> Unit) {
    SettingRow(label, stringResource(if (value) R.string.on else R.string.off), onClick = { onChange(!value) })
}

// A destructive row: OK asks first (the TvAlert of Délier le compte Plex), Annuler has the focus.
@Composable
internal fun ConfirmRow(label: String, confirm: String, value: String? = null, onConfirm: () -> Unit) {
    val overlay = LocalOverlay.current
    val me = remember { FocusRequester() }
    val cancel = stringResource(R.string.cancel)
    SettingRow(label, value, Modifier.focusRequester(me), onClick = {
        overlay.show(me) {
            TvAlert(
                label, null,
                listOf(
                    AlertAction(confirm, destructive = true) { overlay.close(); onConfirm() },
                    AlertAction(cancel) { overlay.close() },
                ),
                focusIndex = 1, onDismiss = overlay::close,
            )
        }
    })
}

// ---------------------------------------------------------------------------
// Général.

@Composable
private fun GeneralSection(api: Api) {
    val activity = LocalActivity.current ?: return
    val nav = LocalNav.current
    Group(stringResource(R.string.group_language)) {
        // The language names stay in their own language, so either reader can find theirs.
        ChoiceRow(
            stringResource(R.string.language),
            listOf(stringResource(R.string.language_system), stringResource(R.string.language_fr), stringResource(R.string.language_en)),
            AppLanguage.TAGS.indexOf(remember { AppLanguage.current(activity) }).coerceAtLeast(0),
            { AppLanguage.set(activity, AppLanguage.TAGS[it]) },
        )
    }
    // OB-X: the launcher's Wicaby rows.
    Group(stringResource(R.string.group_tv_home), stringResource(R.string.tv_home_hint)) {
        HomeChannelsRow()
    }
    // "Play on Wicaby" comes through the server: none on a plex server (caps.castReceiver, plex-spec §8).
    if (api.server.caps.castReceiver) Group(stringResource(R.string.group_other_devices), stringResource(CoreR.string.settings_remote_control_summary)) {
        ToggleRow(stringResource(CoreR.string.settings_remote_control), TvSettings.remoteControl.value) { TvSettings.remoteControl.value = it }
    }
    // OB-T1: the first-run wizard again (Done comes back here).
    Group(stringResource(R.string.group_setup)) {
        SettingRow(stringResource(CoreR.string.onboarding_rerun), chevron = true, onClick = { nav.push(Route.Welcome(rerun = true)) })
    }
}

// ---------------------------------------------------------------------------
// Lecture.

private val MBPS = listOf(0, 120, 80, 60, 40, 20, 10, 8, 4, 2)
private val LANGS = listOf("" to R.string.lang_auto, "fre" to R.string.lang_fre, "eng" to R.string.lang_eng, "jpn" to R.string.lang_jpn, "ger" to R.string.lang_ger, "spa" to R.string.lang_spa, "ita" to R.string.lang_ita, "kor" to R.string.lang_kor)
private val AD_PREFS = listOf("prefer" to CoreR.string.ad_prefer, "avoid" to CoreR.string.ad_avoid, "any" to CoreR.string.ad_any)
private val SUB_MODES = listOf("Default" to R.string.sub_mode_default, "Smart" to R.string.sub_mode_smart, "OnlyForced" to R.string.sub_mode_forced, "Always" to R.string.sub_mode_always, "None" to R.string.sub_mode_none)
private val PASS_LABELS = mapOf("ac3" to "Dolby Digital (AC3)", "eac3" to "Dolby Digital Plus (E-AC3)", "dts" to "DTS, DTS-HD", "truehd" to "Dolby TrueHD")

// The user's server-side configuration (audio/subtitle languages, subtitle mode): Emby and
// Jellyfin pick the default streams from it, so every client follows the same preference.
private class ServerConfig(val api: Api) {
    var config by mutableStateOf<JsonObject?>(null)
    var failed by mutableStateOf(false)

    suspend fun load() {
        config = runCatching { json.parseToJsonElement(api.raw("GET", "/Users/${api.userId}")).jsonObject["Configuration"]?.jsonObject }.getOrNull()
    }

    fun str(key: String) = config?.get(key)?.let { runCatching { it.jsonPrimitive.content }.getOrNull() }

    suspend fun set(key: String, value: String) {
        val old = config ?: return
        val next = JsonObject(old + (key to JsonPrimitive(value)))
        config = next
        val ok = runCatching {
            if (api.server.isEmby) api.raw("POST", "/Users/${api.userId}/Configuration", next.toString())
            else api.raw("POST", "/Users/Configuration", next.toString(), "userId" to api.userId)
        }.isSuccess
        failed = !ok
        if (!ok) config = old
    }
}

@Composable
private fun PlaybackSection(api: Api) {
    val scope = rememberCoroutineScope()
    val snap = LocalSnapshot.current
    val prefs = Wicaby.app.prefs
    val mbpsLabels = MBPS.map { if (it == 0) stringResource(R.string.settings_bitrate_auto) else stringResource(R.string.mbps, it) }
    fun mbpsIndex(v: Int) = MBPS.indexOf(v).coerceAtLeast(0)

    Group(stringResource(R.string.group_quality), stringResource(R.string.bitrate_hint)) {
        ChoiceRow(stringResource(R.string.net_ethernet), mbpsLabels, mbpsIndex(TvSettings.mbpsEthernet.value), { TvSettings.mbpsEthernet.value = MBPS[it] })
        ChoiceRow(stringResource(R.string.net_wifi), mbpsLabels, mbpsIndex(TvSettings.mbpsWifi.value), { TvSettings.mbpsWifi.value = MBPS[it] })
        ChoiceRow(stringResource(R.string.net_remote), mbpsLabels, mbpsIndex(TvSettings.mbpsRemote.value), { TvSettings.mbpsRemote.value = MBPS[it] })
    }
    Group(stringResource(R.string.group_resume)) {
        ChoiceRow(
            stringResource(R.string.resume_mode),
            listOf(stringResource(R.string.resume_auto), stringResource(R.string.resume_ask), stringResource(R.string.resume_start)),
            TvSettings.resume.value, { TvSettings.resume.value = it },
        )
        ToggleRow(stringResource(R.string.autoplay_next), TvSettings.autoplayNext.value) { TvSettings.autoplayNext.value = it }
        if (TvSettings.autoplayNext.value) {
            val secs = listOf(5, 10, 15, 20, 30)
            ChoiceRow(stringResource(R.string.countdown), secs.map { stringResource(R.string.seconds, it) }, secs.indexOf(TvSettings.countdown.value).coerceAtLeast(0), { TvSettings.countdown.value = secs[it] })
        }
    }
    var community by remember { mutableStateOf(CommunitySegments.enabled) }
    Group(stringResource(R.string.group_skip)) {
        ChoiceRow(
            stringResource(R.string.skip_intro_mode),
            listOf(stringResource(R.string.skip_ask), stringResource(R.string.skip_auto), stringResource(R.string.skip_off)),
            TvSettings.skipIntro.value, { TvSettings.skipIntro.value = it },
        )
        // Recaps, previews and commercials are Jellyfin media segments: on Emby, community timestamps bring recaps and previews.
        if (!api.server.isEmby || community) {
            val skipOptions = listOf(stringResource(R.string.skip_ask), stringResource(R.string.skip_auto), stringResource(R.string.skip_off))
            listOfNotNull(
                com.wika.wicaby.core.R.string.segment_recap to TvSettings.skipRecap,
                com.wika.wicaby.core.R.string.segment_preview to TvSettings.skipPreview,
                (com.wika.wicaby.core.R.string.segment_commercial to TvSettings.skipCommercial).takeIf { !api.server.isEmby },
            ).forEach { (label, s) -> ChoiceRow(stringResource(label), skipOptions, s.value, { s.value = it }) }
        }
    }
    Group(stringResource(CoreR.string.aniskip), stringResource(CoreR.string.aniskip_hint)) {
        var aniskip by remember { mutableStateOf(AniSkip.enabled) }
        ToggleRow(stringResource(CoreR.string.aniskip), aniskip) { AniSkip.enabled = it; aniskip = it }
    }
    Group(stringResource(CoreR.string.community_segments), stringResource(CoreR.string.community_segments_summary)) {
        ToggleRow(stringResource(CoreR.string.community_segments), community) { CommunitySegments.enabled = it; community = it }
    }
    Group(stringResource(R.string.group_picture), stringResource(R.string.display_mode_hint)) {
        ChoiceRow(
            stringResource(R.string.settings_display_mode),
            listOf(stringResource(R.string.display_mode_off), stringResource(R.string.display_mode_rate), stringResource(R.string.display_mode_rate_res)),
            snap.displayMode, { scope.launch { prefs.setDisplayMode(it) } },
        )
    }
    Group(stringResource(R.string.group_live)) {
        ToggleRow(stringResource(R.string.settings_livetv_match_frame_rate), TvSettings.liveMatchFrameRate.value) { TvSettings.liveMatchFrameRate.value = it }
        // live.pip (§8.7): only where the system offers PiP (not every Android TV build does).
        if (LocalContext.current.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            ToggleRow(stringResource(R.string.settings_livetv_pip), TvSettings.livePip.value) { TvSettings.livePip.value = it }
        }
    }
    // X-05: where speed and aspect are remembered.
    val context = LocalContext.current
    val scopes = listOf(CoreR.string.scope_off, CoreR.string.scope_global, CoreR.string.scope_library, CoreR.string.scope_title).map { stringResource(it) }
    Group(stringResource(CoreR.string.remember_title)) {
        ChoiceRow(stringResource(CoreR.string.remember_speed), scopes, TvSettings.rememberSpeed.value, { TvSettings.rememberSpeed.value = it })
        ChoiceRow(stringResource(CoreR.string.remember_aspect), scopes, TvSettings.rememberAspect.value, { TvSettings.rememberAspect.value = it })
        ConfirmRow(stringResource(CoreR.string.remember_clear), stringResource(R.string.confirm_clear)) {
            ScopedPrefs.clear()
            Toast.makeText(context, CoreR.string.remember_cleared, Toast.LENGTH_SHORT).show()
        }
    }
}

// The Emby/Jellyfin user configuration (languages, subtitle mode); Plex keeps them in the account (plex-spec §6.4).
@Composable
private fun rememberServerConfig(api: Api): ServerConfig? {
    val server = remember(api) { ServerConfig(api) }
    if (api.server.kind == "plex") return null
    LaunchedEffect(server) { server.load() }
    return server
}

// ---------------------------------------------------------------------------
// Audio.

@Composable
private fun AudioSection(api: Api) {
    val scope = rememberCoroutineScope()
    val server = rememberServerConfig(api)
    if (server != null) Group(stringResource(R.string.group_language), stringResource(if (server.failed) R.string.server_pref_failed else R.string.server_pref_hint)) {
        if (server.config == null) SettingRow(stringResource(R.string.audio_language), stringResource(R.string.loading))
        else ChoiceRow(
            stringResource(R.string.audio_language), LANGS.map { stringResource(it.second) }, LANGS.indexOfFirst { it.first == server.str("AudioLanguagePreference").orEmpty() }.coerceAtLeast(0),
            { i -> scope.launch { server.set("AudioLanguagePreference", LANGS[i].first) } },
        )
    }
    Group(stringResource(CoreR.string.a11y_group), stringResource(CoreR.string.a11y_hint)) {
        ChoiceRow(
            stringResource(CoreR.string.audio_description), AD_PREFS.map { stringResource(it.second) },
            AD_PREFS.indexOfFirst { it.first == TvSettings.audioDescription.value }.coerceAtLeast(0), { TvSettings.audioDescription.value = AD_PREFS[it].first },
        )
    }
    Group(stringResource(R.string.group_passthrough), stringResource(R.string.passthrough_hint)) {
        val passOptions = listOf(stringResource(R.string.pass_auto), stringResource(R.string.pass_on), stringResource(R.string.pass_off))
        TvSettings.PASS_CODECS.forEach { codec ->
            val s = TvSettings.passthrough.getValue(codec)
            ChoiceRow(PASS_LABELS.getValue(codec), passOptions, s.value, { s.value = it })
        }
    }
    // TP-01: desktop's Audio pane effects (core AudioFx); the player's Audio Effects sheet changes the same values.
    Group(stringResource(CoreR.string.audio_fx), stringResource(CoreR.string.audio_fx_hint)) {
        TvSettings.audioFx.forEach { (label, s) -> ToggleRow(stringResource(label), s.value) { s.value = it } }
    }
}

// ---------------------------------------------------------------------------
// Sous-titres.

@Composable
private fun SubtitlesSection(api: Api) {
    val scope = rememberCoroutineScope()
    val server = rememberServerConfig(api)
    if (server != null) Group(stringResource(R.string.group_sub_language), stringResource(if (server.failed) R.string.server_pref_failed else R.string.server_pref_hint)) {
        if (server.config == null) {
            SettingRow(stringResource(R.string.subtitle_language), stringResource(R.string.loading))
        } else {
            ChoiceRow(
                stringResource(R.string.subtitle_language), LANGS.map { stringResource(it.second) }, LANGS.indexOfFirst { it.first == server.str("SubtitleLanguagePreference").orEmpty() }.coerceAtLeast(0),
                { i -> scope.launch { server.set("SubtitleLanguagePreference", LANGS[i].first) } },
            )
            ChoiceRow(
                stringResource(R.string.subtitle_mode), SUB_MODES.map { stringResource(it.second) },
                SUB_MODES.indexOfFirst { it.first == (server.str("SubtitleMode") ?: "Default") }.coerceAtLeast(0),
                { i -> scope.launch { server.set("SubtitleMode", SUB_MODES[i].first) } },
            )
        }
    }
    Group(stringResource(R.string.group_style), stringResource(R.string.subtitle_hint)) {
        ChoiceRow(
            stringResource(R.string.subtitle_size),
            listOf(stringResource(R.string.size_small), stringResource(R.string.size_normal), stringResource(R.string.size_large), stringResource(R.string.size_xlarge)),
            TvSettings.subtitleSize.value, { TvSettings.subtitleSize.value = it },
        )
        ChoiceRow(
            stringResource(R.string.subtitle_style),
            listOf(stringResource(R.string.style_outline), stringResource(R.string.style_shadow), stringResource(R.string.style_box)),
            TvSettings.subtitleStyle.value, { TvSettings.subtitleStyle.value = it },
        )
        ChoiceRow(
            stringResource(R.string.subtitle_font),
            listOf("Geist", stringResource(R.string.font_system), stringResource(R.string.font_serif)),
            TvSettings.subtitleFont.value, { TvSettings.subtitleFont.value = it },
        )
        ChoiceRow(
            stringResource(R.string.subtitle_color),
            listOf(stringResource(R.string.color_white), stringResource(R.string.color_yellow), stringResource(R.string.color_light_gray)),
            TvSettings.subtitleColor.value, { TvSettings.subtitleColor.value = it },
        )
        ChoiceRow(
            stringResource(R.string.subtitle_position), SUB_POSITION_LABELS.map { stringResource(it) },
            TvSettings.subtitlePosition.value, { TvSettings.subtitlePosition.value = it },
        )
        ToggleRow(stringResource(R.string.subtitle_override_ass), TvSettings.subtitleOverrideAss.value) { TvSettings.subtitleOverrideAss.value = it }
    }
    Group(stringResource(CoreR.string.a11y_group), stringResource(CoreR.string.a11y_hint)) {
        ToggleRow(stringResource(CoreR.string.prefer_sdh), TvSettings.preferSdh.value) { TvSettings.preferSdh.value = it }
    }
}

// ---------------------------------------------------------------------------
// Apparence.

@Composable
private fun AppearanceSection(api: Api) {
    val snap = LocalSnapshot.current
    val scope = rememberCoroutineScope()
    val prefs = Wicaby.app.prefs
    // Theme cards and accent circles are not SettingRows: Left from their first item goes back to the section too.
    val section = LocalSectionFocus.current
    val edge = if (section != null) Modifier.focusProperties { left = section } else Modifier
    val firstTheme = TvThemes.first().id
    Group(stringResource(R.string.settings_theme)) {
        // Each card is drawn in its own theme; a click applies it to the whole screen at once.
        ThemeCardRow(C.palette.id, onPick = {
            TvSettings.theme.value = it
            TvSettings.themeHintShown.value = true
        }, cardModifier = { if (it == firstTheme) edge else Modifier })
        Row(
            Modifier.fillMaxWidth().background(C.fill1, RoundedCornerShape(Radius.md)).padding(horizontal = 18.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(stringResource(R.string.settings_accent), style = Type.headline, color = C.label, modifier = Modifier.weight(1f))
            AccentRow(snap.accent, onPick = { scope.launch { prefs.setAccent(it) } }, firstModifier = edge)
        }
    }
    Group(stringResource(R.string.group_display)) {
        ToggleRow(stringResource(R.string.show_clock), TvSettings.clock.value) { TvSettings.clock.value = it }
    }
    Group(stringResource(R.string.group_screensaver), stringResource(R.string.screensaver_hint)) {
        ScreensaverRow()
        ScreensaverSourceRows(api)
    }
}

// ---------------------------------------------------------------------------
// Accueil et bibliothèques.

@Composable
private fun HomeSection(api: Api, tabs: List<TopTab>) {
    HomeGroup(api)
    TabBarGroup(api, tabs)
    RatingsGroup()
    Group(stringResource(R.string.tab_search), stringResource(R.string.search_episodes_hint)) {
        ToggleRow(stringResource(R.string.search_episodes), TvSettings.searchEpisodes.value) { TvSettings.searchEpisodes.value = it }
    }
}

// The MDBList key for IMDb, Rotten Tomatoes… on the detail pages (core/ratings). Off until set; sealed by the Keystore.
@Composable
private fun RatingsGroup() {
    val context = LocalContext.current
    val on by com.wika.wicaby.core.ratings.Ratings.configured.collectAsState()
    var key by remember { mutableStateOf("") }
    fun save(k: String) {
        if (com.wika.wicaby.core.ratings.Ratings.setKey(k)) key = "" else Toast.makeText(context, CoreR.string.ratings_invalid, Toast.LENGTH_SHORT).show()
    }
    Group(stringResource(CoreR.string.ratings_title), stringResource(CoreR.string.ratings_desc)) {
        TvTextField(
            key, { key = it }, stringResource(if (on) CoreR.string.ratings_saved else CoreR.string.ratings_key), Modifier.fillMaxWidth(),
            password = true, onSubmit = { if (key.isNotBlank()) save(key) }, label = stringResource(CoreR.string.ratings_key),
        )
        SettingRow(stringResource(CoreR.string.ratings_save), chevron = true, onClick = { if (key.isNotBlank()) save(key) })
        if (on) SettingRow(stringResource(CoreR.string.ratings_remove), onClick = { save("") })
    }
    Text(stringResource(CoreR.string.ratings_hint), style = Type.footnote, color = C.label3, modifier = Modifier.padding(horizontal = 18.dp))
}

// The 8 accent circles, shared with the wizard's Look step. [onFocus]: the wizard applies a colour as soon as it is
// focused (a live preview); OK picks it either way. [firstModifier]: on the first circle (Réglages: Left to the section).
@Composable
internal fun AccentRow(selected: Int, onPick: (Int) -> Unit, modifier: Modifier = Modifier, onFocus: ((Int) -> Unit)? = null, firstModifier: Modifier = Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Accents.forEachIndexed { i, c ->
            Box(
                (if (i == 0) firstModifier else Modifier)
                    .size(28.dp)
                    .tvFocus(CircleShape, focusedScale = 1.3f, elevation = 10.dp, onFocusChange = { if (it) onFocus?.invoke(i) }, onClick = { onPick(i) })
                    .background(c),
                contentAlignment = Alignment.Center,
            ) {
                if (i == selected) Icon(Ic.Check, null, tint = onAccent(c), modifier = Modifier.size(16.dp))
            }
        }
    }
}

@Composable
internal fun ScreensaverRow() {
    val mins = listOf(0, 2, 5, 10, 15, 30)
    ChoiceRow(
        stringResource(R.string.screensaver_after), mins.map { if (it == 0) stringResource(R.string.never) else stringResource(R.string.minutes, it) },
        mins.indexOf(TvSettings.screensaverMin.value).coerceAtLeast(0), { TvSettings.screensaverMin.value = mins[it] },
    )
}

// Photos spec PH-07: what the screensaver shows (film backdrops by default) and, for photos, from which album or
// library of the photo libraries ("" = every photo).
@Composable
private fun ScreensaverSourceRows(api: Api) {
    val sources = listOf(TvSettings.SCREENSAVER_BACKDROPS, TvSettings.SCREENSAVER_PHOTOS, TvSettings.SCREENSAVER_MEMORIES)
    ChoiceRow(
        stringResource(R.string.screensaver_source),
        listOf(stringResource(R.string.screensaver_source_backdrops), stringResource(R.string.screensaver_source_photos), stringResource(R.string.screensaver_source_memories)),
        sources.indexOf(TvSettings.screensaverSource.value).coerceAtLeast(0), { TvSettings.screensaverSource.value = sources[it] },
    )
    if (TvSettings.screensaverSource.value == TvSettings.SCREENSAVER_BACKDROPS) return
    val albums = rememberLoad("saver-albums") {
        allViews(api).filter { it.collectionType in com.wika.wicaby.tv.ui.photos.PHOTO_COLLECTIONS }.flatMap { lib ->
            listOf(lib.id to lib.name) + api.photoAlbums(lib.id).map { it.id to "${lib.name} · ${it.name}" }
        }
    }.value.value.orEmpty()
    val ids = listOf("") + albums.map { it.first }
    ChoiceRow(
        stringResource(R.string.screensaver_album), listOf(stringResource(R.string.screensaver_album_all)) + albums.map { it.second },
        ids.indexOf(TvSettings.screensaverAlbum.value).coerceAtLeast(0), { TvSettings.screensaverAlbum.value = ids[it] },
    )
}

// Off empties the rows at once; on fills them now when signed in (else at the next sign-in).
@Composable
internal fun HomeChannelsRow() {
    val context = LocalContext.current
    ToggleRow(stringResource(CoreR.string.onboarding_home_channels), TvSettings.homeChannels.value) {
        TvSettings.homeChannels.value = it
        com.wika.wicaby.core.Core.scope.launch {
            if (it) Wicaby.app.api?.let { api -> com.wika.wicaby.tv.data.HomeChannels.sync(context.applicationContext, api) }
            else com.wika.wicaby.tv.data.HomeChannels.clear(context.applicationContext)
        }
    }
}

// TP-07: desktop's "Customize Home" sheet as a list. OK on a row shows or hides it, moves it up or down,
// or switches a Latest row between posters and thumbnails; the home screen follows at once.
@Composable
private fun HomeGroup(api: Api) {
    val overlay = LocalOverlay.current
    val user = homeUser(api)
    val all = rememberLoad("home-views") { allViews(api) }.value.value.orEmpty()
    val views = latestViews(all)
    val merged = TvSettings.mergeContinue.value
    val defaults = homeDefaults(all, merged)
    val pref = TvSettings.homeRows(user, defaults)
    val rows = HomeRows.arrange(defaults, pref)
    fun save(p: HomeRows.Pref) = TvSettings.setHomeRows(user, p)
    val showOnHome by com.wika.wicaby.core.files.FileSources.showOnHome.collectAsState()
    Group(stringResource(R.string.group_home)) {
        ToggleRow(stringResource(R.string.row_hero), TvSettings.rowHero.value) { TvSettings.rowHero.value = it }
        if (TvSettings.rowHero.value) {
            ToggleRow(stringResource(R.string.hero_hide_watched), TvSettings.heroHideWatched.value) { TvSettings.heroHideWatched.value = it }
        }
        ToggleRow(stringResource(R.string.settings_merge_continue), TvSettings.mergeContinue.value) { TvSettings.mergeContinue.value = it }
        // File sources on Home (FS-10, off by default, spec D10).
        ToggleRow(stringResource(CoreR.string.files_home_setting), showOnHome) {
            com.wika.wicaby.core.files.FileSources.setShowOnHome(it)
            Cache.changed()
        }
    }
    Group(stringResource(R.string.group_home_rows), stringResource(R.string.home_rows_hint)) {
        rows.forEachIndexed { i, id ->
            key(id) {
                // Keyed by row: after a move, focus comes back to the row that moved.
                val me = remember { FocusRequester() }
                val label = homeRowLabel(id, views, merged)
                val hidden = id in pref.hidden
                val thumb = id in pref.thumb
                val canThumb = HomeRows.latestViewId(id) != null
                val state = stringResource(if (hidden) R.string.home_row_hidden else R.string.home_row_shown)
                val view = stringResource(if (thumb) R.string.home_row_thumbs else R.string.home_row_posters)
                SettingRow(
                    label, if (canThumb && !hidden) "$state · $view" else state, Modifier.focusRequester(me), chevron = true,
                    onClick = {
                        overlay.show(me) {
                            TvAlert(
                                label, null,
                                buildList {
                                    add(AlertAction(stringResource(if (hidden) R.string.home_row_show else R.string.home_row_hide)) {
                                        overlay.close()
                                        save(pref.copy(order = rows, hidden = if (hidden) pref.hidden - id else pref.hidden + id))
                                    })
                                    if (i > 0) add(AlertAction(stringResource(R.string.home_row_up)) {
                                        overlay.close()
                                        save(pref.copy(order = HomeRows.move(rows, i, i - 1)))
                                    })
                                    if (i < rows.lastIndex) add(AlertAction(stringResource(R.string.home_row_down)) {
                                        overlay.close()
                                        save(pref.copy(order = HomeRows.move(rows, i, i + 1)))
                                    })
                                    if (canThumb) add(AlertAction(stringResource(if (thumb) R.string.home_row_posters else R.string.home_row_thumbs)) {
                                        overlay.close()
                                        save(pref.copy(order = rows, thumb = if (thumb) pref.thumb - id else pref.thumb + id))
                                    })
                                },
                                focusIndex = 0, onDismiss = overlay::close,
                            )
                        }
                    },
                )
            }
        }
        ConfirmRow(stringResource(R.string.home_rows_reset), stringResource(R.string.confirm_reset)) { TvSettings.setHomeRows(user, HomeRows.Pref(order = defaults)) }
    }
}

// #6: the tabs between Accueil and Recherche ([tabs], default order), in the user's order, each shown or hidden.
@Composable
private fun TabBarGroup(api: Api, tabs: List<TopTab>) {
    if (tabs.isEmpty()) return
    val overlay = LocalOverlay.current
    val user = homeUser(api)
    val pref = TvSettings.tabBar(user)
    val keys = HomeRows.arrange(tabs.map { it.key }, pref)
    val labels = tabs.associate { it.key to it.label }
    fun save(p: HomeRows.Pref) = TvSettings.setTabBar(user, p)
    Group(stringResource(R.string.group_tab_bar), stringResource(R.string.tab_bar_hint)) {
        keys.forEachIndexed { i, id ->
            key(id) {
                // Keyed by tab: after a move, focus comes back to the tab that moved.
                val me = remember { FocusRequester() }
                val label = labels.getValue(id)
                val hidden = id in pref.hidden
                SettingRow(
                    label, stringResource(if (hidden) R.string.tab_hidden else R.string.tab_shown), Modifier.focusRequester(me), chevron = true,
                    onClick = {
                        overlay.show(me) {
                            TvAlert(
                                label, null,
                                buildList {
                                    add(AlertAction(stringResource(if (hidden) R.string.home_row_show else R.string.home_row_hide)) {
                                        overlay.close()
                                        save(pref.copy(order = keys, hidden = if (hidden) pref.hidden - id else pref.hidden + id))
                                    })
                                    if (i > 0) add(AlertAction(stringResource(R.string.home_row_up)) {
                                        overlay.close()
                                        save(pref.copy(order = HomeRows.move(keys, i, i - 1)))
                                    })
                                    if (i < keys.lastIndex) add(AlertAction(stringResource(R.string.home_row_down)) {
                                        overlay.close()
                                        save(pref.copy(order = HomeRows.move(keys, i, i + 1)))
                                    })
                                },
                                focusIndex = 0, onDismiss = overlay::close,
                            )
                        }
                    },
                )
            }
        }
        ConfirmRow(stringResource(R.string.tab_bar_reset), stringResource(R.string.confirm_reset)) { TvSettings.setTabBar(user, HomeRows.Pref()) }
    }
}

// ---------------------------------------------------------------------------
// Comptes.

@Composable
private fun AccountsSection(api: Api, user: User?) {
    val nav = LocalNav.current
    val snap = LocalSnapshot.current
    val session = snap.session ?: return
    // Navigate first: signing out drops the api, which disposes this screen and its scope.
    fun leave(route: Route, revoke: Boolean) {
        nav.reset(route)
        com.wika.wicaby.tv.signOutCleanup() // Changer de serveur too: its music must not play on with this token
        com.wika.wicaby.core.Core.scope.launch {
            // A token shared by the phone (pairing) stays valid: revoking it would sign the phone out.
            if (revoke && !session.shared) runCatching { api.raw("POST", "/Sessions/Logout") }
            // TP-10: signing out forgets the saved profile (and its PIN); Changer d’utilisateur keeps it.
            if (revoke) Wicaby.app.prefs.removeProfile(session.server.id, session.userId)
            Wicaby.app.prefs.signOut()
        }
    }
    Row(Modifier.padding(start = 18.dp, bottom = 22.dp), verticalAlignment = Alignment.CenterVertically) {
        UserAvatar(user, api, session.userName, 64.dp)
        Column(Modifier.padding(start = 18.dp)) {
            Text(session.userName, style = Type.title2, color = C.label)
            Text("${session.server.name} · ${session.server.address}", style = Type.footnote, color = C.label3)
        }
    }
    Group(stringResource(R.string.group_user)) {
        SettingRow(stringResource(R.string.switch_user), chevron = true, onClick = { nav.push(Route.Login(session.server)) })
        SettingRow(stringResource(R.string.switch_server), chevron = true, onClick = { leave(Route.Servers, false) })
        val signOut = stringResource(R.string.sign_out)
        ConfirmRow(signOut, signOut) { leave(Route.Login(session.server), true) }
    }
    ProfileGroup(session)
    // Plex: its addresses come from plex.tv (PlexAccounts.connect), not from this list.
    if (session.server.kind == "plex") PlexAccountGroup(session.server) { leave(Route.Servers, false) } else AddressesGroup(session.server)
    OtherServers()
    TraktSection()
    ScrobbleSection()
}

// B09: the server's local and remote addresses; requests go to whichever answers (Core.addresses).
@Composable
private fun AddressesGroup(server: com.wika.wicaby.core.data.Server) {
    val overlay = LocalOverlay.current
    val me = remember { FocusRequester() }
    var nonce by remember { androidx.compose.runtime.mutableIntStateOf(0) }
    val known = remember(nonce) { com.wika.wicaby.core.Core.addresses.known(server.id) }
    val inUse = remember(nonce) { com.wika.wicaby.core.Core.addresses.inUse(server) }
    val none = stringResource(CoreR.string.server_address_none)
    fun open() = overlay.show(me) { AddressesSheet(server, known) { overlay.close(); nonce++ } }
    Group(stringResource(CoreR.string.server_addresses), stringResource(CoreR.string.server_addresses_hint)) {
        SettingRow(stringResource(CoreR.string.server_address_local), known.local ?: none, Modifier.focusRequester(me), chevron = true, onClick = ::open)
        SettingRow(stringResource(CoreR.string.server_address_remote), known.remote ?: none, chevron = true, onClick = ::open)
        SettingRow(stringResource(CoreR.string.server_address_in_use), inUse)
    }
}

@Composable
private fun AddressesSheet(server: com.wika.wicaby.core.data.Server, known: com.wika.wicaby.core.net.KnownAddresses, onDone: () -> Unit) {
    var local by remember { mutableStateOf(known.local.orEmpty()) }
    var remote by remember { mutableStateOf(known.remote.orEmpty()) }
    var invalid by remember { mutableStateOf(false) }
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    fun save() {
        if (com.wika.wicaby.core.Core.addresses.edit(server, local, remote)) onDone() else invalid = true
    }
    TvSheet(onDone, width = 560.dp) {
        Text(stringResource(CoreR.string.server_addresses), style = Type.title3, color = C.label, modifier = Modifier.padding(bottom = 18.dp))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val localLabel = stringResource(CoreR.string.server_address_local)
            val remoteLabel = stringResource(CoreR.string.server_address_remote)
            Text(localLabel, style = Type.footnote, color = C.label3, modifier = Modifier.padding(start = 4.dp))
            TvTextField(local, { local = it; invalid = false }, "http://192.168.1.10:8096", Modifier.fillMaxWidth().focusRequester(first), imeAction = androidx.compose.ui.text.input.ImeAction.Next, label = localLabel)
            Text(remoteLabel, style = Type.footnote, color = C.label3, modifier = Modifier.padding(start = 4.dp, top = 6.dp))
            TvTextField(remote, { remote = it; invalid = false }, "https://media.example.org", Modifier.fillMaxWidth(), onSubmit = ::save, label = remoteLabel)
            if (invalid) Text(stringResource(CoreR.string.server_address_invalid), style = Type.footnote, color = C.red, modifier = Modifier.padding(start = 4.dp))
            SheetButton(stringResource(CoreR.string.server_address_save), onClick = ::save, modifier = Modifier.padding(top = 10.dp))
        }
    }
}

// TP-10: "Who is watching?" at start, and this account's PIN on this TV.
@Composable
private fun ProfileGroup(session: com.wika.wicaby.core.data.Session) {
    val snap = LocalSnapshot.current
    val overlay = LocalOverlay.current
    val prefs = Wicaby.app.prefs
    val hasPin = snap.profiles.any { it.hasPin && it.session.server.id == session.server.id && it.session.userId == session.userId }
    val me = remember { FocusRequester() }
    val change = stringResource(R.string.pin_change)
    val remove = stringResource(R.string.pin_remove)
    val cancel = stringResource(R.string.cancel)
    fun setPin() = overlay.show(me) { SetPinSheet(overlay::close) { prefs.setPin(session, it) } }
    Group(stringResource(R.string.who_is_watching), stringResource(R.string.profiles_hint)) {
        ToggleRow(stringResource(R.string.profile_skip_single), snap.skipPicker) { com.wika.wicaby.core.Core.scope.launch { prefs.setSkipPicker(it) } }
        SettingRow(stringResource(R.string.profile_pin), stringResource(if (hasPin) R.string.on else R.string.off), Modifier.focusRequester(me), chevron = true, onClick = {
            if (!hasPin) setPin() else overlay.show(me) {
                TvAlert(
                    stringResource(R.string.profile_pin), null,
                    listOf(
                        AlertAction(change) { overlay.close(); setPin() },
                        AlertAction(remove, destructive = true) { overlay.close(); com.wika.wicaby.core.Core.scope.launch { prefs.setPin(session, null) } },
                        AlertAction(cancel) { overlay.close() },
                    ),
                    focusIndex = 0, onDismiss = overlay::close,
                )
            }
        })
    }
}

// TP-06: the other signed-in servers, merged into Accueil and Recherche. OK on one offers to remove it.
@Composable
private fun OtherServers() {
    val nav = LocalNav.current
    val overlay = LocalOverlay.current
    val extras = LocalSnapshot.current.extras.filter { it.server.id != LocalSnapshot.current.session?.server?.id }
    // The removed row disappears: focus moves to "Ajouter un serveur", which always stays.
    val add = remember { FocusRequester() }
    Group(stringResource(R.string.other_servers), stringResource(R.string.other_servers_hint)) {
        extras.forEach { e ->
            val me = remember { FocusRequester() }
            val remove = stringResource(R.string.remove_server)
            val cancel = stringResource(R.string.cancel)
            SettingRow(e.server.name, e.userName, Modifier.focusRequester(me), onClick = {
                overlay.show(me) {
                    TvAlert(
                        e.server.name, e.server.address,
                        listOf(
                            AlertAction(remove, destructive = true) {
                                overlay.close()
                                runCatching { add.requestFocus() }
                                // Not revoked on the server: the token may serve elsewhere. The rows reload (App()).
                                com.wika.wicaby.core.Core.scope.launch { Wicaby.app.prefs.removeAccount(e.server.id) }
                            },
                            AlertAction(cancel) { overlay.close() },
                        ),
                        focusIndex = 1, onDismiss = overlay::close,
                    )
                }
            })
        }
        SettingRow(stringResource(R.string.add_server), modifier = Modifier.focusRequester(add), chevron = true, onClick = { nav.push(Route.AddServer) })
    }
}

// ---------------------------------------------------------------------------
// À propos.

private val LICENCES = listOf(
    R.string.licence_ffmpeg to "GPL v3",
    R.string.licence_libass to "ISC",
    R.string.licence_geist to "SIL OFL 1.1",
    R.string.licence_androidx to "Apache 2.0",
    R.string.licence_coil to "Apache 2.0",
    R.string.licence_libarchive to "BSD 2",
)

@Composable
private fun AboutSection() {
    val context = LocalContext.current
    // Resolved off the main thread below; LocalResources follows configuration changes.
    val res = LocalResources.current
    Group(null) {
        SettingRow(stringResource(R.string.app_name), stringResource(R.string.version_full, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE))
    }
    Group(stringResource(CoreR.string.settings_updates)) {
        UpdateRows()
    }
    Group(stringResource(R.string.group_licences), stringResource(R.string.plex_tv_not_affiliated)) {
        LICENCES.forEach { (name, lic) -> SettingRow(stringResource(name), lic) }
    }
    val dump by produceState<List<Pair<String, String>>?>(null) {
        value = withContext(Dispatchers.Default) {
            runCatching {
                val caps = DeviceCaps.caps(context)
                val pass = DeviceCaps.passthrough(context)
                val video = caps.video.entries.sortedBy { it.key }.map { (codec, v) ->
                    val fps = v.maxFpsAtMax.takeIf { it > 0 }?.let { res.getString(R.string.codec_fps, it) }
                    val ranges = v.ranges.joinToString(", ") { it.name }.ifEmpty { null }
                    val bits = if (v.tenBit) res.getString(R.string.codec_10bit) else null
                    codec.uppercase() to listOfNotNull("${v.maxWidth}×${v.maxHeight}", fps, bits, ranges).joinToString(" · ")
                }
                video + listOf(
                    res.getString(R.string.audio_decoders) to caps.audio.sorted().joinToString(", ").ifEmpty { res.getString(R.string.none) },
                    res.getString(R.string.passthrough) to pass.sorted().joinToString(", ").ifEmpty { res.getString(R.string.none) },
                )
            }.getOrDefault(emptyList())
        }
    }
    Group(stringResource(R.string.group_device)) {
        SettingRow(stringResource(R.string.device_model), "${Build.MANUFACTURER} ${Build.MODEL}")
        SettingRow(stringResource(R.string.android_version), "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
        val d = dump
        if (d == null) SettingRow(stringResource(R.string.video_decoders), stringResource(R.string.loading))
        else d.forEach { (k, v) -> SettingRow(k, v, mono = true) }
    }
}

// Sideloaded updates: the manifest URL (empty = off) and a manual check. A newer version opens
// the update card (App() shows it whenever the state becomes Available).
@Composable
private fun UpdateRows() {
    val overlay = LocalOverlay.current
    val scope = rememberCoroutineScope()
    val snap = LocalSnapshot.current
    val state by com.wika.wicaby.core.update.Updater.state.collectAsState()
    val me = remember { FocusRequester() }
    SettingRow(
        stringResource(com.wika.wicaby.core.R.string.update_url),
        com.wika.wicaby.core.update.UpdateLogic.manifestUrl(snap.updateUrl),
        Modifier.focusRequester(me), chevron = true,
        onClick = {
            overlay.show(me) {
                UpdateUrlSheet(snap.updateUrl, onSave = { v ->
                    scope.launch { Wicaby.app.prefs.setUpdateUrl(v) }
                    overlay.close()
                }, onDismiss = overlay::close)
            }
        },
    )
    run {
        val status = when (val s = state) {
            com.wika.wicaby.core.update.UpdateState.Checking -> stringResource(com.wika.wicaby.core.R.string.update_checking)
            com.wika.wicaby.core.update.UpdateState.UpToDate -> stringResource(com.wika.wicaby.core.R.string.update_up_to_date)
            is com.wika.wicaby.core.update.UpdateState.Failed -> s.message
            else -> null
        }
        SettingRow(stringResource(com.wika.wicaby.core.R.string.update_check), status, onClick = {
            scope.launch { com.wika.wicaby.core.update.Updater.check(manual = true) }
        })
    }
}

// ---------------------------------------------------------------------------
// Sources: the file sources of this TV and Add (FS-10), the photo sources, the music source.

@Composable
private fun FilesSection() {
    val overlay = LocalOverlay.current
    val sources by com.wika.wicaby.core.files.FileSources.list.collectAsState()
    val add = remember { FocusRequester() }
    Group(stringResource(CoreR.string.files_title)) {
        sources.forEach { s ->
            key(s.id) {
                val me = remember { FocusRequester() }
                val signIn = com.wika.wicaby.core.files.FileSources.needsSignIn(s)
                // Sign in again (§7.1) or remove: the same actions as the tile's Menu key.
                SettingRow(s.name, (if (signIn) stringResource(CoreR.string.files_sign_in_again) else s.label).ifEmpty { null }, Modifier.focusRequester(me), chevron = true, onClick = {
                    showSourceActions(overlay, me, s)
                })
            }
        }
        SettingRow(stringResource(CoreR.string.files_add), modifier = Modifier.focusRequester(add), chevron = true, onClick = {
            overlay.show(add) { AddFileSourceSheet(onDismiss = overlay::close) }
        })
    }
    // Photo folders and the Immich photo source (photos spec PH-13).
    com.wika.wicaby.tv.ui.photos.ImmichGroup()
    // "Source de la musique": which signed-in server the Music tab shows (core MusicSource).
    val music = com.wika.wicaby.core.music.MusicSource.choices(stringResource(CoreR.string.music_source_auto))
    val chosen = remember(com.wika.wicaby.core.music.MusicSource.version) { com.wika.wicaby.core.music.MusicSource.current() }
    Group(stringResource(R.string.group_music), stringResource(CoreR.string.music_source_hint)) {
        ChoiceRow(stringResource(CoreR.string.music_source), music.map { it.second }, music.indexOfFirst { it.first == chosen }.coerceAtLeast(0), { com.wika.wicaby.core.music.MusicSource.set(music[it].first) })
    }
}
