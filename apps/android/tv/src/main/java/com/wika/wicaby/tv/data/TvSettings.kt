package com.wika.wicaby.tv.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.edit
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.data.HomeRows
import com.wika.wicaby.core.livetv.LiveSession
import com.wika.wicaby.core.livetv.ReleaseMode
import com.wika.wicaby.core.net.ServerTransport
import com.wika.wicaby.core.player.AudioFx
import com.wika.wicaby.core.player.SegmentKind
import com.wika.wicaby.core.player.ScopedPrefs
import com.wika.wicaby.tv.Wicaby

// TV-only preferences. SharedPreferences, so the player can read them synchronously
// (it may start from a launcher deep link before any screen loaded), backed by Compose
// state so the Réglages screen and the home screen recompose on change. Account, accent,
// display mode and the legacy bitrate stay in :core Prefs (shared with mobile).
object TvSettings {
    // Declared first: the settings below read them while the object initializes.
    val PASS_CODECS = listOf("ac3", "eac3", "dts", "truehd")

    private val sp by lazy { Wicaby.app.getSharedPreferences("wicaby_tv", Context.MODE_PRIVATE) }

    class IntSetting internal constructor(private val key: String, default: Int) {
        private val state = mutableIntStateOf(sp.getInt(key, default))
        var value: Int
            get() = state.intValue
            set(v) {
                state.intValue = v
                sp.edit { putInt(key, v) }
                onChange()
            }
    }

    class BoolSetting internal constructor(private val key: String, default: Boolean) {
        private val state = mutableStateOf(sp.getBoolean(key, default))
        var value: Boolean
            get() = state.value
            set(v) {
                state.value = v
                sp.edit { putBoolean(key, v) }
                onChange()
            }
    }

    class StringSetting internal constructor(private val key: String, default: String) {
        private val state = mutableStateOf(sp.getString(key, default) ?: default)
        var value: String
            get() = state.value
            set(v) {
                state.value = v
                sp.edit { putString(key, v) }
                onChange()
            }
    }

    // Lecture
    val mbpsEthernet = IntSetting("mbps_ethernet", 0) // 0 = auto
    val mbpsWifi = IntSetting("mbps_wifi", 0)
    val mbpsRemote = IntSetting("mbps_remote", 20)
    val autoplayNext = BoolSetting("autoplay_next", true)
    val countdown = IntSetting("countdown_s", 15)
    val skipIntro = IntSetting("skip_intro", SKIP_ASK)
    // Jellyfin media segments (Segments.kt); Emby servers only have intros.
    val skipRecap = IntSetting("skip_recap", SKIP_ASK)
    val skipPreview = IntSetting("skip_preview", SKIP_ASK)
    val skipCommercial = IntSetting("skip_commercial", SKIP_ASK)
    val resume = IntSetting("resume", RESUME_AUTO)
    // Indexes into core SubtitleLook's lists (desktop playback.subtitleStyle).
    val subtitleSize = IntSetting("sub_size", 1)
    val subtitleStyle = IntSetting("sub_style", 0) // 0 outline, 1 shadow, 2 box
    val subtitleFont = IntSetting("sub_font", 0)
    val subtitleColor = IntSetting("sub_color", 0)
    val subtitlePosition = IntSetting("sub_pos", 0)
    val subtitleOverrideAss = BoolSetting("sub_ass_override", false)
    val passthrough = PASS_CODECS.associateWith { IntSetting("pass_$it", PASS_AUTO) }
    // Audio effects on decoded PCM (core AudioFx; desktop playback.dialogueBoost, nightMode, normalize, volumeBoost).
    val audioDialogue = BoolSetting("audio_dialogue", false)
    val audioNight = BoolSetting("audio_night", false)
    val audioNormalize = BoolSetting("audio_normalize", false)
    val audioBoost = BoolSetting("audio_boost", false)
    // Label and setting of each effect, in desktop's order (Réglages and the player's Audio Effects sheet).
    val audioFx get() = listOf(R.string.audio_fx_normalize to audioNormalize, R.string.audio_fx_boost to audioBoost, R.string.audio_fx_night to audioNight, R.string.audio_fx_dialogue to audioDialogue)
    // "Play on" target for the official Emby/Jellyfin apps (X-06).
    val remoteControl = BoolSetting("remote_control", true)
    // X-05 "Mémoriser les réglages": ScopedPrefs.Scope ordinals (off, global, library, title).
    val rememberSpeed = IntSetting("remember_speed", ScopedPrefs.Scope.Global.ordinal)
    val rememberAspect = IntSetting("remember_aspect", ScopedPrefs.Scope.Title.ordinal)

