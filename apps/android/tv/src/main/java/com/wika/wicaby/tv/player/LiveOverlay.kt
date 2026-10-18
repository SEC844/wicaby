package com.wika.wicaby.tv.player

import com.wika.wicaby.core.player.qualityLabel
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityManager
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.edit
import androidx.media3.common.Player
import androidx.tv.material3.Icon
import androidx.tv.material3.Text
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.livetv.ChannelRow
import com.wika.wicaby.core.livetv.DIGIT_MAX_CHARS
import com.wika.wicaby.core.livetv.DigitPreview
import com.wika.wicaby.core.livetv.DigitResult
import com.wika.wicaby.core.livetv.Dialect
import com.wika.wicaby.core.livetv.DvrError
import com.wika.wicaby.core.livetv.DvrOp
import com.wika.wicaby.core.livetv.GuideClock
import com.wika.wicaby.core.livetv.JUMP_TIMEOUT_MS
import com.wika.wicaby.core.livetv.LensInput
import com.wika.wicaby.core.livetv.LensPrefs
import com.wika.wicaby.core.livetv.LensRef
import com.wika.wicaby.core.livetv.LiveApiException
import com.wika.wicaby.core.livetv.LiveState
import com.wika.wicaby.core.livetv.LiveTvPrefs
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.PF
import com.wika.wicaby.core.livetv.PendingJump
import com.wika.wicaby.core.livetv.ProgramLite
import com.wika.wicaby.core.livetv.Reminder
import com.wika.wicaby.core.livetv.Reminders
import com.wika.wicaby.core.livetv.TimerLite
import com.wika.wicaby.core.livetv.TimerStatus
import com.wika.wicaby.core.livetv.Viewport
import com.wika.wicaby.core.livetv.ZapController
import com.wika.wicaby.core.livetv.ZapEntry
import com.wika.wicaby.core.livetv.applyLens
import com.wika.wicaby.core.livetv.fireAt
import com.wika.wicaby.core.livetv.mapDvrError
import com.wika.wicaby.core.livetv.quickRecordBody
import com.wika.wicaby.core.livetv.stepLens
import com.wika.wicaby.core.livetv.zapEntry
import com.wika.wicaby.core.player.Aspect
import com.wika.wicaby.core.player.Playback
import com.wika.wicaby.tv.BuildConfig
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.Wicaby
import com.wika.wicaby.tv.data.TvSettings
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Ic
import com.wika.wicaby.tv.ui.LocalOverlay
import com.wika.wicaby.tv.ui.OverlayHost
import com.wika.wicaby.tv.ui.OverlayLayer
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.TvFocus
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.livetv.ChannelLogo
import com.wika.wicaby.tv.ui.livetv.GuideSearch
import com.wika.wicaby.tv.ui.livetv.LIVE_TAG
import com.wika.wicaby.tv.ui.livetv.LiveProgress
import com.wika.wicaby.tv.ui.livetv.LiveTv
import com.wika.wicaby.tv.ui.livetv.RecordOptionsSheet
import com.wika.wicaby.tv.ui.livetv.RecordTarget
import com.wika.wicaby.tv.ui.livetv.dvrOf
import com.wika.wicaby.tv.ui.livetv.minutesText
import com.wika.wicaby.tv.ui.livetv.text
import com.wika.wicaby.tv.ui.livetv.progressOf
import com.wika.wicaby.tv.ui.livetv.timeText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import java.util.TimeZone
import android.view.KeyEvent as K
import com.wika.wicaby.core.R as CR

// The live side of the TV player (livetv spec §8.3–§8.8, §10.2; TV-3): the zap list and CH±, the number
// buffer, the info banner and its detail panel, the mini-guide, the live menu, the tune, radio and
// pause-release cards and the colour-key coach mark. The player's key catcher asks [LiveControl.onKey]
// before its VOD branch; nothing here takes focus (one focus node, like the guide).

private const val HOUR = 3_600_000L
private const val GUIDE_PAGE = 8

private enum class MenuItem { TRACKS, FAVORITE, RECORD, LAST, QUALITY, ASPECT, WATCH, DETAILS }
private enum class DetailAction { WATCH, RECORD, REMIND }

/** F2: the airing programme of the adopted channel is being recorded since [since]. */
class StartAsk(val timer: TimerLite, val since: Long)

