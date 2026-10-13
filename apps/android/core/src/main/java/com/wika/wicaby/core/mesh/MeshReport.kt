package com.wika.wicaby.core.mesh

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * The text behind Remote access > Diagnostics (onboarding spec 3.1), already redacted (3.5): safe to
 * show, scan or paste. [app]: "Wicaby 1.2.3 (tv, Android 14)". [servers]: peers found with a media
 * server by the last "Find Servers", null when not searched. Android keeps no mesh log, so no log tail.
 */
fun meshReport(status: MeshStatus, provider: MeshProvider, managementUrl: String?, app: String, now: Long = System.currentTimeMillis(), servers: Int? = null): String {
    val utc = SimpleDateFormat("yyyy-MM-dd'T'HH:mm'Z'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }
    val self = listOfNotNull(status.selfDnsName ?: status.selfName, status.ips.firstOrNull()).joinToString(" ").ifEmpty { "-" }
    val online = status.peers.count { it.online }
    val text = buildList {
        add("$app · ${utc.format(Date(now))}")
        add("provider: ${(status.provider ?: provider).id} (embedded) · state: ${status.state.name.lowercase()} · management: ${managementUrl ?: "default"}")
        add("self: $self · peers: ${status.peers.size} ($online online${servers?.let { ", $it with a media server" }.orEmpty()})")
        if (status.routes.isNotEmpty()) add("routes: ${status.routes.joinToString(", ")}")
        status.lastError?.let { add("last error (${utc.format(Date(it.at))}): ${it.message}") }
    }.joinToString("\n")
    val names = listOfNotNull(status.selfName, status.selfDnsName) + status.peers.flatMap { listOfNotNull(it.name, it.dnsName) }
    return redactDiagnostics(text, names)
}

/** [text] cut at a line end so its UTF-8 fits a QR code ([maxBytes]; a version 40 code holds about 2.3 KB). */
fun fitQr(text: String, maxBytes: Int = 1800): String {
    var t = text
    while (t.encodeToByteArray().size > maxBytes) t = if ('\n' in t) t.substringBeforeLast('\n') else t.take(t.length * maxBytes / t.encodeToByteArray().size)
    return t
}
