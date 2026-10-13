package com.wika.wicaby.mobile.cast

import android.content.Context
import androidx.media3.cast.RemoteCastPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.mediarouter.media.MediaRouteSelector
import androidx.mediarouter.media.MediaRouter
import com.google.android.gms.cast.CastDevice
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastSession
import com.google.android.gms.cast.framework.SessionManagerListener
import com.wika.wicaby.core.cast.CastController
import com.wika.wicaby.core.cast.CastDevice as WicabyCastDevice
import com.wika.wicaby.core.cast.CastProfiles
import com.wika.wicaby.core.cast.CastRemote
import com.wika.wicaby.core.cast.CastStream
import com.wika.wicaby.core.cast.Disposable
import com.wika.wicaby.core.cast.EphemeralTokens
import com.wika.wicaby.core.cast.CastTarget
import com.wika.wicaby.core.cast.LanOnlyException
import com.wika.wicaby.core.cast.RemoteTargets
import com.wika.wicaby.core.cast.SessionState
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.putJsonObject
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.roundToInt

// Google Cast through Play services (cast spec CA-10, gplay only). Routes come from MediaRouter; a picked one is
// connected through the CastContext with the receiver the server kind needs (§1): the Default Media Receiver for Emby
// (this phone prepares the stream and reports, CastController + GmsDevice), Jellyfin's own receiver for Jellyfin
// (JellyfinReceiver: it plays and reports by itself). Play services and MediaRouter want the main thread.
class GmsGoogleCast(context: Context, private val cast: CastContext) : GoogleCast {
    private val app = context.applicationContext
    private val router = MediaRouter.getInstance(app)
    // Discovery asks for devices that run the Default Media Receiver, which every Cast device does.
    private val selector = MediaRouteSelector.Builder().addControlCategory(CastMediaControlIntent.categoryForCast(DMR)).build()
    // The routes the picker showed, by key, for remote(). Memory only (§2.2: never written to disk).
    private val seen = HashMap<String, MediaRouter.RouteInfo>()
    // One RemoteCastPlayer for every DMR cast: it follows the current Cast session by itself.
    private var player: RemoteCastPlayer? = null
    private val prepared = HashMap<String, CastStream>()

    override val routes: Flow<List<CastTarget>> = callbackFlow {
        fun emit() {
            val list = router.routes.filter { !it.isDefault && it.isEnabled && it.matchesSelector(selector) }
            list.forEach { seen["c:" + it.id] = it }
            trySend(list.map(::target))
        }
        val cb = object : MediaRouter.Callback() {
            override fun onRouteAdded(router: MediaRouter, route: MediaRouter.RouteInfo) = emit()
            override fun onRouteRemoved(router: MediaRouter, route: MediaRouter.RouteInfo) = emit()
            override fun onRouteChanged(router: MediaRouter, route: MediaRouter.RouteInfo) = emit()
        }
        router.addCallback(selector, cb, MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN)
        emit()
        awaitClose { router.removeCallback(cb) }
    }.flowOn(Dispatchers.Main)

    // §2.3 synthetic commands: volume through the receiver, tracks by a new load (DMR) or through the session (Jellyfin).
    private fun target(r: MediaRouter.RouteInfo) = CastTarget(
        "c:" + r.id, CastTarget.Kind.Cast, r.name, r.description ?: CastDevice.getFromBundle(r.extras)?.modelName.orEmpty(),
        commands = setOf("SetVolume", "Mute", "Unmute", "ToggleMute", "SetAudioStreamIndex", "SetSubtitleStreamIndex"),
        mediaTypes = setOf("Audio", "Video"),
    )

    override fun remote(api: Api, target: CastTarget, beforePlaying: suspend () -> Unit): CastRemote {
        val route = seen[target.key] ?: throw IOException("route gone")
        // Only a Jellyfin server goes to Jellyfin's receiver: it is handed the server token. Plex goes to CastController,
        // which refuses it (the Plex token never leaves for a receiver or a URL; casting Plex is the Cast workflow's).
        return if (api.server.kind != "jellyfin") {
            // The receiver loads the page, then the stream: give it longer than a DLNA TV.
            CastController(api, GmsDevice(route, target), startWaitMs = 30_000, beforePlaying = beforePlaying)
        } else JellyfinReceiver(api, route)
    }

