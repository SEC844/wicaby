package com.wika.wicaby.mobile.cast

import android.content.ComponentName
import android.content.Context
import android.widget.Toast
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.cast.CastController
import com.wika.wicaby.core.cast.CastRemote
import com.wika.wicaby.core.cast.CastTarget
import com.wika.wicaby.core.cast.DlnaDevice
import com.wika.wicaby.core.cast.DlnaRenderers
import com.wika.wicaby.core.cast.LanOnlyException
import com.wika.wicaby.core.cast.UpnpException
import com.wika.wicaby.core.cast.RemoteTargets
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.ApiException
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.TICKS_PER_MS
import com.wika.wicaby.core.player.RemoteCommand
import com.wika.wicaby.core.player.RemoteControl
import com.wika.wicaby.core.player.RemoteHost
import com.wika.wicaby.core.player.RemotePlay
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.wika.wicaby.mobile.player.PlaybackService
import com.wika.wicaby.mobile.player.PlayerActivity
import java.io.IOException
import com.wika.wicaby.mobile.player.PlayerHolder
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// What this phone is casting to: one target at a time (cast spec §1), on the server it was picked from.
object Casting {
    var target by mutableStateOf<CastTarget?>(null)
        private set
    private var api: Api? = null
    private var remote: CastRemote? = null
    // A direct cast (CA-08 DLNA, CA-10 Emby on a Chromecast): this phone feeds the device and reports for it, from
    // PlaybackService's foreground service. null for a target that reports for itself (Sessions API, Jellyfin receiver).
    var direct: CastController? = null
        private set
    private var service: ListenableFuture<MediaController>? = null

    // What drives [t]: a renderer found by the picker (direct DLNA, "d:" keys), a Cast route (gplay, "c:") or the
    // Sessions API. A direct cast reports as this device: local playback ends once the device plays, before the cast's
    // Playing (§8.4).
    fun remoteFor(context: Context, api: Api, t: CastTarget): CastRemote {
        val beforePlaying: suspend () -> Unit = { withContext(Dispatchers.Main) { PlayerHolder.playback?.stop() } }
        return when {
            t.key.startsWith("d:") -> CastController(api, DlnaDevice(DlnaRenderers.get(t.key) ?: throw IOException("renderer gone")), beforePlaying = beforePlaying)
            t.key.startsWith("c:") -> GoogleCastProvider.get(context)?.remote(api, t, beforePlaying) ?: throw IOException("no Google Cast")
            else -> RemoteTargets(api)
        }
    }

    fun start(context: Context, api: Api, t: CastTarget, remote: CastRemote) {
        stopDirect()
        this.api = api
        this.remote = remote
        target = t
        val c = remote as? CastController ?: return
        direct = c
        // Binding a controller starts PlaybackService, which hosts the cast's MediaSession (notification, lock
        // screen) and outlives the activity. The cast ends by itself (end of media, renderer lost): clear it.
        val app = context.applicationContext
        service = MediaController.Builder(app, SessionToken(app, ComponentName(app, PlaybackService::class.java))).buildAsync()
        Core.scope.launch(Dispatchers.Main) {
            val end = c.ended.first { it != null }
            if (direct !== c) return@launch
            if (end == CastController.End.Lost) Toast.makeText(app, Core.str(R.string.cast_error_lost, t.name), Toast.LENGTH_LONG).show()
            stop()
        }
    }

    fun stop() {
        target = null
        api = null
        remote = null
        direct = null
        service?.let { MediaController.releaseFuture(it) }
        service = null
    }

    // Local playback or another cast is about to start: a direct cast reports as this device's own session, so it
    // stops first (§1). Its Stopped is queued before this returns (UNDISPATCHED), ahead of the next Playing (§8.4);
    // the returned job ends once the renderer was told.
    fun stopDirect(): Job? {
        val c = direct ?: return null
        stop()
        return Core.scope.launch(start = CoroutineStart.UNDISPATCHED) { c.stop() }
    }