class LiveControl(
    private val context: Context,
    val pb: Playback,
    private val player: Player,
    val repo: LiveTvRepository,
    private val scope: CoroutineScope,
    private val onTracks: () -> Unit,
    private val onAspect: () -> Unit,
    private val onExit: () -> Unit,
    /** The player's key catcher: sheets (search, record options) give focus back to it. */
    private val root: FocusRequester,
    /** F2 deep link `start=beginning|live`: pre-answers the watch-from-start prompt of the first channel. */
    private var startMode: String?,
    /** X-02: the Quality sheet (the cap only on live). */
    private val onQuality: () -> Unit = {},
) {
    val zap = ZapController(scope, onTune = { id -> pb.tune(byId[id]?.let(::zapEntry) ?: ZapEntry(id, "", id)) })
        .apply { digitTimeoutMs = TvSettings.liveDigitTimeoutMs.value.toLong() }

    var byId by mutableStateOf<Map<String, ChannelRow>>(emptyMap()); private set
    /** The zap list's lens (null until the lineup is known) and its rows. */
    var lens by mutableStateOf<LensRef?>(null); private set
    var rows by mutableStateOf<List<ChannelRow>>(emptyList()); private set

    var banner by mutableStateOf(false); private set
    var bannerNonce by mutableIntStateOf(0); private set
    /** Banner browse: 0 = airing, 1 = next, … (§8.5). */
    var browse by mutableIntStateOf(0); private set
    var detail by mutableStateOf(false); private set
    var detailIndex by mutableIntStateOf(0); private set
    /** The banner and its detail panel show this channel (INFO in the mini-guide) instead of the zap target. */
    var detailId by mutableStateOf<String?>(null); private set

    var guide by mutableStateOf(false); private set
    var guideLens by mutableStateOf<LensRef>(LensRef.All); private set
    var guideRows by mutableStateOf<List<ChannelRow>>(emptyList()); private set
    var guideFocus by mutableIntStateOf(0); private set
    var guideNonce by mutableIntStateOf(0); private set
    /** guideNonce when OK tuned: the list closes 1.5 s later unless another key came. */
    var closeTag by mutableIntStateOf(-1); private set

    var menu by mutableStateOf(false); private set
    var menuIndex by mutableIntStateOf(0); private set
    /** MENU in the mini-guide: the channel menu of this channel; null = the live menu. */
    var menuFor by mutableStateOf<String?>(null); private set

    /** F2 prompt: 0 = from the start, 1 = live (the default). */
    var ask by mutableStateOf<StartAsk?>(null)
    var askIndex by mutableIntStateOf(1); private set
    private var askedFor: String? = null

    /** Search and record-options sheets, over the video (the player has no app overlay layer). */
    val host = OverlayHost()

    var toast by mutableStateOf<String?>(null)
    var toastNonce by mutableIntStateOf(0); private set
    var coach by mutableStateOf(false)

    /** Debug: the key's event time, for the key → banner budget (§16.2, 100 ms). */
    var keyAt = 0L

    private var adoptedId: String? = null
    private var okDown = false
    private var okLong = false
    private var redDown = false
    private var redLong = false
    private var redTarget: ProgramLite? = null
    private var jumpBuf = ""
    private var jumpAt = 0L
    private val owned = HashSet<Int>()

    // ---- Data ----

    private fun lensRows(l: LensRef, ch: List<ChannelRow> = repo.channels.value, p: LiveTvPrefs = repo.prefs.prefs.value) =
        applyLens(LensInput(ch, l, LensPrefs(p.fav, p.hidden, p.groups, p.recents), p.sort, p.favFirst))

    /** The lineup or the synced prefs changed: the zap list follows (the player starts on the synced lens, else Toutes). */
    fun sync(channels: List<ChannelRow>, p: LiveTvPrefs) {
        byId = channels.associateBy { it.id }
        if (channels.isEmpty()) return
        val cur = pb.liveState?.channel?.id
        useLens(lens ?: p.lens.takeIf { l -> lensRows(l, channels, p).any { it.id == cur } } ?: LensRef.All)
        if (guide) guideRows = lensRows(guideLens)
    }

    private fun useLens(l: LensRef) {
        val p = repo.prefs.prefs.value
        lens = l
        rows = lensRows(l)
        zap.setList(rows.map(::zapEntry), p.hidden, repo.lineup())
    }

    fun lensName(l: LensRef?): String = when (l) {
        null, LensRef.All -> context.getString(CR.string.livetv_lens_all)
        LensRef.Favorites -> context.getString(CR.string.livetv_lens_favorites)
        LensRef.Recents -> context.getString(CR.string.livetv_lens_recents)
        LensRef.Radio -> context.getString(CR.string.livetv_lens_radio)
        is LensRef.Tag -> l.tag
        is LensRef.Group -> repo.prefs.prefs.value.groups.firstOrNull { it.id == l.id }?.name.orEmpty()
    }

    fun row(id: String, fallback: ZapEntry? = null): ChannelRow? = byId[id]
        ?: fallback?.let { ChannelRow(it.id, repo.api.serverId, it.number, null, it.name, it.logoTag, false, emptyList(), false, 0) }

    /** The airing programme (null in a guide gap, e.g. a channel off the air at night) and the ones after it, from the cache. */
    fun programsOf(id: String, now: Long = repo.now()): List<ProgramLite?> {
        val list = repo.programs(id, now, now + 12 * HOUR).filter { it.end > now }
        return if (list.firstOrNull()?.let { it.start <= now } == true) list else listOf(null) + list
    }

    /** The channel the banner shows: the merged zap target, else the tune in flight, else the adopted one. */
    fun bannerId(): String? = detailId ?: zap.state.value.pending ?: pb.liveState?.let { it.pending?.id ?: it.channel.id }

    fun bannerProgram(): ProgramLite? = bannerId()?.let { programsOf(it).getOrNull(browse) }

    /** Session state: the zap controller learns adoptions and failures; a channel outside the lens switches to Toutes. */
    fun onState(s: LiveState?) {
        s ?: return
        if (zap.state.value.current == null) zap.adopted(s.channel.id)
        if (adoptedId == null && !banner) showBanner()
        if (s.tuning || s.pending != null) return
        zap.state.value.tuning?.let { if (it != s.channel.id) zap.failed(it) }
        zap.adopted(s.channel.id)
        if (adoptedId == s.channel.id) return
        adoptedId = s.channel.id
        repo.noteTuned(s.channel.id)
        if (rows.isNotEmpty() && rows.none { it.id == s.channel.id }) {
            useLens(LensRef.All)
            say(context.getString(CR.string.livetv_lens_switched, lensName(LensRef.All)))
        }
        showBanner()
    }

    fun say(text: String) {
        toast = text
        toastNonce++
    }

    // ---- Overlays ----

    fun showBanner() {
        if (!banner) browse = 0
        banner = true
        bannerNonce++
    }

    fun hideBanner() {
        banner = false
        closeDetail()
        browse = 0
    }

    private fun closeDetail() {
        detail = false
        detailId = null
    }

    private fun browseStep(d: Int) {
        if (!banner) return showBanner()
        val id = bannerId() ?: return
        browse = (browse + d).coerceIn(0, (programsOf(id).size - 1).coerceAtLeast(0))
        bannerNonce++
    }

    /** The detail panel of [id] (a mini-guide row), else of the banner's channel; [at] = the programme browsed. */
    private fun openDetail(id: String? = null, at: Int = 0) {
        if (id != null) {
            closeGuide()
            hideBanner()
            detailId = id.takeIf { it != pb.liveState?.channel?.id }
        }
        showBanner()
        browse = at
        detail = true
        detailIndex = 0
    }

    private fun detailActions(): List<DetailAction> {
        val p = bannerProgram()
        return buildList {
            if (detailId != null) add(DetailAction.WATCH)
            if (p != null && repo.caps.value.canRecord) add(DetailAction.RECORD)
            if (p != null && p.start > repo.now()) add(DetailAction.REMIND)
        }
    }

    fun detailLabels(): List<Int> = detailActions().map {
        when (it) {
            DetailAction.WATCH -> R.string.player_live_watch
            DetailAction.RECORD -> R.string.player_live_record
            DetailAction.REMIND -> R.string.player_live_remind
        }
    }

    fun openGuide() {
        val cur = pb.liveState?.channel?.id
        guideLens = lens ?: LensRef.All
        guideRows = rows.ifEmpty { lensRows(guideLens) }
        guideFocus = guideRows.indexOfFirst { it.id == cur }.coerceAtLeast(0)
        closeTag = -1
        hideBanner()
        menu = false
        guide = true
        guideNonce++
    }

    fun closeGuide() {
        guide = false
        closeTag = -1
    }

    private fun guideMove(d: Int) {
        if (guideRows.isNotEmpty()) guideFocus = (guideFocus + d).coerceIn(0, guideRows.lastIndex)
        guideNonce++
    }

    private fun guideLensStep(d: Int) {
        val keep = guideRows.getOrNull(guideFocus)?.id
        guideLens = stepLens(repo.lenses.value, guideLens, d)
        guideRows = lensRows(guideLens)
        val cur = pb.liveState?.channel?.id
        guideFocus = guideRows.indexOfFirst { it.id == keep }.takeIf { it >= 0 } ?: guideRows.indexOfFirst { it.id == cur }.coerceAtLeast(0)
        guideNonce++
    }

    private fun guideJump(c: Char, at: Long) {
        jumpBuf = if (at - jumpAt > JUMP_TIMEOUT_MS) "$c" else (jumpBuf + c).take(DIGIT_MAX_CHARS)
        jumpAt = at
        val i = guideRows.indexOfFirst { it.number == jumpBuf }.takeIf { it >= 0 } ?: guideRows.indexOfFirst { it.number.startsWith(jumpBuf) }
        if (i >= 0) guideFocus = i
        guideNonce++
    }

    private fun guideTune() {
        val r = guideRows.getOrNull(guideFocus) ?: return
        // A lens picked in the mini-guide becomes the zap list (§8.3).
        if (guideLens != lens) useLens(guideLens)
        zap.tune(r.id)
        closeTag = guideNonce
    }

    private fun menuItems(): List<MenuItem> = buildList {
        val canRecord = repo.caps.value.canRecord
        if (menuFor != null) {
            add(MenuItem.WATCH)
            add(MenuItem.FAVORITE)
            if (canRecord) add(MenuItem.RECORD)
            add(MenuItem.DETAILS)
            return@buildList
        }
        add(MenuItem.TRACKS)
        add(MenuItem.FAVORITE)
        if (canRecord) add(MenuItem.RECORD)
        if (zap.state.value.last != null) add(MenuItem.LAST)
        if (pb.canSwitchQuality) add(MenuItem.QUALITY)
        add(MenuItem.ASPECT)
    }

    /** The channel the menu acts on: the mini-guide's row, else the adopted channel. */
    private fun menuChannel(): String? = menuFor ?: pb.liveState?.channel?.id

    @Composable
    fun menuLabels(aspect: Aspect): List<String> {
        val fav = menuChannel()?.let { byId[it]?.favorite } == true
        return menuItems().map {
            when (it) {
                MenuItem.TRACKS -> stringResource(R.string.tracks_hint_touch)
                MenuItem.FAVORITE -> stringResource(if (fav) CR.string.livetv_channel_favorite_remove else CR.string.livetv_channel_favorite_add)
                MenuItem.RECORD -> stringResource(R.string.player_live_record)
                MenuItem.LAST -> stringResource(R.string.player_live_last_channel)
                MenuItem.QUALITY -> stringResource(CR.string.quality) + " · " + qualityLabel(LocalContext.current, pb.qualityCap)
                MenuItem.ASPECT -> stringResource(aspect.label)
                MenuItem.WATCH -> stringResource(R.string.player_live_watch)
                MenuItem.DETAILS -> stringResource(R.string.player_live_details)
            }
        }
    }

    /** [forId] = the channel menu of a mini-guide row (the list stays open under it); null = the live menu. */
    private fun openMenu(forId: String? = null) {
        if (forId == null) guide = false
        menuFor = forId
        menu = true
        menuIndex = 0
    }

    private fun closeMenu() {
        menu = false
        menuFor = null
    }

    // ---- Actions ----

    private fun record(p: ProgramLite?) {
        if (p == null) return say(context.getString(CR.string.livetv_guide_no_info))
        if (!repo.caps.value.canRecord) return say(context.getString(R.string.player_live_record_forbidden))
        scope.launch {
            val api = repo.api
            val msg = try {
                val defaults = api.json(Dialect.timerDefaults(api.kind, p.id)) as? JsonObject ?: JsonObject(emptyMap())
                api.json(Dialect.createTimer(api.kind, quickRecordBody(defaults, repo.prefs.prefs.value.dvrPadding)))
                repo.requestTimers()
                R.string.player_live_recording_scheduled
            } catch (e: LiveApiException) {
                val err = mapDvrError(api.kind, DvrOp.CREATE_TIMER, e.status, e.message.orEmpty())
                repo.noteDvrError(err)
                when (err) {
                    DvrError.ALREADY_SCHEDULED -> R.string.player_live_already_scheduled
                    DvrError.FORBIDDEN -> R.string.player_live_record_forbidden
                    DvrError.PREMIERE -> R.string.player_live_record_premiere
                    else -> R.string.player_live_record_failed
                }
            }
            say(context.getString(msg))
        }
    }

    private fun favorite(id: String?) {
        val r = id?.let { byId[it] } ?: return
        scope.launch {
            val on = !r.favorite
            say(
                if (!repo.setFavorite(r.id, on)) context.getString(CR.string.livetv_toasts_favorites_unavailable)
                else context.getString(if (on) R.string.player_live_favorite_added else R.string.player_live_favorite_removed, r.name),
            )
        }
    }

    private fun remind(p: ProgramLite) {
        val api = repo.api
        val lead = TvSettings.liveReminderLeadMin.value
        val r = Reminder(
            api.serverId, api.userId, p.id, p.channelId, p.start, p.title, byId[p.channelId]?.name.orEmpty(),
            lead, TvSettings.liveReminderAutoTune.value, fireAt(p.start, lead, api.clockSkewMs.value),
        )
        scope.launch {
            Reminders.add(context.applicationContext, r)
            say(context.getString(R.string.player_live_reminder_set))
        }
    }

    /** PROG_RED / MEDIA_RECORD held: the options sheet (§9.2) instead of the quick record. */
    private fun recordOptions(p: ProgramLite?) {
        if (p == null) return say(context.getString(CR.string.livetv_guide_no_info))
        if (!repo.caps.value.canRecord) return say(context.getString(R.string.player_live_record_forbidden))
        val target = RecordTarget.New(p.id, p.flags and PF.SERIES != 0)
        host.show(root) { RecordOptionsSheet(dvrOf(repo), target, onDismiss = host::close) }
    }

    /** PROG_BLUE / SEARCH: the guide's search over the video; a channel tunes, a later programme opens its detail. */
    private fun openSearch() {
        closeGuide()
        closeMenu()
        hideBanner()
        host.show(root) {
            GuideSearch(repo, GuideClock(TimeZone.getDefault()), repo.now() + 7 * 24 * HOUR, onPick = { host.close(); searchPick(it) }, onDismiss = host::close)
        }
    }

    private fun searchPick(j: PendingJump) {
        val at = j.programId?.let { id -> programsOf(j.channelId).indexOfFirst { it?.id == id } } ?: -1
        // Index 0 is the airing programme: tune it like a channel hit.
        if (at > 0) openDetail(j.channelId, at) else zap.tune(j.channelId)
    }

    /**
     * GUIDE, and Back with live.backAction = guide: the Live TV screen's Guide tab, focused on this channel.
     * shortcut: the player closes under the guide; picture-in-guide (TV-5) will open it over the video instead.
     */
    private fun openGuideTab(viaBack: Boolean) {
        val id = pb.liveState?.channel?.id
        if (id != null) LiveTv.guideFor.value = LiveTv.GuideAsk(id, viaBack)
        onExit()
    }

    // ---- F2: watch from the start ----

    /** The adopted channel's airing programme, when the server is recording it. */
    private fun airingRecording(id: String, marks: Map<String, TimerLite>): TimerLite? {
        val p = programsOf(id).firstOrNull() ?: return null
        return marks[p.id]?.takeIf { it.status == TimerStatus.RECORDING }
    }

    /** Once per adopted channel: a recording that started more than 60 s ago offers the start (live after 8 s). */
    suspend fun checkStart(id: String) {
        if (askedFor == id) return
        askedFor = id
        val mode = startMode
        startMode = null // the deep link answers for the first channel only
        ask = null
        if (mode == "live") return
        // The timers overlay and the programme slab may land after the adoption.
        val t = withTimeoutOrNull(5_000) { combine(repo.overlay, repo.guideVersion) { m, _ -> airingRecording(id, m) }.first { it != null } } ?: return
        val since = t.start - t.prePaddingS * 1000
        if (repo.now() - since <= 60_000 || pb.liveState?.channel?.id != id) return
        if (mode == "beginning") watchFromStart(t) else {
            askIndex = 1
            ask = StartAsk(t, since)
        }
    }

    /** Plays the in-progress recording from 0: by ProgramId, else the same channel. */
    private fun watchFromStart(t: TimerLite) {
        ask = null
        scope.launch {
            val api = repo.api
            val items = try {
                ((api.json(Dialect.recordings(api.kind, api.userId, limit = 24, inProgress = true)) as? JsonObject)?.get("Items") as? JsonArray)
                    .orEmpty().mapNotNull { it as? JsonObject }
            } catch (_: LiveApiException) {
                emptyList()
            }
            val rec = items.firstOrNull { it.text("ProgramId") == t.programId } ?: items.firstOrNull { it.text("ChannelId") == t.channelId }
            val id = rec?.text("Id") ?: return@launch say(context.getString(R.string.player_live_start_unavailable))
            context.startActivity(Intent(context, PlayerActivity::class.java).putExtra(PlayerActivity.EXTRA_ID, id).putExtra(PlayerActivity.EXTRA_FROM_START, true))
            onExit()
        }
    }

    private fun askKey(code: Int, ev: K): Boolean {
        val a = ask ?: return false
        when {
            code == K.KEYCODE_DPAD_LEFT -> askIndex = 0
            code == K.KEYCODE_DPAD_RIGHT -> askIndex = 1
            isOk(code) -> if (ev.repeatCount == 0) {
                if (askIndex == 0) watchFromStart(a.timer) else ask = null
            }
            else -> {
                ask = null // any other key answers "live" and goes on
                return false
            }
        }
        return true
    }

    private fun nextLens() {
        useLens(stepLens(repo.lenses.value, lens ?: LensRef.All, 1))
        say(context.getString(CR.string.livetv_lens_switched, lensName(lens)))
        showBanner()
    }

    /** Back (the player's BackHandler: Android 13+ sends Back to the dispatcher, not to key listeners). */
    fun back() {
        when {
            ask != null -> ask = null
            zap.digitsOpen -> zap.escape()
            menu -> closeMenu()
            detail -> closeDetail()
            guide -> closeGuide()
            banner -> hideBanner()
            else -> when (TvSettings.liveBackAction.value) {
                TvSettings.LIVE_BACK_LAST -> if (zap.state.value.last != null) zap.lastChannel() else onExit()
                // §8.7: the Guide tab on this channel; a second Back there within 2 s exits (LiveTvScreen).
                TvSettings.LIVE_BACK_GUIDE -> openGuideTab(viaBack = true)
                else -> onExit()
            }
        }
    }

    private fun okShort() {
        val s = pb.liveState
        when {
            menu -> {
                val id = menuChannel()
                val item = menuItems().getOrNull(menuIndex)
                closeMenu()
                when (item) {
                    MenuItem.TRACKS -> onTracks()
                    MenuItem.FAVORITE -> favorite(id)
                    MenuItem.RECORD -> record(id?.let { programsOf(it).firstOrNull() })
                    MenuItem.LAST -> zap.lastChannel()
                    MenuItem.QUALITY -> onQuality()
                    MenuItem.ASPECT -> onAspect()
                    MenuItem.WATCH -> id?.let { closeGuide(); zap.tune(it) }
                    MenuItem.DETAILS -> id?.let { openDetail(it) }
                    null -> {}
                }
            }
            detail -> {
                val p = bannerProgram()
                val id = detailId
                when (detailActions().getOrNull(detailIndex)) {
                    DetailAction.WATCH -> id?.let(zap::tune)
                    DetailAction.RECORD -> record(p)
                    DetailAction.REMIND -> p?.let(::remind)
                    null -> {}
                }
                closeDetail()
            }
            guide -> guideTune()
            s?.pausedReleased == true -> player.play() // "Reprendre le direct": LiveTuner re-tunes on play
            pb.error != null && s != null -> pb.tune(s.channel)
            banner && browse > 0 -> openDetail()
            else -> openGuide()
        }
    }

    private fun longOk() {
        when {
            guide -> favorite(guideRows.getOrNull(guideFocus)?.id)
            menu || detail -> okShort()
            else -> openMenu()
        }
    }

    // ---- Keys (§10.2) ----

    /** Every live key returns true so the TV's own tuner app never gets CHANNEL_*, GUIDE or digits. */
    fun onKey(e: KeyEvent): Boolean {
        val ev = e.nativeKeyEvent
        val code = ev.keyCode
        if (ev.action == K.ACTION_UP) {
            if (!owned.remove(code)) return false
            when {
                isOk(code) -> {
                    if (okDown && !okLong) okShort()
                    okDown = false
                    okLong = false
                }
                isRecord(code) -> {
                    if (redDown && !redLong) record(redTarget)
                    redDown = false
                }
                // A CH key is up: the merge tune may start, or the held preview tunes (§8.3).
                else -> zap.keyUp()
            }
            return true
        }
        if (ev.action != K.ACTION_DOWN) return false
        keyAt = ev.eventTime
        if (banner) bannerNonce++ // any key keeps the banner up
        val handled = when {
            ask != null && askKey(code, ev) -> true
            // Red / Record: quick record on key-up, the options sheet when held (§10.2).
            isRecord(code) && !menu -> {
                if (ev.repeatCount == 0) {
                    redDown = true
                    redLong = false
                    redTarget = if (guide) guideRows.getOrNull(guideFocus)?.let { programsOf(it.id).firstOrNull() } else bannerProgram()
                } else if (!redLong) {
                    redLong = true
                    recordOptions(redTarget)
                }
                true
            }
            isOk(code) && !(zap.digitsOpen && !guide && !menu && !detail) -> {
                if (ev.repeatCount == 0) {
                    okDown = true
                    okLong = false
                } else if (okDown && !okLong) {
                    okLong = true
                    longOk()
                }
                true
            }
            menu -> menuKey(code)
            detail -> detailKey(code)
            zap.digitsOpen && !guide && digitKey(code) -> true
            guide -> guideKey(code, ev)
            else -> playerKey(code, ev)
        }
        // The VOD branch must not seek or pause the live stream with these.
        val mine = handled || code in SWALLOWED
        if (mine) owned.add(code)
        return mine
    }

    private fun menuKey(code: Int): Boolean {
        if (guide) guideNonce++ // the channel menu keeps the mini-guide from idling out
        return when (code) {
            K.KEYCODE_DPAD_UP -> { menuIndex = (menuIndex - 1).coerceAtLeast(0); true }
            K.KEYCODE_DPAD_DOWN -> { menuIndex = (menuIndex + 1).coerceAtMost(menuItems().lastIndex); true }
            K.KEYCODE_MENU -> { closeMenu(); true }
            else -> false
        }
    }

    private fun detailKey(code: Int): Boolean = when (code) {
        K.KEYCODE_DPAD_LEFT -> { detailIndex = (detailIndex - 1).coerceAtLeast(0); true }
        K.KEYCODE_DPAD_RIGHT -> { detailIndex = (detailIndex + 1).coerceAtMost((detailActions().size - 1).coerceAtLeast(0)); true }
        K.KEYCODE_INFO -> { closeDetail(); true }
        K.KEYCODE_GUIDE -> { openGuideTab(viaBack = false); true }
        K.KEYCODE_PROG_BLUE, K.KEYCODE_SEARCH -> { openSearch(); true }
        else -> false
    }

    private fun digitKey(code: Int): Boolean {
        digitOf(code)?.let { zap.digit(it); return true }
        when {
            isSeparator(code) -> zap.separator()
            isOk(code) -> zap.enter()
            code == K.KEYCODE_DPAD_UP -> zap.pick(-1)
            code == K.KEYCODE_DPAD_DOWN -> zap.pick(1)
            code == K.KEYCODE_DEL -> zap.backspace()
            else -> return false
        }
        return true
    }

    private fun guideKey(code: Int, ev: K): Boolean {
        digitOf(code)?.let { guideJump(it, ev.eventTime); return true }
        when (code) {
            K.KEYCODE_DPAD_UP -> guideMove(-1)
            K.KEYCODE_DPAD_DOWN -> guideMove(1)
            K.KEYCODE_CHANNEL_UP, K.KEYCODE_PAGE_DOWN -> guideMove(GUIDE_PAGE)
            K.KEYCODE_CHANNEL_DOWN, K.KEYCODE_PAGE_UP -> guideMove(-GUIDE_PAGE)
            K.KEYCODE_DPAD_LEFT -> guideLensStep(-1)
            K.KEYCODE_DPAD_RIGHT, K.KEYCODE_PROG_YELLOW -> guideLensStep(1)
            K.KEYCODE_PROG_GREEN -> favorite(guideRows.getOrNull(guideFocus)?.id)
            K.KEYCODE_INFO -> guideRows.getOrNull(guideFocus)?.let { openDetail(it.id) }
            K.KEYCODE_MENU -> guideRows.getOrNull(guideFocus)?.let { openMenu(it.id) }
            K.KEYCODE_GUIDE -> openGuideTab(viaBack = false)
            K.KEYCODE_PROG_BLUE, K.KEYCODE_SEARCH -> openSearch()
            K.KEYCODE_LAST_CHANNEL -> {}
            else -> return false
        }
        return true
    }

    private fun playerKey(code: Int, ev: K): Boolean {
        val held = ev.repeatCount > 0
        digitOf(code)?.let { zap.digit(it); return true }
        when (code) {
            // keyDown: the merge tune waits for the key-up (the owned set guarantees one), so a held key only previews.
            K.KEYCODE_CHANNEL_UP, K.KEYCODE_MEDIA_NEXT -> { zap.press(1, held, keyDown = true); showBanner() }
            K.KEYCODE_CHANNEL_DOWN, K.KEYCODE_MEDIA_PREVIOUS -> { zap.press(-1, held, keyDown = true); showBanner() }
            K.KEYCODE_DPAD_UP, K.KEYCODE_DPAD_DOWN -> {
                if (TvSettings.liveUpDown.value == TvSettings.LIVE_UPDOWN_ZAP) zap.press(if (code == K.KEYCODE_DPAD_UP) 1 else -1, held, keyDown = true)
                showBanner()
            }
            K.KEYCODE_DPAD_LEFT -> browseStep(-1)
            K.KEYCODE_DPAD_RIGHT -> browseStep(1)
            K.KEYCODE_LAST_CHANNEL, K.KEYCODE_DEL -> zap.lastChannel()
            K.KEYCODE_INFO -> if (banner && !detail) openDetail() else showBanner()
            K.KEYCODE_MENU -> openMenu()
            K.KEYCODE_GUIDE -> openGuideTab(viaBack = false)
            K.KEYCODE_PROG_GREEN -> favorite(pb.liveState?.channel?.id)
            K.KEYCODE_PROG_YELLOW -> nextLens()
            K.KEYCODE_PROG_BLUE, K.KEYCODE_SEARCH -> openSearch()
            K.KEYCODE_MEDIA_FAST_FORWARD, K.KEYCODE_MEDIA_REWIND -> {} // P2: timeshift
            else -> {
                if (!isSeparator(code)) return false
                zap.separator()
            }
        }
        return true
    }

    private companion object {
        val SWALLOWED = setOf(
            K.KEYCODE_DPAD_UP, K.KEYCODE_DPAD_DOWN, K.KEYCODE_DPAD_LEFT, K.KEYCODE_DPAD_RIGHT, K.KEYCODE_MENU, K.KEYCODE_INFO,
            K.KEYCODE_CHANNEL_UP, K.KEYCODE_CHANNEL_DOWN, K.KEYCODE_GUIDE, K.KEYCODE_LAST_CHANNEL,
            K.KEYCODE_PROG_RED, K.KEYCODE_PROG_GREEN, K.KEYCODE_PROG_YELLOW, K.KEYCODE_PROG_BLUE,
            K.KEYCODE_MEDIA_NEXT, K.KEYCODE_MEDIA_PREVIOUS, K.KEYCODE_MEDIA_FAST_FORWARD, K.KEYCODE_MEDIA_REWIND,
        )

        fun isOk(code: Int) = code == K.KEYCODE_DPAD_CENTER || code == K.KEYCODE_ENTER || code == K.KEYCODE_NUMPAD_ENTER || code == K.KEYCODE_BUTTON_A

        fun isRecord(code: Int) = code == K.KEYCODE_PROG_RED || code == K.KEYCODE_MEDIA_RECORD

        fun isSeparator(code: Int) = code == K.KEYCODE_PERIOD || code == K.KEYCODE_MINUS || code == K.KEYCODE_TV_NUMBER_ENTRY ||
            code == K.KEYCODE_NUMPAD_DOT || code == K.KEYCODE_NUMPAD_SUBTRACT

        fun digitOf(code: Int): Char? = when (code) {
            in K.KEYCODE_0..K.KEYCODE_9 -> '0' + (code - K.KEYCODE_0)
            in K.KEYCODE_NUMPAD_0..K.KEYCODE_NUMPAD_9 -> '0' + (code - K.KEYCODE_NUMPAD_0)
            else -> null
        }
    }
}