    // A session on [route] running [appId]: the current one if it already is, else a new one (the CastContext launches
    // the receiver set just before the route is selected; setReceiverApplicationId verified on 22.3.1).
    private suspend fun connect(route: MediaRouter.RouteInfo, appId: String): CastSession = withContext(Dispatchers.Main) {
        val sm = cast.sessionManager
        val want = CastDevice.getFromBundle(route.extras)?.deviceId
        sm.currentCastSession?.takeIf { s -> s.isConnected && s.castDevice?.deviceId == want && s.applicationMetadata?.applicationId == appId }
            ?.let { return@withContext it }
        if (sm.currentCastSession != null) sm.endCurrentSession(true)
        cast.setReceiverApplicationId(appId)
        withTimeoutOrNull(CONNECT_MS) {
            suspendCancellableCoroutine { cont ->
                val l = object : SessionManagerListener<CastSession> {
                    fun done(r: Result<CastSession>) {
                        sm.removeSessionManagerListener(this, CastSession::class.java)
                        if (cont.isActive) r.fold(cont::resume, cont::resumeWithException)
                    }

                    override fun onSessionStarted(session: CastSession, sessionId: String) = done(Result.success(session))
                    override fun onSessionResumed(session: CastSession, wasSuspended: Boolean) = done(Result.success(session))
                    override fun onSessionStartFailed(session: CastSession, error: Int) = done(Result.failure(IOException("${route.name}: cast session failed ($error)")))
                    override fun onSessionStarting(session: CastSession) = Unit
                    override fun onSessionEnding(session: CastSession) = Unit
                    override fun onSessionEnded(session: CastSession, error: Int) = Unit
                    override fun onSessionResuming(session: CastSession, sessionId: String) = Unit
                    override fun onSessionResumeFailed(session: CastSession, error: Int) = Unit
                    override fun onSessionSuspended(session: CastSession, reason: Int) = Unit
                }
                sm.addSessionManagerListener(l, CastSession::class.java)
                cont.invokeOnCancellation { sm.removeSessionManagerListener(l, CastSession::class.java) }
                router.selectRoute(route)
            }
        } ?: throw IOException("${route.name} did not answer")
    }

    private fun session(): CastSession = cast.sessionManager.currentCastSession?.takeIf { it.isConnected } ?: throw IOException("cast session gone")

