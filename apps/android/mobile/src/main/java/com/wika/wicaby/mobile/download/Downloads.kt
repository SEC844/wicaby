package com.wika.wicaby.mobile.download

import android.app.Notification
import android.content.Context
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.util.AtomicFile
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.SafeNames
import com.wika.wicaby.core.data.Versions
import com.wika.wicaby.core.data.json
import com.wika.wicaby.core.data.poster
import com.wika.wicaby.core.player.LocalMedia
import com.wika.wicaby.core.plex.PlexApi
import com.wika.wicaby.mobile.Lang
import com.wika.wicaby.mobile.R
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

enum class DlState { Queued, Running, Done, Failed }

// One offline copy: the item as fetched with streams and chapters (so it plays and skips
// intros offline), the original file and a poster.
@Serializable
data class DownloadEntry(
    val id: String,
    val serverId: String,
    val userId: String,
    val item: Item,
    val file: String,
    val poster: String? = null,
    val bytes: Long = 0,
    val total: Long = 0,
    val state: DlState = DlState.Queued,
    // The version (MediaSource) chosen on the detail page; null = the server default.
    val sourceId: String? = null,
    // ETag (else Last-Modified) of the response the .part started from; a resume must match it.
    val validator: String? = null,
) {
    val fraction: Float get() = if (total > 0) (bytes.toFloat() / total).coerceIn(0f, 1f) else 0f

    // Item ids are per server (two Emby servers both have a "4512"): a copy is the pair.
    fun isOf(serverId: String, id: String) = this.serverId == serverId && this.id == id
}

// WorkManager's unique name for one copy.
internal fun workName(serverId: String, id: String) = "dl-$serverId-$id"

// The name used before copies were keyed by server; such a job may still be queued after an upgrade.
internal fun legacyWorkName(id: String) = "dl-$id"

// The index lives in filesDir/downloads/index.json; the worker updates it in-process, so the
// UI just collects [entries].
object Downloads {
    const val CHANNEL = "downloads"
    private lateinit var dir: File
    // AtomicFile: a crash mid-write keeps the previous index rather than a torn one that decodes to no downloads.
    private val index get() = AtomicFile(File(dir, "index.json"))
    private val _entries = MutableStateFlow<List<DownloadEntry>>(emptyList())
    val entries: StateFlow<List<DownloadEntry>> = _entries

    fun init(context: Context) {
        dir = File(context.filesDir, "downloads").apply { mkdirs() }
        _entries.value = runCatching { json.decodeFromString<List<DownloadEntry>>(index.readFully().decodeToString()) }.getOrDefault(emptyList())
            // Only entries whose id and file are plain names inside the downloads folder.
            .filter { SafeNames.isValidId(it.id) && SafeNames.isValidId(it.serverId) && owned(it.file) && (it.poster == null || owned(it.poster)) }
            // A copy that was mid-transfer when the process died is queued again...
            .map { if (it.state == DlState.Running) it.copy(state = DlState.Queued) else it }
        // ...while WorkManager still holds its job; with no job left, it shows as failed (tap to retry).
        Core.scope.launch {
            val wm = WorkManager.getInstance(context)
            for (e in _entries.value.filter { it.state == DlState.Queued }) {
                // Also the name used before copies were keyed by server ("dl-<id>"): that job still runs after an upgrade.
                val pending = runCatching {
                    listOf(workName(e.serverId, e.id), legacyWorkName(e.id)).any { n -> wm.getWorkInfosForUniqueWork(n).get().any { !it.state.isFinished } }
                }.getOrDefault(true)
                if (!pending) update(e.serverId, e.id) { if (it.state == DlState.Queued) it.copy(state = DlState.Failed) else it }
            }
        }
    }

    // Every path the downloads code reads, writes or deletes must resolve inside [dir].
    internal fun owned(path: String): Boolean = SafeNames.isInside(dir, File(path))

    fun entry(serverId: String, id: String) = _entries.value.firstOrNull { it.isOf(serverId, id) }

    @Synchronized
    fun update(serverId: String, id: String, persist: Boolean = true, f: (DownloadEntry) -> DownloadEntry) {
        _entries.value = _entries.value.map { if (it.isOf(serverId, id)) f(it) else it }
        if (persist) save()
    }

    @Synchronized
    private fun put(e: DownloadEntry) {
        _entries.value = _entries.value.filterNot { it.isOf(e.serverId, e.id) } + e
        save()
    }

    private fun save() = runCatching {
        val f = index
        val out = f.startWrite()
        try {
            out.write(json.encodeToString(_entries.value).toByteArray())
            f.finishWrite(out)
        } catch (e: Exception) {
            f.failWrite(out)
            throw e
        }
    }

    // Only a copy of [serverId]'s item: another server's item with the same id is another title.
    fun local(serverId: String, id: String): LocalMedia? {
        val e = entry(serverId, id)?.takeIf { it.state == DlState.Done } ?: return null
        val f = File(e.file).takeIf { owned(e.file) && it.exists() } ?: return null
        return LocalMedia(e.item, Uri.fromFile(f))
    }