/** The player's live controller; null outside live or without a server. */
@Composable
fun rememberLiveControl(pb: Playback, player: Player, root: FocusRequester, onTracks: () -> Unit, onAspect: () -> Unit, onExit: () -> Unit, onQuality: () -> Unit = {}): LiveControl? {
    // The playing channel's source: the signed-in server, or IPTV (core/iptv).
    val api = pb.api.takeIf { Wicaby.app.api != null } ?: return null
    val context = LocalContext.current
    val activity = LocalActivity.current
    val scope = rememberCoroutineScope()
    val tracks by rememberUpdatedState(onTracks)
    val aspect by rememberUpdatedState(onAspect)
    val exit by rememberUpdatedState(onExit)
    val quality by rememberUpdatedState(onQuality)
    return remember(pb) {
        val start = activity?.intent?.getStringExtra(PlayerActivity.EXTRA_LIVE_START)
        LiveControl(context, pb, player, LiveTv.repo(context, api), scope, { tracks() }, { aspect() }, { exit() }, root, start, { quality() })
    }
}

/** Overlay timeouts honour the accessibility "time to take action" setting (API 29+). */
private fun recommendedMs(context: Context, ms: Int): Long =
    if (Build.VERSION.SDK_INT >= 29) {
        context.getSystemService(AccessibilityManager::class.java)?.getRecommendedTimeoutMillis(ms, AccessibilityManager.FLAG_CONTENT_TEXT)?.toLong() ?: ms.toLong()
    } else {
        ms.toLong()
    }

