package com.wika.wicaby.core.data

// What a kind of source supports (file-sources spec §2.2, plex spec §3.4): one table, the same as the desktop's
// shared/server-caps.ts, both checked against tools/checks/fixtures/server-caps.json (ServerCapsTest). Replace a
// scattered isEmby check with these only where a third answer is needed.
data class ServerCaps(
    val admin: Boolean,
    val liveTv: Boolean,
    val sessionsRemote: Boolean,
    val castReceiver: Boolean,
    val favorites: Boolean,
    val serverHubs: Boolean,
    val hideFromResume: Boolean,
    val subtitleSearch: Boolean,
    val comics: Boolean,
    val localUserData: Boolean,
    val transcode: Boolean,
    val castSend: Boolean,
    val homeOptIn: Boolean,
)

// [liveTv]: what the server said at sign-in, for the kinds that probe it. An unknown kind gets the server (emby) row,
// as on the desktop (server-caps.json "$unknownKind").
fun caps(kind: String, liveTv: Boolean = false): ServerCaps = when (kind) {
    "jellyfin" -> ServerCaps(true, liveTv, true, true, true, false, false, true, true, false, true, true, false)
    "plex" -> ServerCaps(false, liveTv, false, false, false, true, true, true, false, false, true, true, false)
    "files" -> ServerCaps(false, false, false, false, false, false, true, false, false, true, false, false, true)
    else -> ServerCaps(true, liveTv, true, true, true, false, true, true, true, false, true, true, false)
}

val Server.caps get() = caps(kind)
