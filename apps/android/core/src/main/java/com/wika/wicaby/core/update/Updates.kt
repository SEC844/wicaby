package com.wika.wicaby.core.update

import android.app.Activity
import android.app.Application
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import com.wika.wicaby.core.BuildConfig
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

// Updates for sideloaded APKs. Réglages > À propos holds a manifest URL (empty = UpdateLogic.DEFAULT_URL); the
// manifest (tools/release/make-update-manifest.mjs writes it) lists, per app ("tv", "mobile"), the
// newest version and one APK per ABI with its SHA-256:
//   { "tv": { "versionCode": 6, "versionName": "0.4.0", "notes": { "fr": "…", "en": "…" },
//             "apks": { "arm64-v8a": { "url": "…", "sha256": "…" }, "armeabi-v7a": {…}, "universal": {…} } },
//     "mobile": { … } }
// The APK goes to the cache, is checked, then handed to a PackageInstaller session (the
// system asks the user to confirm; "Installer des applis inconnues" must be allowed first).

@Serializable
data class ApkRef(val url: String = "", val sha256: String = "")

@Serializable
data class Release(val versionCode: Int = 0, val versionName: String = "", val notes: Map<String, String> = emptyMap(), val apks: Map<String, ApkRef> = emptyMap())

// Pure rules, unit-tested on the JVM.
object UpdateLogic {
    const val UNIVERSAL = "universal"

    // The public releases (tools/release/make-update-manifest.mjs --flat writes this asset). GitHub redirects it
    // over https to the tag's asset, then to its download host; OkHttp follows https -> https redirects.
    const val DEFAULT_URL = "https://github.com/WicaebethTheo/wicaby/releases/latest/download/update.json"

    // The manifest URL to fetch: the one typed in Réglages, else the default.
    fun manifestUrl(stored: String): String = stored.trim().ifEmpty { DEFAULT_URL }

    private val manifestJson = Json { ignoreUnknownKeys = true; isLenient = true }

    fun parse(text: String): Map<String, Release> = manifestJson.decodeFromString(text)

    // "0.4.0" vs "0.3.10" by numeric parts; missing parts count as 0, suffixes ("-beta") are ignored.
    fun compareVersionNames(a: String, b: String): Int {
        fun parts(v: String) = v.trim().removePrefix("v").substringBefore('-').substringBefore('+').split('.').map { p -> p.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
        val x = parts(a)
        val y = parts(b)
        for (i in 0 until maxOf(x.size, y.size)) {
            val c = x.getOrElse(i) { 0 }.compareTo(y.getOrElse(i) { 0 })
            if (c != 0) return c
        }
        return 0
    }

    // versionCode decides; a manifest without one falls back to versionName.
    fun isNewer(r: Release, currentCode: Int, currentName: String): Boolean =
        if (r.versionCode > 0) r.versionCode > currentCode else compareVersionNames(r.versionName, currentName) > 0

    // The device's preferred ABI (Build.SUPPORTED_ABIS[0]), else the universal APK, else any other ABI it runs.
    fun pickApk(apks: Map<String, ApkRef>, abis: List<String>): Pair<String, ApkRef>? {
        val usable = apks.filterValues { it.url.isNotBlank() }
        val order = listOfNotNull(abis.firstOrNull(), UNIVERSAL) + abis.drop(1)
        return order.firstNotNullOfOrNull { abi -> usable[abi]?.let { abi to it } }
    }

    fun notes(r: Release, lang: String): String =
        r.notes[lang] ?: r.notes["en"] ?: r.notes["fr"] ?: r.notes.values.firstOrNull().orEmpty()

    // APK URLs may be relative to the manifest: resolved against the URL asked for, not the redirect target, so
    // a bare file name in the default manifest stays on github.com/…/releases/latest/download/.
    fun resolve(manifestUrl: String, url: String): String = manifestUrl.toHttpUrlOrNull()?.resolve(url)?.toString() ?: url

    // The manifest and the APK are fetched over https only: the APK checksum comes from the
    // manifest, so a cleartext manifest would let anyone on the path swap both. Debug builds
    // may use http (emulator test server on 10.0.2.2).
    fun isAllowedUrl(url: String, allowCleartext: Boolean = false): Boolean {
        val u = url.trim().toHttpUrlOrNull() ?: return false
        return u.isHttps || allowCleartext
    }

    private val SHA256_HEX = Regex("^[0-9a-f]{64}$")

    // A release without a proper SHA-256 is never installed.
    fun isValidSha256(sha: String): Boolean = SHA256_HEX.matches(sha.trim().lowercase())

    // The APK to download for this release, or null when its URL is not allowed or its checksum is missing.
    fun usableApk(manifestUrl: String, apk: ApkRef, allowCleartext: Boolean = false): ApkRef? {
        if (!isValidSha256(apk.sha256)) return null
        val url = resolve(manifestUrl, apk.url)
        if (!isAllowedUrl(url, allowCleartext)) return null
        return ApkRef(url, apk.sha256.trim().lowercase())
    }

    // Final gate before handing the APK to PackageInstaller: same package, signed by the installed
    // app's certificate (any certificate in the archive's rotation lineage), and strictly newer.
    // Certificates are compared as hex digests; [installedSigners] are the current app's signers.
    fun archiveAcceptable(
        packageName: String,
        archivePackage: String?,
        installedVersionCode: Long,
        archiveVersionCode: Long,
        expectedVersionCode: Long,
        installedSigners: Set<String>,
        archiveSigners: Set<String>,
    ): Boolean =
        archivePackage == packageName &&
            archiveVersionCode > installedVersionCode &&
            (expectedVersionCode <= 0 || archiveVersionCode == expectedVersionCode) &&
            installedSigners.isNotEmpty() &&
            archiveSigners.containsAll(installedSigners)
}

class UpdateInfo(val versionCode: Int, val versionName: String, val notes: String, val abi: String, val url: String, val sha256: String)

sealed interface UpdateState {
    data object Idle : UpdateState
    data object Checking : UpdateState
    data object UpToDate : UpdateState
    data class Available(val info: UpdateInfo) : UpdateState
    data class Downloading(val info: UpdateInfo, val fraction: Float) : UpdateState
    data class NeedsPermission(val info: UpdateInfo) : UpdateState
    data class Installing(val info: UpdateInfo) : UpdateState
    data class Failed(val info: UpdateInfo?, val message: String) : UpdateState
}

object Updater {
    private const val INTERVAL_MS = 6 * 60 * 60 * 1000L