private val panel get() = C.elevated.copy(alpha = 0.92f) // TV: opaque, no blur (§11)
private val digitStyle = Type.mono.copy(fontSize = 28.sp, lineHeight = 34.sp)

@Composable
fun LiveOverlay(ctl: LiveControl, buffering: Boolean, aspect: Aspect) {
    val s = ctl.pb.liveState ?: return
    val api = ctl.pb.api.takeIf { Wicaby.app.api != null } ?: return
    val repo = ctl.repo
    val context = LocalContext.current
    val view = LocalView.current
    // Read at collection time: a language switch must not leave the toasts in the old language.
    val res by rememberUpdatedState(LocalResources.current)
    val channels by repo.channels.collectAsState()
    val prefs by repo.prefs.prefs.collectAsState()
    val version by repo.guideVersion.collectAsState()
    val overlay by repo.overlay.collectAsState()
    val zs by ctl.zap.state.collectAsState()
    val digits by ctl.zap.digits.collectAsState()

    LaunchedEffect(repo) { repo.open() } // a cold start (reminder, deep link) loads the lineup; a no-op when warm
    LaunchedEffect(channels, prefs) { ctl.sync(channels, prefs) }
    LaunchedEffect(ctl) { snapshotFlow { ctl.pb.liveState }.collect(ctl::onState) }
    LaunchedEffect(ctl) { ctl.zap.banner.drop(1).collect { if (it != null) ctl.showBanner() } }
    LaunchedEffect(ctl) {
        ctl.zap.results.collect { r ->
            when (r) {
                is DigitResult.Fail -> ctl.say(res.getString(R.string.player_live_no_channel, r.number))
                is DigitResult.Commit -> {
                    if (r.hidden) ctl.say(res.getString(CR.string.livetv_channel_hidden_toast))
                    // §21.7: TalkBack hears the committed number at once (the banner's live region is throttled).
                    ctl.row(r.id)?.let { row ->
                        @Suppress("DEPRECATION")
                        view.announceForAccessibility(listOf(row.number, row.name).filter { it.isNotEmpty() }.joinToString(" "))
                    }
                }
                else -> {}
            }
        }
    }
    LaunchedEffect(s.noticeAt) { if (s.noticeAt > 0 && !s.pausedReleased) s.notice?.let(ctl::say) }
    // F2: once the tune is adopted, a recording in progress may offer the start.
    val settled = !s.tuning && s.pending == null
    LaunchedEffect(s.channel.id, settled) { if (settled) ctl.checkStart(s.channel.id) }
    LaunchedEffect(ctl.ask) {
        if (ctl.ask == null) return@LaunchedEffect
        delay(recommendedMs(context, 8_000))
        ctl.ask = null // live is the default
    }

    val now by produceState(repo.now(), repo) {
        while (true) {
            value = repo.now()
            delay(15_000)
        }
    }

    // Hide timers: the banner after live.bannerSeconds (any key resets it), the mini-guide after 10 s idle
    // or 1.5 s after OK tuned, toasts after 4 s, the coach mark once.
    val bannerMs = remember { recommendedMs(context, TvSettings.liveBannerSeconds.value.coerceIn(2, 10) * 1000) }
    LaunchedEffect(ctl.bannerNonce, ctl.banner, ctl.detail) {
        if (ctl.banner && !ctl.detail) {
            delay(bannerMs)
            ctl.hideBanner()
        }
    }
    LaunchedEffect(ctl.guide, ctl.guideNonce, ctl.closeTag) {
        if (!ctl.guide) return@LaunchedEffect
        delay(if (ctl.closeTag == ctl.guideNonce) 1_500 else recommendedMs(context, 10_000))
        ctl.closeGuide()
    }
    LaunchedEffect(ctl.toastNonce) {
        if (ctl.toast == null) return@LaunchedEffect
        delay(recommendedMs(context, 4_000))
        ctl.toast = null
    }
    LaunchedEffect(Unit) {
        val sp = context.getSharedPreferences("live_player", Context.MODE_PRIVATE)
        if (sp.getBoolean("coach_colour_keys", false)) return@LaunchedEffect
        sp.edit { putBoolean("coach_colour_keys", true) }
        ctl.coach = true
        delay(recommendedMs(context, 8_000))
        ctl.coach = false
    }

    // A programme boundary on the adopted channel shows the banner (live.bannerOnProgramChange).
    val airing = remember(s.channel.id, now, version) { ctl.programsOf(s.channel.id, now).firstOrNull()?.id }
    var lastAiring by remember(s.channel.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(airing) {
        if (airing != null && lastAiring != null && airing != lastAiring && !s.tuning && TvSettings.liveBannerOnProgramChange.value) ctl.showBanner()
        if (airing != null) lastAiring = airing
    }

    // The planner fetches now/next around what is shown: the banner target, or the mini-guide's focus.
    val target = ctl.detailId ?: zs.pending ?: s.pending?.id ?: s.channel.id
    LaunchedEffect(target, ctl.guide, ctl.guideFocus, ctl.guideRows, ctl.rows) {
        delay(150)
        val list = if (ctl.guide) ctl.guideRows else ctl.rows
        val i = if (ctl.guide) ctl.guideFocus else list.indexOfFirst { it.id == target }
        val ids = if (i < 0) listOf(target) else list.subList((i - 5).coerceAtLeast(0), (i + 6).coerceAtMost(list.size)).map { it.id }
        val t = repo.now()
        repo.setViewport(Viewport(ids, 0, ids.lastIndex, t, t + 3 * HOUR, repo.tuning))
    }

    val shown = ctl.row(target, s.pending?.takeIf { it.id == target } ?: s.channel.takeIf { it.id == target })
    val adopted = ctl.row(s.channel.id, s.channel)

    CompositionLocalProvider(LocalOverlay provides ctl.host) {
        Box(Modifier.fillMaxSize()) {
            if (s.radio && adopted != null) RadioScreen(api, ctl, adopted, now)
            if (s.tuning && buffering && shown != null) TuneCard(api, ctl, shown, now)
            if (s.pausedReleased) PauseReleasedCard()

            AnimatedVisibility(
                ctl.banner && shown != null,
                enter = fadeIn(tween(220)) + slideInVertically(tween(220)) { 12 },
                exit = fadeOut(tween(120)),
                modifier = Modifier.align(Alignment.BottomCenter),
            ) {
                if (shown != null) Banner(api, ctl, shown, now, tuning = s.tuning || zs.pending != null, overlay.keys)
            }

            AnimatedVisibility(
                ctl.guide,
                enter = fadeIn(tween(220)) + slideInHorizontally(tween(220)) { -24 },
                exit = fadeOut(tween(120)),
                modifier = Modifier.align(Alignment.CenterStart),
            ) {
                MiniGuide(api, ctl, s.channel.id, now, version, overlay.keys)
            }

            digits?.let { d -> DigitBuffer(api, ctl, d.buf, d.preview, Modifier.align(Alignment.TopEnd)) }

            if (ctl.menu) LiveMenu(ctl.menuLabels(aspect), ctl.menuIndex, Modifier.align(Alignment.CenterEnd))

            ctl.ask?.let { StartPrompt(it, ctl.askIndex, now, Modifier.align(Alignment.Center)) }

            Column(Modifier.align(Alignment.TopCenter).padding(top = 27.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                if (ctl.coach) Chip(stringResource(R.string.player_live_coach_colour_keys))
                ctl.toast?.let { Chip(it, Modifier.padding(top = 8.dp)) }
            }

            OverlayLayer(ctl.host)
        }
    }
}

/** F2: "Regarder depuis le début (il y a …)" / "Regarder en direct"; ←/→ and OK, any other key or 8 s = live. */
@Composable
private fun StartPrompt(a: StartAsk, index: Int, now: Long, modifier: Modifier) {
    val minutes = ((now - a.since) / 60_000).toInt().coerceAtLeast(1)
    Column(
        modifier.clip(RoundedCornerShape(Radius.xl)).background(panel).padding(28.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(a.timer.name, style = Type.title3, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(Modifier.padding(top = 18.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Choice(stringResource(R.string.player_live_watch_from_start, minutesText(minutes)), index == 0)
            Choice(stringResource(R.string.player_live_watch_live), index == 1)
        }
    }
}

@Composable
private fun Chip(text: String, modifier: Modifier = Modifier) {
    Text(
        text, style = Type.callout, color = C.label,
        modifier = modifier.clip(RoundedCornerShape(50)).background(panel).padding(horizontal = 20.dp, vertical = 10.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
    )
}

@Composable
private fun RecDot() {
    val label = stringResource(R.string.player_live_recording)
    Box(Modifier.size(8.dp).clip(CircleShape).background(C.red).semantics { contentDescription = label })
}

/** The info banner (§8.5): bottom, 48/27 dp safe area; a second INFO adds the detail panel. */
@Composable
private fun Banner(api: Api, ctl: LiveControl, row: ChannelRow, now: Long, tuning: Boolean, marked: Set<String>) {
    val list = ctl.programsOf(row.id, now)
    val cur = list.getOrNull(ctl.browse)
    val after = list.getOrNull(ctl.browse + 1)
    val index = ctl.rows.indexOfFirst { it.id == row.id }
    LaunchedEffect(ctl.bannerNonce) {
        withFrameNanos { }
        if (BuildConfig.DEBUG && ctl.keyAt > 0) Log.d(LIVE_TAG, "key→banner ${SystemClock.uptimeMillis() - ctl.keyAt} ms")
        ctl.keyAt = 0
    }
    // §8.5/§21.7: the polite live region speaks at most once a second while zapping (the latest channel wins).
    val latest = listOfNotNull(row.number.takeIf { it.isNotEmpty() }, row.name, cur?.title).joinToString(", ")
    var spoken by remember { mutableStateOf(latest) }
    var spokenAt by remember { mutableLongStateOf(0L) }
    LaunchedEffect(latest) {
        delay(spokenAt + 1_000 - SystemClock.uptimeMillis()) // restarts keep the same deadline
        spoken = latest
        spokenAt = SystemClock.uptimeMillis()
    }
    Column(
        Modifier.fillMaxWidth().padding(start = 48.dp, end = 48.dp, bottom = 27.dp)
            .clip(RoundedCornerShape(Radius.xl)).background(panel).padding(horizontal = 24.dp, vertical = 18.dp)
            .semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = spoken
            },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ChannelLogo(api, row, 36.dp, fallback = false)
            Spacer(Modifier.width(14.dp))
            if (row.number.isNotEmpty()) Text(row.number, style = Type.mono.copy(fontSize = 19.sp), color = C.label2, modifier = Modifier.padding(end = 10.dp))
            Text(row.name, style = Type.title3, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (index >= 0) {
                Text(stringResource(R.string.player_live_lens_position, ctl.lensName(ctl.lens), index + 1, ctl.rows.size), style = Type.caption, color = C.label2)
                Spacer(Modifier.width(16.dp))
            }
            Text(if (tuning) stringResource(R.string.player_live_tuning) else timeText(now), style = Type.mono, color = C.label2)
        }
        Spacer(Modifier.height(12.dp))
        ProgramLine(if (ctl.browse == 0) stringResource(R.string.player_live_now) else cur?.let { timeText(it.start) }.orEmpty(), cur, now, cur?.id in marked, live = ctl.browse == 0)
        if (cur == null) Text(stringResource(CR.string.livetv_guide_no_info), style = Type.callout, color = C.label3, modifier = Modifier.padding(vertical = 3.dp))
        if (after != null && !ctl.detail) ProgramLine(if (ctl.browse == 0) stringResource(R.string.player_live_next) else timeText(after.start), after, now, after.id in marked, live = false)
        if (ctl.detail && cur != null) DetailPanel(ctl, cur, list.drop(ctl.browse + 1).filterNotNull().take(3))
    }
}

@Composable
private fun ProgramLine(label: String, p: ProgramLite?, now: Long, recording: Boolean, live: Boolean) {
    if (p == null) return
    Row(Modifier.padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = Type.caption, color = C.label3, maxLines = 1, modifier = Modifier.width(96.dp))
        Text(p.title, style = if (live) Type.headline else Type.callout, color = if (live) C.label else C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(16.dp))
        Text("${timeText(p.start)} – ${timeText(p.end)}", style = Type.mono, color = C.label2)
        if (live) {
            Spacer(Modifier.width(16.dp))
            LiveProgress(progressOf(p, now), Modifier.width(160.dp))
        }
        Box(Modifier.width(24.dp), contentAlignment = Alignment.CenterEnd) { if (recording) RecDot() }
    }
}

/** Second INFO (§8.5): overview, the next 3 programmes and the actions (←/→, OK). */
@Composable
private fun DetailPanel(ctl: LiveControl, p: ProgramLite, after: List<ProgramLite>) {
    val overview by produceState<String?>(null, p.id) { value = runCatching { ctl.pb.api.item(p.id).overview }.getOrNull() }
    Column(Modifier.padding(top = 14.dp)) {
        overview?.let { Text(it, style = Type.body, color = C.label2, maxLines = 3, overflow = TextOverflow.Ellipsis) }
        after.forEach { n ->
            Row(Modifier.padding(top = 4.dp)) {
                Text(timeText(n.start), style = Type.mono, color = C.label3, modifier = Modifier.width(96.dp))
                Text(n.title, style = Type.callout, color = C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        val actions = ctl.detailLabels()
        if (actions.isNotEmpty()) Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            actions.forEachIndexed { i, label -> Choice(stringResource(label), i == ctl.detailIndex) }
        }
    }
}

/** A choice drawn as focused (white pill, black text) or at rest; the key catcher keeps the real focus. */
@Composable
private fun Choice(text: String, selected: Boolean, modifier: Modifier = Modifier) {
    Text(
        text, style = Type.headline, color = if (selected) TvFocus.fg else C.label2, maxLines = 1,
        modifier = modifier.clip(RoundedCornerShape(50)).background(if (selected) TvFocus.bg else C.fill3).padding(horizontal = 20.dp, vertical = 9.dp),
    )
}

/** Number entry (§8.4): top right, `1 0 _`, then the preview (exact, prefix, alias, duplicates or none). */
@Composable
private fun DigitBuffer(api: Api, ctl: LiveControl, buf: String, preview: DigitPreview?, modifier: Modifier) {
    Column(
        modifier.padding(top = 27.dp, end = 48.dp).width(300.dp).clip(RoundedCornerShape(Radius.lg)).background(panel).padding(20.dp),
        horizontalAlignment = Alignment.End,
    ) {
        val shown = buf.toList().joinToString(" ") + if (buf.length < DIGIT_MAX_CHARS) " _" else ""
        Text(shown, style = digitStyle, color = C.label, modifier = Modifier.semantics { contentDescription = buf })
        val id = when (preview) {
            is DigitPreview.Exact -> preview.ids.getOrNull(preview.pick)
            is DigitPreview.Prefix -> preview.id
            is DigitPreview.Alias -> preview.id
            else -> null
        }
        if (preview is DigitPreview.Exact && preview.ids.size > 1) {
            Text(pluralStringResource(R.plurals.player_live_duplicates, preview.ids.size, preview.ids.size), style = Type.caption, color = C.label2, modifier = Modifier.padding(top = 6.dp))
        }
        val r = id?.let { ctl.row(it) }
        if (r != null) {
            Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                ChannelLogo(api, r, 24.dp, fallback = false)
                Spacer(Modifier.width(10.dp))
                Text(r.name, style = Type.headline, color = if (preview is DigitPreview.Prefix) C.label2 else C.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        } else if (preview != null) {
            Text(stringResource(R.string.player_live_no_match), style = Type.callout, color = C.label3, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

/** The mini-guide (§8.6): list at 34 % (min 360 dp), the focused channel's next programmes at 26 %; the video stays full size. */
@Composable
private fun MiniGuide(api: Api, ctl: LiveControl, currentId: String, now: Long, version: Long, marked: Set<String>) {
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = (ctl.guideFocus - 3).coerceAtLeast(0))
    LaunchedEffect(ctl.guideFocus, ctl.guideRows) {
        val visible = listState.layoutInfo.visibleItemsInfo
        val first = visible.firstOrNull()?.index ?: 0
        val last = visible.lastOrNull()?.index ?: 0
        if (ctl.guideFocus <= first || ctl.guideFocus >= last) listState.scrollToItem((ctl.guideFocus - 3).coerceAtLeast(0))
    }
    BoxWithConstraints(Modifier.fillMaxHeight()) {
        val listW = (maxWidth * 0.34f).coerceAtLeast(360.dp)
        val paneW = maxWidth * 0.26f
        Row(Modifier.fillMaxHeight().padding(vertical = 27.dp).padding(start = 48.dp).clip(RoundedCornerShape(Radius.xl)).background(panel)) {
            Column(Modifier.width(listW).fillMaxHeight().padding(vertical = 16.dp)) {
                Row(Modifier.padding(horizontal = 20.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("‹ ${ctl.lensName(ctl.guideLens)} ›", style = Type.headline, color = C.label, maxLines = 1, modifier = Modifier.weight(1f))
                    Text(timeText(now), style = Type.mono, color = C.label2)
                }
                val listLabel = stringResource(R.string.player_live_channel_list) + " · " + ctl.lensName(ctl.guideLens)
                LazyColumn(state = listState, modifier = Modifier.semantics { contentDescription = listLabel }) {
                    itemsIndexed(ctl.guideRows, key = { _, r -> r.id }) { i, r ->
                        GuideRow(api, ctl, r, focused = i == ctl.guideFocus, current = r.id == currentId, now = now, version = version, marked = marked)
                    }
                }
            }
            ctl.guideRows.getOrNull(ctl.guideFocus)?.let { r ->
                Column(Modifier.width(paneW).fillMaxHeight().background(C.fill1).padding(20.dp)) {
                    Text(listOfNotNull(r.name, r.number.takeIf { it.isNotEmpty() }).joinToString(" · "), style = Type.headline, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val list = remember(r.id, now, version) { ctl.programsOf(r.id, now).filterNotNull().take(3) }
                    if (list.isEmpty()) Text(stringResource(CR.string.livetv_guide_no_info), style = Type.callout, color = C.label3, modifier = Modifier.padding(top = 10.dp))
                    list.forEach { p ->
                        Row(Modifier.padding(top = 10.dp)) {
                            Text(timeText(p.start), style = Type.mono, color = C.label3, modifier = Modifier.width(64.dp))
                            Text(p.title, style = Type.callout, color = C.label2, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }
}

/** A 64 dp row: number, logo, name and the airing title, progress, end time, recording dot, star. Focus is inverted (§11). */
@Composable
private fun GuideRow(api: Api, ctl: LiveControl, r: ChannelRow, focused: Boolean, current: Boolean, now: Long, version: Long, marked: Set<String>) {
    val p = remember(r.id, now, version) { ctl.programsOf(r.id, now).firstOrNull() }
    val fg = if (focused) TvFocus.fg else C.label
    val sub = if (focused) TvFocus.fg.copy(alpha = 0.7f) else C.label2
    Row(
        Modifier.fillMaxWidth().height(64.dp).padding(horizontal = 8.dp).clip(RoundedCornerShape(Radius.sm))
            .background(if (focused) C.label else Color.Transparent),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(3.dp).height(36.dp).background(if (current) (if (focused) TvFocus.fg else C.label) else Color.Transparent))
        Text(r.number, style = Type.mono, color = sub, maxLines = 1, modifier = Modifier.width(52.dp).padding(start = 8.dp))
        // Logos are drawn for a dark surface: the inverted row keeps a dark plate under it.
        ChannelLogo(api, r, 28.dp, if (focused) Modifier.clip(RoundedCornerShape(Radius.xs)).background(C.bg) else Modifier, fallback = false)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(r.name, style = Type.headline, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (p != null) Text(p.title, style = Type.footnote, color = sub, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (p != null) LiveProgress(progressOf(p, now), Modifier.padding(top = 3.dp, end = 8.dp))
        }
        if (p != null) Text(timeText(p.end), style = Type.mono, color = sub, modifier = Modifier.padding(horizontal = 6.dp))
        Box(Modifier.width(14.dp), contentAlignment = Alignment.Center) { if (p?.id in marked) RecDot() }
        Box(Modifier.width(20.dp), contentAlignment = Alignment.Center) { if (r.favorite) Text("★", style = Type.caption, color = sub) }
    }
}

/** The live menu (long OK, MENU): tracks, favourite, record, previous channel, picture format. */
@Composable
private fun LiveMenu(labels: List<String>, index: Int, modifier: Modifier) {
    Column(
        modifier.padding(end = 48.dp).width(320.dp).clip(RoundedCornerShape(Radius.xl)).background(panel).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        labels.forEachIndexed { i, label ->
            val sel = i == index
            Text(
                label, style = Type.headline, color = if (sel) TvFocus.fg else C.label, maxLines = 1,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.sm)).background(if (sel) TvFocus.bg else Color.Transparent)
                    .padding(horizontal = 16.dp, vertical = 11.dp),
            )
        }
    }
}

/** While a new channel loads after the old picture stopped: its logo on black with the airing title (§8.1). */
@Composable
private fun TuneCard(api: Api, ctl: LiveControl, row: ChannelRow, now: Long) {
    Box(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            ChannelLogo(api, row, 72.dp)
            Text(row.name, style = Type.title2, color = C.label, modifier = Modifier.padding(top = 16.dp))
            ctl.programsOf(row.id, now).firstOrNull()?.let { Text(it.title, style = Type.callout, color = C.label2, modifier = Modifier.padding(top = 4.dp)) }
        }
    }
}

/** F6: a channel without video shows a large logo and now/next instead of a black picture. */
@Composable
private fun RadioScreen(api: Api, ctl: LiveControl, row: ChannelRow, now: Long) {
    val list = ctl.programsOf(row.id, now)
    Box(Modifier.fillMaxSize().background(C.bg), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            ChannelLogo(api, row, 120.dp)
            Text(stringResource(R.string.player_live_radio), style = Type.eyebrow, color = C.label3, modifier = Modifier.padding(top = 24.dp))
            Text(row.name, style = Type.title1, color = C.label, modifier = Modifier.padding(top = 6.dp))
            list.getOrNull(0)?.let { Text(it.title, style = Type.title3, color = C.label2, modifier = Modifier.padding(top = 10.dp)) }
            list.getOrNull(1)?.let { Text("${stringResource(R.string.player_live_next)} · ${timeText(it.start)} ${it.title}", style = Type.callout, color = C.label3, modifier = Modifier.padding(top = 6.dp)) }
        }
    }
}

/** §8.8: the paused stream was released; OK or Play re-tunes. */
@Composable
private fun PauseReleasedCard() {
    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.6f)), contentAlignment = Alignment.Center) {
        Column(
            Modifier.width(520.dp).clip(RoundedCornerShape(Radius.xl)).background(panel).padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(stringResource(CR.string.player_live_paused_released), style = Type.title3, color = C.label)
            Row(
                Modifier.padding(top = 20.dp).clip(RoundedCornerShape(50)).background(Color.White).padding(horizontal = 22.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(Ic.Play, null, tint = Color.Black, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.player_live_resume_live), style = Type.headline, color = Color.Black)
            }
        }
    }
}