    // The Default Media Receiver, driven through RemoteCastPlayer: CastMediaItems turns the stream CastController
    // prepared into the LOAD. States in DLNA's names for CastController. Main thread throughout.
    private inner class GmsDevice(private val route: MediaRouter.RouteInfo, override val target: CastTarget) : WicabyCastDevice {
        private var loaded: CastStream? = null
        private val model get() = CastDevice.getFromBundle(route.extras)?.modelName.orEmpty()
        override val name: String get() = route.name
        override val id: String get() = CastDevice.getFromBundle(route.extras)?.deviceId ?: route.id
        override val client get() = "Chromecast"
        override val bitrate get() = CastProfiles.CAST_BITRATE

        override suspend fun profile(): JsonObject {
            connect(route, DMR)
            return CastProfiles.cast(model, jellyfin = false, CastSettings.allowHevc(app), CastSettings.dolby(app))
        }

        // §2.6.6: mp4/webm (MKV is remuxed by the server, which then lists mp4); a video transcode is HLS.
        override fun container(direct: Boolean, containers: List<String>, audio: Boolean) = when {
            direct -> containers.firstOrNull { it in DIRECT } ?: containers.firstOrNull() ?: "mp4"
            audio -> "mp3"
            else -> "m3u8"
        }

        private fun player(): RemoteCastPlayer = player ?: RemoteCastPlayer.Builder(app).setMediaItemConverter(CastMediaItems { prepared[it] }).build().also { player = it }

        override suspend fun load(stream: CastStream) = withContext(Dispatchers.Main) {
            prepared.clear()
            prepared[stream.item.id] = stream
            loaded = stream
            val p = player()
            // Its own session listener may hear of the new session just after connect() did.
            withTimeoutOrNull(5_000) { while (!p.isCastSessionAvailable) delay(100) } ?: throw IOException("cast session not available")
            p.setMediaItem(MediaItem.Builder().setMediaId(stream.item.id).build())
            p.prepare()
            p.play()
        }

        override suspend fun state(): String = withContext(Dispatchers.Main) {
            val p = player()
            if (!p.isCastSessionAvailable) throw IOException("cast session gone")
            when (p.playbackState) {
                Player.STATE_BUFFERING -> "TRANSITIONING"
                Player.STATE_READY -> if (p.playWhenReady) "PLAYING" else "PAUSED_PLAYBACK"
                Player.STATE_ENDED -> "STOPPED"
                else -> if (p.mediaItemCount == 0) "NO_MEDIA_PRESENT" else "STOPPED"
            }
        }

        // Another sender's media shows as another URI, which ends this cast (as a DLNA TrackURI change does).
        override suspend fun position(): Pair<Long?, String> = withContext(Dispatchers.Main) {
            val p = player()
            val id = p.currentMediaItem?.mediaId
            p.currentPosition to when {
                id == null -> ""
                id == loaded?.item?.id -> loaded?.url.orEmpty()
                else -> "other:$id"
            }
        }

        override suspend fun play() = withContext(Dispatchers.Main) { player().play() }

        override suspend fun pause() = withContext(Dispatchers.Main) { player().pause() }

        override suspend fun seek(ms: Long) = withContext(Dispatchers.Main) { player().seekTo(ms) }

        // Stops the media and closes the receiver app on the TV.
        override suspend fun stop() = withContext(Dispatchers.Main) {
            player().stop()
            cast.sessionManager.endCurrentSession(true)
        }

        override suspend fun volume(): Pair<Int?, Boolean> = withContext(Dispatchers.Main) {
            val s = session()
            (s.volume * 100).roundToInt() to s.isMute
        }

        override suspend fun setVolume(v: Int) = withContext(Dispatchers.Main) { session().volume = v / 100.0 }

        override suspend fun setMute(on: Boolean) = withContext(Dispatchers.Main) { session().isMute = on }
    }