    // The target and what drives it, if it belongs to [api]'s server and user (a server or user switch hides it).
    fun of(api: Api): Pair<CastTarget, CastRemote>? {
        val t = target ?: return null
        val a = this.api?.takeIf { it.server.id == api.server.id && it.userId == api.userId } ?: return null
        return t to (remote ?: RemoteTargets(a))
    }

    // "Reprendre ici": the target's position, version and tracks, then a local start as if the target had sent Play here.
    suspend fun playHere(context: Context, api: Api) {
        val (t, rt) = of(api) ?: return
        val s = rt.mirror(t).first()
        val id = s.itemId
        runCatching { rt.transport(t, "Stop") }
        stop()
        if (id == null) return
        val p = s.session?.playState
        val host = object : RemoteHost {
            override fun play(request: RemotePlay) = PlayerActivity.start(context, request.itemId, fromStart = false)
            override fun volume(command: String, level: Int?) = Unit
            override fun message(header: String?, text: String) = Unit
        }
        RemoteControl.dispatch(RemoteCommand.Play(RemotePlay(id, s.positionTicks / TICKS_PER_MS, p?.mediaSourceId, p?.audioStreamIndex, p?.subtitleStreamIndex)), null, host)
    }
}

private enum class Sheet { Picker, Panel }

// The one Cast button (CA-03), drawn by [button] (Detail's action icon, the player's top bar). Idle it opens the
// picker, while casting the remote panel. [send] starts the item on the picked target and returns whether it took
// (the player's handoff waits for the mirror); [onCast] runs once it did (the player then closes).
@Composable
fun CastButton(
    api: Api,
    item: Item,
    send: suspend (CastRemote, CastTarget) -> Boolean,
    onCast: () -> Unit = {},
    // Whether a sheet is open (the player keeps its controls, which host this button, on screen meanwhile).
    onSheet: (Boolean) -> Unit = {},
    button: @Composable (casting: Boolean, onClick: () -> Unit) -> Unit,
) {
    val context = LocalContext.current
    val res = LocalResources.current
    var sheet by remember { mutableStateOf<Sheet?>(null) }
    LaunchedEffect(sheet) { onSheet(sheet != null) }
    val casting = Casting.of(api) != null
    button(casting) { sheet = if (casting) Sheet.Panel else Sheet.Picker }
    when (sheet) {
        Sheet.Picker -> CastPicker(
            api, item, casting,
            onPick = { t ->
                sheet = null
                // Not this composable's scope: the player's top bar (and this button) may hide during the 10 s handoff.
                Core.scope.launch(Dispatchers.Main) {
                    // The current direct cast ends first, renderer included: the same TV would otherwise get its Stop
                    // after the new stream's load, and the server the old Stopped after the new Playing.
                    Casting.stopDirect()?.join()
                    val remote = runCatching { Casting.remoteFor(context, api, t) }
                    val r = remote.mapCatching { send(it, t) }
                    val e = r.exceptionOrNull()
                    val error = when {
                        r.getOrNull() == true -> null
                        e is LanOnlyException -> R.string.cast_error_lan_only
                        (e as? ApiException)?.status in 400..499 || e is UpnpException -> R.string.cast_error_rejected
                        else -> R.string.cast_error_unreachable
                    }
                    if (error == null) {
                        Casting.start(context, api, t, remote.getOrThrow())
                        Toast.makeText(context, res.getString(R.string.cast_started, t.name), Toast.LENGTH_SHORT).show()
                        onCast()
                    } else Toast.makeText(context, res.getString(error, t.name), Toast.LENGTH_LONG).show()
                }
            },
            onHere = {
                sheet = null
                Core.scope.launch(Dispatchers.Main) { Casting.playHere(context, api) }
            },
            onDismiss = { sheet = null },
        )
        Sheet.Panel -> RemotePanel(api, onOther = { sheet = Sheet.Picker }, onDismiss = { sheet = null })
        null -> Unit
    }
}