    fun usedBytes(): Long = _entries.value.sumOf { File(it.file).length() + File(it.file + ".part").length() }

    fun enqueue(context: Context, api: Api, item: Item) {
        val app = context.applicationContext
        Core.scope.launch {
            val full = runCatching { api.item(item.id) }.getOrDefault(item)
            // The id becomes a file name: a server-supplied "../x" never leaves the folder.
            val sid = api.server.id
            if (!SafeNames.isValidId(full.id) || !SafeNames.isValidId(sid)) return@launch
            // The version picked on the detail page (Versions remembers it per item). The stored item
            // keeps only that source, so the offline copy plays with its streams.
            val source = Versions.selected(full)
            // Plex: only what the server allows (allowSync, plex spec §1.3); otherwise say why, never work around it.
            if (api is PlexApi && runCatching { api.downloadPath(full.id, source?.id) }.getOrNull() == null) {
                withContext(Dispatchers.Main) { Toast.makeText(app, R.string.plex_download_not_allowed, Toast.LENGTH_LONG).show() }
                return@launch
            }
            val ext = SafeNames.extension(source?.container)
            val prev = entry(sid, full.id)
            val file = File(targetPath(prev?.file, File(dir, "${full.id}.$ext").path, File(dir, "$sid-${full.id}.$ext").path))
            if (!owned(file.path)) return@launch
            // The replaced copy's file and .part would be referenced by nothing; only when no job writes them.
            if (prev != null && prev.file != file.path && owned(prev.file) && (prev.state == DlState.Failed || prev.state == DlState.Done)) {
                File(prev.file).delete()
                File(prev.file + ".part").delete()
            }
            // A re-download (failed entry) resumes its .part only with what the part was checked against.
            val old = prev?.takeIf { keepsPart(it, file.path, source?.id) }
            if (old == null) File(file.path + ".part").delete()
            put(
                DownloadEntry(
                    full.id, sid, api.userId.orEmpty(), full.copy(mediaSources = listOfNotNull(source)), file.path,
                    total = old?.total?.takeIf { it > 0 } ?: source?.size ?: 0, sourceId = source?.id, validator = old?.validator,
                ),
            )
            schedule(app, sid, full.id)
        }
    }

    fun retry(context: Context, serverId: String, id: String) {
        if (!SafeNames.isValidId(id)) return
        update(serverId, id) { it.copy(state = DlState.Queued) }
        Core.scope.launch { schedule(context.applicationContext, serverId, id) }
    }

    private suspend fun schedule(context: Context, serverId: String, id: String) {
        val wifiOnly = Core.prefs.current().wifiOnlyDownloads
        val req = OneTimeWorkRequestBuilder<DownloadWorker>()
            .setInputData(workDataOf("id" to id, "server" to serverId))
            .setConstraints(Constraints(requiredNetworkType = if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED))
            .addTag("download")
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(workName(serverId, id), ExistingWorkPolicy.KEEP, req)
    }

    fun delete(context: Context, serverId: String, id: String) {
        WorkManager.getInstance(context).run {
            cancelUniqueWork(workName(serverId, id))
            // A job from before the upgrade would otherwise keep writing a .part for a deleted copy.
            cancelUniqueWork(legacyWorkName(id))
        }
        val e = entry(serverId, id) ?: return
        if (owned(e.file)) {
            File(e.file).delete()
            File(e.file + ".part").delete()
        }
        e.poster?.takeIf { owned(it) }?.let { File(it).delete() }
        synchronized(this) {
            _entries.value = _entries.value.filterNot { it.isOf(serverId, id) }
            save()
        }
    }

    internal fun posterFile(serverId: String, id: String) = File(dir, "$serverId-$id.poster")
}

// A 206 continues the .part only when it is provably the same file: it starts where the part
// ends, and has the size and the validator recorded when the part began.
internal fun continuesPart(have: Long, contentRange: String?, validator: String?, savedValidator: String?, savedTotal: Long): Boolean {
    val m = Regex("""bytes (\d+)-\d+/(\d+|\*)""").matchEntire(contentRange?.trim() ?: return false) ?: return false
    if (m.groupValues[1].toLongOrNull() != have) return false
    // Nothing recorded to compare with: no proof, no splice.
    if (savedValidator == null && savedTotal <= 0) return false
    return (savedValidator == null || savedValidator == validator) && (savedTotal <= 0 || m.groupValues[2].toLongOrNull() == savedTotal)
}

// The old entry still describes the .part on disk: same file and same version.
internal fun keepsPart(old: DownloadEntry, file: String, sourceId: String?) = old.file == file && old.sourceId == sourceId

// Released builds named copies "<id>.<ext>": an entry still on that name keeps it, so its .part resumes.
internal fun targetPath(prevFile: String?, legacy: String, fresh: String) = if (prevFile == legacy) legacy else fresh

class DownloadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val id = inputData.getString("id")?.takeIf(SafeNames::isValidId) ?: return Result.failure()
        // A job queued before copies were keyed by server names none: the only entry with that id.
        val sid = inputData.getString("server") ?: Downloads.entries.value.singleOrNull { it.id == id }?.serverId ?: return Result.failure()
        val e = Downloads.entry(sid, id)?.takeIf { Downloads.owned(it.file) } ?: return Result.failure()
        // WorkManager may start this before any screen has built the API client.
        // TP-06: the item's server may be an extra account.
        val api = Servers.all.firstOrNull { it.server.id == e.serverId && it.userId == e.userId }
            ?: Core.prefs.current().let { s -> (listOfNotNull(s.session) + s.extras).firstOrNull { it.server.id == e.serverId && it.userId == e.userId }?.let { Api.of(it.server, s.deviceId, it.token, it.userId) } }
            ?: return Result.failure().also { Downloads.update(sid, id) { it.copy(state = DlState.Failed) } }
        // Without the notification permission this still runs, just without a visible notification.
        runCatching { setForeground(foreground(e.item.name, e.fraction)) }
        Downloads.update(sid, id) { it.copy(state = DlState.Running) }
        return try {
            transfer(api, e)
            Downloads.update(sid, id) { it.copy(state = DlState.Done, bytes = File(it.file).length(), total = File(it.file).length()) }
            Result.success()
        } catch (x: CancellationException) {
            // Stopped (constraints lost, quota): WorkManager runs it again later.
            Downloads.update(sid, id) { it.copy(state = DlState.Queued) }
            throw x
        } catch (x: IOException) {
            if (isStopped) return Result.failure().also { Downloads.update(sid, id) { it.copy(state = DlState.Queued) } }
            if (runAttemptCount < 4) {
                Downloads.update(sid, id) { it.copy(state = DlState.Queued) }
                Result.retry()
            } else {
                Downloads.update(sid, id) { it.copy(state = DlState.Failed) }
                Result.failure()
            }
        }
    }

    private suspend fun transfer(api: Api, e: DownloadEntry) = withContext(Dispatchers.IO) {
        val part = File(e.file + ".part")
        val have = part.length()
        // Plex: the original part, read from the item (allowSync) by a fresh client; null when the server stopped allowing it.
        val url = if (api is PlexApi) api.downloadPath(e.id, e.sourceId) ?: throw IOException("download not allowed") else api.downloadUrl(e.id, e.sourceId)
        val req = Request.Builder().url(url).apply {
            api.authHeaders().forEach { (k, v) -> header(k, v) }
            // Resume a partial file after a dropped connection or a reboot; If-Range makes a
            // compliant server answer 200 (the whole new file) when the source changed.
            if (have > 0) {
                header("Range", "bytes=$have-")
                e.validator?.let { header("If-Range", it) }
            }
        }.build()
        Core.http.newCall(req).execute().use { r ->
            if (!r.isSuccessful) throw IOException("HTTP ${r.code}")
            val append = r.code == 206 && have > 0
            val validator = r.header("ETag") ?: r.header("Last-Modified")
            // Servers that ignore If-Range: never splice two versions, start over from 0.
            if (append && !continuesPart(have, r.header("Content-Range"), validator, e.validator, e.total)) {
                part.delete()
                Downloads.update(e.serverId, e.id) { it.copy(bytes = 0) }
                throw IOException("source changed")
            }
            val start = if (append) have else 0L
            val len = r.body.contentLength()
            val total = if (len > 0) start + len else e.total
            // A fresh .part: record what a later resume must match.
            if (!append) Downloads.update(e.serverId, e.id) { it.copy(total = total, validator = validator) }
            var bytes = start
            var last = 0L
            FileOutputStream(part, append).use { out ->
                val src = r.body.byteStream()
                val buf = ByteArray(256 * 1024)
                while (true) {
                    if (isStopped) throw IOException("stopped")
                    val n = src.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    bytes += n
                    val now = System.currentTimeMillis()
                    if (now - last > 500) {
                        last = now
                        val b = bytes
                        Downloads.update(e.serverId, e.id, persist = false) { it.copy(bytes = b, total = total) }
                        setProgress(workDataOf("bytes" to b, "total" to total))
                        if (total > 0) runCatching { setForeground(foreground(e.item.name, b.toFloat() / total)) }
                    }
                }
            }
            if (total > 0 && bytes < total) throw IOException("short read")
        }
        if (!part.renameTo(File(e.file))) throw IOException("rename")
        // Artwork for the offline list; optional.
        runCatching {
            val url = api.poster(e.item, 480) ?: return@runCatching
            val f = Downloads.posterFile(e.serverId, e.id)
            Core.http.newCall(Request.Builder().url(url).build()).execute().use { r -> if (r.isSuccessful) f.writeBytes(r.body.bytes()) }
            Downloads.update(e.serverId, e.id) { it.copy(poster = f.path) }
        }
    }

    private fun foreground(title: String, fraction: Float): ForegroundInfo {
        val n: Notification = NotificationCompat.Builder(applicationContext, Downloads.CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_wicaby)
            .setContentTitle(Lang.wrap(applicationContext).getString(R.string.downloading_n, title))
            .setProgress(1000, (fraction * 1000).toInt(), fraction <= 0f)
            .setOngoing(true)
            .setSilent(true)
            .build()
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(id.hashCode(), n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else ForegroundInfo(id.hashCode(), n)
    }
}