    // Jellyfin's receiver (§1, CA-09's message): it gets the server address and a token, plays the queue itself and
    // shows up as a Jellyfin session, so once it plays the remote panel drives that session through the Sessions API
    // and this phone reports nothing (§2.5).
    private inner class JellyfinReceiver(private val api: Api, private val route: MediaRouter.RouteInfo) : CastRemote {
        private val sessions = RemoteTargets(api)
        private var receiver: CastTarget? = null
        // What it was asked to play (RemoteTargets lists the sessions that can play its media type).
        private var item: Item? = null
        // CA-11: the receiver's disposable token; it plays on after this phone lets go, so only Stop revokes it here
        // (else the next cleanup once its session is gone).
        private var disposable: Disposable? = null

        override suspend fun play(target: CastTarget, ids: List<String>, startIndex: Int, positionTicks: Long?, msid: String?, audio: Int?, sub: Int?, command: String) {
            // The receiver calls the API itself: only a LAN address it can reach (§2.6.4).
            val base = CastController.lanBase(api) ?: throw LanOnlyException()
            val appId = runCatching {
                api.get<JsonObject>("/Users/${api.userId}")["Configuration"]?.jsonObject?.get("CastReceiverId")?.jsonPrimitive?.contentOrNull
            }.getOrNull()?.takeIf { it.isNotBlank() } ?: JELLYFIN_RECEIVER
            val version = runCatching { api.get<JsonObject>("/System/Info/Public")["Version"]?.jsonPrimitive?.contentOrNull }.getOrNull()
            val items = ids.map { api.item(it) }
            item = items.getOrNull(startIndex) ?: items.first()
            val s = connect(route, appId)
            disposable?.let { old -> Core.scope.launch { EphemeralTokens.shared.revoke(old, api) } }
            val token = EphemeralTokens.shared.mint(api, route.name, EphemeralTokens.RECEIVER).also { disposable = it }
            val msg = buildJsonObject {
                put("command", command)
                putJsonObject("options") {
                    putJsonArray("items") {
                        items.forEach { i ->
                            addJsonObject {
                                put("Id", i.id); put("ServerId", api.server.id); put("Name", i.name); put("Type", i.type)
                                put("MediaType", i.mediaType); put("IsFolder", i.isFolder)
                            }
                        }
                    }
                    put("startIndex", startIndex)
                    positionTicks?.let { put("startPositionTicks", it) }
                    msid?.let { put("mediaSourceId", it) }
                    audio?.let { put("audioStreamIndex", it) }
                    sub?.let { put("subtitleStreamIndex", it) }
                }
                put("userId", api.userId)
                put("deviceId", api.deviceId)
                put("accessToken", token?.token ?: api.token)
                put("serverAddress", base.toString().trimEnd('/'))
                put("serverId", api.server.id)
                version?.let { put("serverVersion", it) }
                put("receiverName", route.name)
            }
            withContext(Dispatchers.Main) { s.sendMessage(CONNECTSDK, msg.toString()) }
            // §2.4: the receiver's MEDIA_STATUS turns PLAYING or BUFFERING.
            withTimeoutOrNull(START_MS) {
                while (withContext(Dispatchers.Main) { s.remoteMediaClient?.let { it.isPlaying || it.isBuffering } != true }) delay(500)
            } ?: run {
                revoke()
                throw IOException("${route.name} did not start")
            }
        }

        private fun revoke() {
            val d = disposable ?: return
            disposable = null
            Core.scope.launch { EphemeralTokens.shared.revoke(d, api) }
        }

        // The receiver's Jellyfin session: its DeviceName is the receiver name it was given, its Client "Chromecast".
        private suspend fun session(timeoutMs: Long = 10_000): CastTarget? = receiver ?: withTimeoutOrNull(timeoutMs) {
            val i = item ?: return@withTimeoutOrNull null
            var found: CastTarget? = null
            while (found == null) {
                found = runCatching { sessions.list(i) }.getOrNull().orEmpty().firstOrNull { it.name == route.name && it.detail.contains("chromecast", true) }
                if (found == null) delay(1_000)
            }
            found
        }?.also { receiver = it }

        override suspend fun transport(target: CastTarget, cmd: String, seekTicks: Long?) {
            session()?.let { sessions.transport(it, cmd, seekTicks) }
            if (cmd.equals("Stop", true)) {
                withContext(Dispatchers.Main) { cast.sessionManager.endCurrentSession(true) }
                revoke()
            }
        }

        override suspend fun command(target: CastTarget, name: String, args: Map<String, String>): Boolean =
            session()?.let { sessions.command(it, name, args) } == true

        override fun mirror(target: CastTarget): Flow<SessionState> = flow {
            val t = session()
            if (t == null) emit(SessionState(null, 0)) else emitAll(sessions.mirror(t))
        }

        override suspend fun awaitPlaying(target: CastTarget, itemId: String, timeoutMs: Long): Boolean =
            session(timeoutMs)?.let { sessions.awaitPlaying(it, itemId, timeoutMs) } == true
    }

    companion object {
        const val DMR = CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID
        const val JELLYFIN_RECEIVER = "F007D354"
        const val CONNECTSDK = "urn:x-cast:com.connectsdk"
        private const val CONNECT_MS = 20_000L
        private const val START_MS = 30_000L
        private val DIRECT = setOf("mp4", "m4v", "webm", "mp3", "flac", "aac", "m4a", "ogg", "opus")
    }
}