    // Interface
    val clock = BoolSetting("clock", true)
    val oled = BoolSetting("oled", false) // desktop ui.theme 'oled' (pure black)
    val rowHero = BoolSetting("row_hero", true)
    // The hero carousel picks unwatched movies and series only (series: not every episode watched).
    val heroHideWatched = BoolSetting("hero_hide_watched", false)
    val rowResume = BoolSetting("row_resume", true)
    val rowNextUp = BoolSetting("row_nextup", true)
    // X-01: "Continuer" and "À suivre" as one "Continuer à regarder" row (ContinueWatching.kt).
    val mergeContinue = BoolSetting("merge_continue", true)
    val rowLatest = BoolSetting("row_latest", true)
    val screensaverMin = IntSetting("screensaver_min", 0) // 0 = off
    // Photos spec PH-07: SCREENSAVER_BACKDROPS (the default: film and series artwork), SCREENSAVER_PHOTOS or
    // SCREENSAVER_MEMORIES ("Ce jour-là"), from screensaverAlbum (an album or library id; "" = every photo).
    val screensaverSource = StringSetting("screensaver_source", SCREENSAVER_BACKDROPS)
    val screensaverAlbum = StringSetting("screensaver_album", "")
    // Photos spec F11: the slideshow's interval (s) and its Ken Burns option (a plain fade by default).
    val photoInterval = IntSetting("photo_interval_s", 5)
    val photoKenBurns = BoolSetting("photo_ken_burns", false)
    // OB-X: the launcher's Wicaby rows (HomeChannels); off empties them.
    val homeChannels = BoolSetting("home_channels", true)

    // TP-07: home rows order, hidden and thumbnail rows per `serverId/userId` (core HomeRows, desktop ui.homeRows).
    // Until the user changes them, the older Continue / Up Next / Latest toggles above say what is hidden.
    private val homeVersion = mutableIntStateOf(0)

    fun homeRows(user: String, defaults: List<String>): HomeRows.Pref {
        homeVersion.intValue // read, so the home screen and Réglages recompose on a save
        return HomeRows.decode(sp.getString("home_rows:$user", null)) ?: HomeRows.Pref(
            hidden = defaults.filter {
                when {
                    it == HomeRows.RESUME -> !rowResume.value
                    it == HomeRows.NEXT_UP -> !rowNextUp.value
                    else -> HomeRows.latestViewId(it) != null && !rowLatest.value
                }
            }.toSet(),
        )
    }

    fun setHomeRows(user: String, pref: HomeRows.Pref) {
        sp.edit { putString("home_rows:$user", HomeRows.encode(pref)) }
        homeVersion.intValue++
    }

    // #6: tab bar order and hidden tabs per `serverId/userId` (ui/TabOrder; `thumb` is unused).
    private val tabVersion = mutableIntStateOf(0)

    fun tabBar(user: String): HomeRows.Pref {
        tabVersion.intValue // read, so the tab bar and Réglages recompose on a save
        return HomeRows.decode(sp.getString("tab_bar:$user", null)) ?: HomeRows.Pref()
    }

    fun setTabBar(user: String, pref: HomeRows.Pref) {
        sp.edit { putString("tab_bar:$user", HomeRows.encode(pref)) }
        tabVersion.intValue++
    }

