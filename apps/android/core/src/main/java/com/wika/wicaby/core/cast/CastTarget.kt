package com.wika.wicaby.core.cast

import kotlinx.coroutines.flow.Flow

// One row of the Cast picker (cast spec §2.1). key: "s:<serverId>:<sessionId>" | "d:<udn>" | "c:<castId>".
// detail: the client ("Wicaby TV", "Emby Web"), or for a server DLNA session the server's name ("via {server}").
data class CastTarget(
    val key: String,
    val kind: Kind,
    val name: String,
    val detail: String,
    val serverId: String? = null,
    val sessionId: String? = null,
    // The session's DeviceId (the renderer's UDN for a server DLNA session): the mirror polls by it.
    val deviceId: String? = null,
    val commands: Set<String> = emptySet(),
    val mediaTypes: Set<String> = emptySet(),
) {
    enum class Kind { Session, Dlna, Cast }

    // General commands only, case-insensitively (§2.3: Playstate is never gated, servers spell it two ways).
    fun supports(command: String) = commands.any { it.equals(command, ignoreCase = true) }
}

// What the picker and the remote panel drive, whatever the transport: RemoteTargets (Sessions API) or
// CastController (a DLNA renderer this device feeds and reports for).
interface CastRemote {
    suspend fun play(
        target: CastTarget, ids: List<String>, startIndex: Int = 0, positionTicks: Long? = null, msid: String? = null,
        audio: Int? = null, sub: Int? = null, command: String = "PlayNow",
    )

    suspend fun transport(target: CastTarget, cmd: String, seekTicks: Long? = null)

    suspend fun command(target: CastTarget, name: String, args: Map<String, String> = emptyMap()): Boolean

    fun mirror(target: CastTarget): Flow<SessionState>

    // §2.4: whether the target now plays [itemId].
    suspend fun awaitPlaying(target: CastTarget, itemId: String, timeoutMs: Long = 10_000): Boolean
}