    private var channel = ""
    private var versionCode = 0
    private var versionName = ""
    private var job: Job? = null
    // The PackageInstaller session in flight, abandoned on failure and on "Plus tard".
    @Volatile private var sessionId = -1

    // Main thread only. Android 10+ silently drops activity starts from the background, so the
    // system's confirm screen waits here until one of our activities is in front again.
    private var confirm: Intent? = null
    private var resumed = 0

    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    // Each app calls this from Application.onCreate, after Core.init: "tv" or "mobile", and its own version.
    fun init(channel: String, versionCode: Int, versionName: String) {
        this.channel = channel
        this.versionCode = versionCode
        this.versionName = versionName
        Core.app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                resumed++
                confirm?.let { c ->
                    confirm = null
                    launchConfirm(activity, c)
                }
            }

            override fun onActivityPaused(activity: Activity) {
                resumed--
            }

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }

    // App start: at most once every 6 hours, silent unless there is something new.
    fun checkAtStart() {
        Core.scope.launch { check(manual = false) }
    }

    suspend fun check(manual: Boolean) {
        val s = _state.value
        if (s is UpdateState.Downloading || s is UpdateState.Installing || s == UpdateState.Checking) return
        val url = UpdateLogic.manifestUrl(runCatching { Core.prefs.current().updateUrl }.getOrDefault(""))
        if (!UpdateLogic.isAllowedUrl(url, BuildConfig.DEBUG)) {
            if (manual) _state.value = UpdateState.Failed(null, Core.str(R.string.update_check_failed))
            return
        }
        val prefs = Core.prefs
        if (!manual && System.currentTimeMillis() - prefs.updateCheckedAt() < INTERVAL_MS) return
        if (manual) _state.value = UpdateState.Checking
        try {
            val text = withContext(Dispatchers.IO) {
                val req = Request.Builder().url(url).header("Cache-Control", "no-cache").build()
                noDowngrade().newCall(req).execute().use { res ->
                    if (!res.isSuccessful) throw IOException("HTTP ${res.code}")
                    res.body.string()
                }
            }
            prefs.setUpdateCheckedAt(System.currentTimeMillis())
            val release = UpdateLogic.parse(text)[channel]
            if (release == null || !UpdateLogic.isNewer(release, versionCode, versionName)) {
                _state.value = if (manual) UpdateState.UpToDate else UpdateState.Idle
                return
            }
            val abis = Build.SUPPORTED_ABIS.toList()
            val (abi, apk) = UpdateLogic.pickApk(release.apks, abis) ?: run {
                _state.value = if (manual) UpdateState.Failed(null, Core.str(R.string.update_no_apk, abis.firstOrNull().orEmpty())) else UpdateState.Idle
                return
            }
            // No https or no SHA-256: refuse rather than install something unverifiable.
            val safe = UpdateLogic.usableApk(url, apk, BuildConfig.DEBUG) ?: run {
                _state.value = if (manual) UpdateState.Failed(null, Core.str(R.string.update_check_failed)) else UpdateState.Idle
                return
            }
            val notes = UpdateLogic.notes(release, Core.locale.language)
            _state.value = UpdateState.Available(UpdateInfo(release.versionCode, release.versionName, notes, abi, safe.url, safe.sha256))
        } catch (e: Exception) {
            if (BuildConfig.DEBUG) Log.w("Wicaby", "update check", e)
            _state.value = if (manual) UpdateState.Failed(null, Core.str(R.string.update_check_failed)) else UpdateState.Idle
        }
    }