    // TV en direct (livetv spec §15, TV defaults). Device-only; lens, favourites, recents… are synced (LivePrefs).
    val liveStartTab = IntSetting("live_start_tab", LIVE_START_NOW)
    val liveUpDown = IntSetting("live_up_down", LIVE_UPDOWN_ZAP)
    val liveBackAction = IntSetting("live_back_action", LIVE_BACK_GUIDE)
    val liveEnterOnAiring = IntSetting("live_enter_on_airing", LIVE_ENTER_TUNE)
    val liveRelease = IntSetting("live_release", 0) // ReleaseMode ordinal: auto, always, never
    val liveBannerSeconds = IntSetting("live_banner_s", 4) // 2–10
    val liveBannerOnProgramChange = BoolSetting("live_banner_on_program_change", true)
    val liveDigitTimeoutMs = IntSetting("live_digit_timeout_ms", 1800) // 1000–5000 (§21.7)
    val liveGuideDetailBand = BoolSetting("live_guide_detail_band", true)
    val liveReminderLeadMin = IntSetting("live_reminder_lead_min", 2) // 0, 1, 2, 5, 10
    val liveReminderAutoTune = BoolSetting("live_reminder_auto_tune", false)
    val livePip = BoolSetting("live_pip", false)
    val liveMatchFrameRate = BoolSetting("live_match_frame_rate", false) // off until measured on the set (§21.5, V20)

    const val SCREENSAVER_BACKDROPS = "backdrops"
    const val SCREENSAVER_PHOTOS = "photos"
    const val SCREENSAVER_MEMORIES = "memories"

    const val LIVE_START_NOW = 0
    const val LIVE_START_GUIDE = 1
    const val LIVE_START_LAST = 2

    const val LIVE_UPDOWN_VOLUME = 0
    const val LIVE_UPDOWN_ZAP = 1

    const val LIVE_BACK_GUIDE = 0
    const val LIVE_BACK_EXIT = 1
    const val LIVE_BACK_LAST = 2

    const val LIVE_ENTER_TUNE = 0
    const val LIVE_ENTER_DETAILS = 1

    const val SKIP_ASK = 0
    const val SKIP_AUTO = 1
    const val SKIP_OFF = 2

    const val RESUME_AUTO = 0
    const val RESUME_ASK = 1
    const val RESUME_START = 2

    const val PASS_AUTO = 0
    const val PASS_ON = 1
    const val PASS_OFF = 2

    // SKIP_ASK / SKIP_AUTO / SKIP_OFF for a kind of segment.
    fun skipMode(kind: SegmentKind): Int = when (kind) {
        SegmentKind.Intro -> skipIntro
        SegmentKind.Recap -> skipRecap
        SegmentKind.Preview -> skipPreview
        SegmentKind.Commercial -> skipCommercial
    }.value

    private fun onChange() = applyToCore()

    // Pushes what :core reads (DeviceProfile and the audio sink) out of the TV prefs.
    fun applyToCore() {
        Core.passthroughOverride = buildMap {
            passthrough.forEach { (codec, s) ->
                when (s.value) {
                    PASS_ON -> put(codec, true)
                    PASS_OFF -> put(codec, false)
                }
            }
        }
        Core.remoteControl = remoteControl.value
        AudioFx.config = AudioFx.Config(audioDialogue.value, audioNight.value, audioNormalize.value, audioBoost.value)
        fun scope(s: IntSetting) = ScopedPrefs.Scope.entries[s.value.coerceIn(0, ScopedPrefs.Scope.entries.lastIndex)]
        ScopedPrefs.scopes = mapOf(ScopedPrefs.SPEED to scope(rememberSpeed), ScopedPrefs.ASPECT to scope(rememberAspect))
        LiveSession.shared.release = ReleaseMode.entries[liveRelease.value.coerceIn(0, ReleaseMode.entries.lastIndex)]
        com.wika.wicaby.tv.ui.C.oled = oled.value
    }

    // The streaming cap for the network we are on: Ethernet, Wi-Fi, or remote (through the mesh).
    fun maxMbpsNow(context: Context, origin: String): Int {
        val remote = Core.transport !== ServerTransport.Direct && runCatching { Core.transport.forward(origin) }.getOrNull() != null
        if (remote) return mbpsRemote.value
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val caps = runCatching { cm?.getNetworkCapabilities(cm.activeNetwork) }.getOrNull()
        return when {
            caps?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true -> mbpsEthernet.value
            caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true -> mbpsWifi.value
            else -> mbpsWifi.value
        }
    }
}