    // "Plus tard": hidden until the next check, and nothing gets installed (download stopped,
    // session abandoned, a pending confirm screen dropped).
    fun later() {
        job?.cancel()
        confirm = null
        _state.value = UpdateState.Idle
        abandon(sessionId)
    }

    private fun abandon(id: Int) {
        if (id < 0) return
        runCatching { Core.app.packageManager.packageInstaller.abandonSession(id) }
        if (id == sessionId) sessionId = -1
    }

    private fun info(): UpdateInfo? = when (val s = _state.value) {
        is UpdateState.Available -> s.info
        is UpdateState.NeedsPermission -> s.info
        is UpdateState.Failed -> s.info
        is UpdateState.Downloading -> s.info
        is UpdateState.Installing -> s.info
        else -> null
    }

    fun canInstall(context: Context): Boolean = Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

    // "Installer des applis inconnues" for Wicaby; older or trimmed-down TVs only have the security page.
    fun openInstallSettings(context: Context) {
        val tries = buildList {
            if (Build.VERSION.SDK_INT >= 26) add(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
            add(Intent(Settings.ACTION_SECURITY_SETTINGS))
            add(Intent(Settings.ACTION_SETTINGS))
        }
        for (i in tries) {
            try {
                context.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return
            } catch (_: ActivityNotFoundException) {
            } catch (_: SecurityException) {
            }
        }
    }

    // "Mettre à jour": permission, download (resumed from the cache when already there), checksum, install.
    fun install(context: Context) {
        val info = info() ?: return
        if (_state.value is UpdateState.Downloading || _state.value is UpdateState.Installing) return
        val app = context.applicationContext
        if (!canInstall(app)) {
            _state.value = UpdateState.NeedsPermission(info)
            return
        }
        _state.value = UpdateState.Downloading(info, 0f)
        job = Core.scope.launch {
            val file = try {
                download(app, info)
            } catch (e: ChecksumException) {
                _state.value = UpdateState.Failed(info, Core.str(R.string.update_bad_checksum))
                return@launch
            } catch (e: Exception) {
                if (BuildConfig.DEBUG) Log.w("Wicaby", "update download", e)
                if (_state.value is UpdateState.Downloading) _state.value = UpdateState.Failed(info, Core.str(R.string.update_download_failed))
                return@launch
            }
            if (_state.value !is UpdateState.Downloading) return@launch
            _state.value = UpdateState.Installing(info)
            try {
                verifyArchive(app, file, info)
                if (_state.value is UpdateState.Installing) commit(app, file)
            } catch (e: Exception) {
                // Not ours (wrong package, signer or version): never keep it around for a retry.
                if (e is ArchiveException) file.delete()
                if (BuildConfig.DEBUG) Log.w("Wicaby", "update install", e)
                if (_state.value is UpdateState.Installing) _state.value = UpdateState.Failed(info, Core.str(R.string.update_install_failed))
            }
        }
    }

    private class ChecksumException : IOException()

    private suspend fun download(context: Context, info: UpdateInfo): File = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        val target = File(dir, "Wicaby-$channel-${info.versionCode}-${info.abi}.apk")
        dir.listFiles()?.filter { it != target }?.forEach { it.delete() }
        if (!UpdateLogic.isValidSha256(info.sha256)) throw ChecksumException()
        if (target.exists() && sha256(target) == info.sha256) return@withContext target
        val part = File(dir, target.name + ".part")
        val client = noDowngrade().newBuilder().readTimeout(60, TimeUnit.SECONDS).build()
        client.newCall(Request.Builder().url(info.url).build()).execute().use { res ->
            if (!res.isSuccessful) throw IOException("HTTP ${res.code}")
            val total = res.body.contentLength()
            val digest = MessageDigest.getInstance("SHA-256")
            var done = 0L
            var last = 0L
            res.body.byteStream().use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        if (_state.value !is UpdateState.Downloading) throw IOException("canceled")
                        out.write(buf, 0, n)
                        digest.update(buf, 0, n)
                        done += n
                        if (total > 0 && done - last > 256 * 1024) {
                            last = done
                            _state.value = UpdateState.Downloading(info, (done.toFloat() / total).coerceIn(0f, 1f))
                        }
                    }
                }
            }
            val hex = digest.digest().joinToString("") { "%02x".format(it) }
            if (!UpdateLogic.isValidSha256(info.sha256) || hex != info.sha256) {
                part.delete()
                throw ChecksumException()
            }
        }
        target.delete()
        part.renameTo(target)
        target
    }

    private fun sha256(f: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    // OkHttp follows https -> http redirects by default; the updater never does (release builds).
    private fun noDowngrade() = if (BuildConfig.DEBUG) Core.http else Core.http.newBuilder().followSslRedirects(false).build()

    private class ArchiveException : IOException()

    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo, lineage: Boolean): Set<String> {
        val certs = if (Build.VERSION.SDK_INT >= 28) {
            val s = info.signingInfo ?: return emptySet()
            when {
                s.hasMultipleSigners() -> s.apkContentsSigners
                lineage -> s.signingCertificateHistory
                else -> s.apkContentsSigners
            }
        } else {
            info.signatures
        }
        return certs.orEmpty().filterNotNull().map { sig ->
            MessageDigest.getInstance("SHA-256").digest(sig.toByteArray()).joinToString("") { "%02x".format(it) }
        }.toSet()
    }

    @Suppress("DEPRECATION")
    private fun code(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

    // The downloaded APK must be ours: package name, signing certificate, newer versionCode.
    private fun verifyArchive(context: Context, file: File, info: UpdateInfo) {
        val pm = context.packageManager
        @Suppress("DEPRECATION")
        // API 28 only collects an archive's certificates when GET_SIGNATURES is set (API 29 added
        // GET_SIGNING_CERTIFICATES to that check); without it signingInfo is null and every update fails.
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES else PackageManager.GET_SIGNATURES
        val archive = pm.getPackageArchiveInfo(file.absolutePath, flags) ?: throw ArchiveException()
        val installed = pm.getPackageInfo(context.packageName, flags)
        val ok = UpdateLogic.archiveAcceptable(
            packageName = context.packageName,
            archivePackage = archive.packageName,
            installedVersionCode = code(installed),
            archiveVersionCode = code(archive),
            expectedVersionCode = info.versionCode.toLong(),
            installedSigners = signers(installed, lineage = false),
            archiveSigners = signers(archive, lineage = true),
        )
        if (!ok) throw ArchiveException()
    }

    private fun commit(context: Context, file: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(file.length())
        }
        abandon(sessionId)
        val id = installer.createSession(params)
        sessionId = id
        try {
            installer.openSession(id).use { session ->
                session.openWrite("wicaby.apk", 0, file.length()).use { out ->
                    file.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                val intent = Intent(context, UpdateReceiver::class.java).setPackage(context.packageName)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                session.commit(PendingIntent.getBroadcast(context, id, intent, flags).intentSender)
            }
        } catch (e: Exception) {
            abandon(id)
            throw e
        }
    }

    // On the main thread (UpdateReceiver).
    internal fun onResult(context: Context, intent: Intent) {
        val id = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        // "Plus tard" since the commit (or a restarted process): this install is no longer wanted.
        if (_state.value !is UpdateState.Installing) {
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) abandon(id)
            return
        }
        val info = info()
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val c = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                when {
                    c == null -> fail(id, info)
                    resumed > 0 -> launchConfirm(context, c)
                    // In the background the start would be dropped: shown when the app comes back.
                    else -> confirm = c
                }
            }
            // Updating ourselves kills the process right after; nothing to show.
            PackageInstaller.STATUS_SUCCESS -> _state.value = UpdateState.Idle
            // The user said no on the system dialog: back to the offer.
            PackageInstaller.STATUS_FAILURE_ABORTED -> {
                abandon(id)
                _state.value = info?.let { UpdateState.Available(it) } ?: UpdateState.Idle
            }
            else -> {
                if (BuildConfig.DEBUG) Log.w("Wicaby", "install status $status ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
                fail(id, info)
            }
        }
    }

    private fun launchConfirm(context: Context, c: Intent) {
        try {
            context.startActivity(c.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
            fail(sessionId, info())
        }
    }

    private fun fail(id: Int, info: UpdateInfo?) {
        abandon(id)
        _state.value = UpdateState.Failed(info, Core.str(R.string.update_install_failed))
    }
}

// PackageInstaller session results (declared in :core's manifest, not exported).
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = Updater.onResult(context, intent)
}
