package com.wika.wicaby.core.files

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.R
import com.wika.wicaby.core.files.pure.Urls
import java.text.DateFormat
import java.util.Date

// The user-facing text of a file-source failure (spec §8).
fun FileError.text(): String = Core.str(
    when (kind) {
        FileError.Kind.AUTH -> R.string.files_error_auth
        FileError.Kind.NOT_FOUND -> R.string.files_error_not_found
        FileError.Kind.CERT_UNTRUSTED -> R.string.files_error_cert_untrusted
        FileError.Kind.CERT_CHANGED -> R.string.files_error_cert_changed
        FileError.Kind.DIGEST_ONLY -> R.string.files_error_digest_only
        FileError.Kind.SMB1 -> R.string.files_error_smb1
        FileError.Kind.OFFLINE -> R.string.files_error_offline
        FileError.Kind.UNAVAILABLE -> R.string.files_error_unavailable
        FileError.Kind.TOO_LARGE -> R.string.files_error_too_large
        FileError.Kind.OTHER -> return Core.str(R.string.files_error_other, message.orEmpty())
    },
)

// A photo source's scan status (Réglages > Sources de photos): "Indexing N photos…", or the count and the last scan.
fun PhotoIndex.Status.text(): String = when {
    scanning -> Core.plural(R.plurals.photos_sources_indexing, count, count)
    error != null -> errorText(error)
    scannedAt == 0L -> Core.str(R.string.photos_sources_not_scanned)
    else -> Core.plural(R.plurals.photos_sources_indexed, count, count, DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, Core.locale).format(Date(scannedAt)))
}

fun errorText(e: Throwable?): String = (e as? FileError)?.text() ?: (e?.cause as? FileError)?.text() ?: Core.str(R.string.files_error_offline)

// The lines of the "Trust this certificate for this source only" prompt (§7.3).
fun TlsPin.CertInfo.lines(): String = listOf(
    Core.str(R.string.files_tls_subject, subject),
    Core.str(R.string.files_tls_issuer, issuer),
    Core.str(R.string.files_tls_valid, DateFormat.getDateInstance(DateFormat.MEDIUM, Core.locale).format(Date(notAfter))),
    Core.str(R.string.files_tls_fingerprint, fingerprint),
).joinToString("\n")

// Both apps' Add sheet (§6.1): the form, Test, the certificate prompt and Save. Nothing connects before Test.
class FileSourceDraft(protocol: String = FileSource.WEBDAV, private val photos: Boolean = false) {
    var protocol by mutableStateOf(protocol)
    var url by mutableStateOf("")
    var user by mutableStateOf("")
    var pass by mutableStateOf("")
    var domain by mutableStateOf("")
    var name by mutableStateOf("")
    // A plain http:// address saves only once the user acknowledged it (§7.3 insecure-http).
    var insecureAck by mutableStateOf(false)
    var busy by mutableStateOf(false)
    var status by mutableStateOf<String?>(null)
    var tested by mutableStateOf(false)
    // An untrusted certificate waiting for the user's decision (Cancel is the default).
    var cert by mutableStateOf<TlsPin.CertInfo?>(null)
    private var pin: TlsPolicy? = null
    private val id = FileSource.newId()

    // What the address field holds, normalised; user:pass@ moved to the fields once.
    private fun parsed() = Urls.parse(if (protocol == FileSource.WEBDAV && !url.trim().contains("://")) "https://" + url.trim() else url)?.takeIf {
        (protocol == FileSource.WEBDAV) == (it.protocol == "webdav")
    }

    val insecure get() = parsed()?.url?.startsWith("http://") == true

    val valid get() = parsed() != null && (!insecure || insecureAck)

    // user:pass@ in the address moves to the fields, and the address field keeps the URL without it (§6.1: stripped
    // before anything is stored or shown).
    internal fun absorbUserInfo(): com.wika.wicaby.core.files.pure.ParsedSource? {
        val p = parsed() ?: return null
        if (p.user == null && p.pass == null) return p
        if (p.user != null && user.isEmpty()) user = p.user
        if (p.pass != null && pass.isEmpty()) pass = p.pass
        url = p.url
        return p
    }

    private fun source(): FileSource? {
        val p = absorbUserInfo() ?: return null
        val tls = when {
            protocol != FileSource.WEBDAV -> null
            p.url.startsWith("http://") -> TlsPolicy(TlsPolicy.INSECURE_HTTP)
            else -> pin ?: TlsPolicy(TlsPolicy.VERIFY)
        }
        return FileSource(id, name.trim().ifEmpty { Urls.defaultName(p.url) }, protocol, p.url, tls, addedAt = System.currentTimeMillis(), photos = photos)
    }

    private fun creds() = if (user.isEmpty() && pass.isEmpty()) null else FileCredentials(user, pass, domain.trim().ifEmpty { null })

    // One listing of the root (PROPFIND Depth 0 would do; the root's entries also give the count shown).
    suspend fun test(): Boolean {
        val s = source() ?: run { status = Core.str(R.string.files_add_invalid_url); return false }
        if (insecure && !insecureAck) return false
        busy = true
        status = Core.str(R.string.files_add_testing)
        return try {
            val n = FileSources.test(s, creds())
            status = Core.plural(R.plurals.files_add_ok, n, n)
            tested = true
            true
        } catch (e: FileError) {
            tested = false
            status = e.text()
            if (e.kind == FileError.Kind.CERT_UNTRUSTED && e.cert != null) cert = e.cert
            false
        } catch (e: Exception) {
            tested = false
            status = errorText(e)
            false
        } finally {
            busy = false
        }
    }

    // The user trusted the certificate shown: this source only, by its SHA-256.
    suspend fun trust(): Boolean {
        val c = cert ?: return false
        pin = TlsPolicy(TlsPolicy.PIN, c.sha256, c.subject, c.notAfter.toString())
        cert = null
        return test()
    }

    // Saved only after a Test that passed.
    suspend fun save(): Boolean {
        if (!tested && !test()) return false
        val s = source() ?: return false
        FileSources.add(s, creds())
        return true
    }
}

// §7.1 "sign in again": new credentials for a source that is kept (its progress with it), tested before they
// replace the stored ones.
class SignInDraft(val source: FileSource) {
    var user by mutableStateOf("")
    var pass by mutableStateOf("")
    var domain by mutableStateOf("")
    var busy by mutableStateOf(false)
    var status by mutableStateOf<String?>(null)

    suspend fun save(): Boolean {
        val creds = FileCredentials(user.trim(), pass, domain.trim().ifEmpty { null })
        busy = true
        status = Core.str(R.string.files_add_testing)
        return try {
            FileSources.test(source, creds)
            FileSources.setCredentials(source.id, creds)
            true
        } catch (e: Exception) {
            status = errorText(e)
            false
        } finally {
            busy = false
        }
    }
}

object LocalFolders {
    // TV boxes often have no documents UI (spec R5): the choice is offered only when the picker resolves.
    fun available(context: Context): Boolean =
        Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).resolveActivity(context.packageManager) != null

    // A folder the picker returned (D11): its read permission is kept across restarts, and it becomes a source.
    fun add(context: Context, tree: Uri, photos: Boolean = false) {
        context.contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val doc = runCatching { DocumentsContract.getTreeDocumentId(tree) }.getOrNull().orEmpty()
        val name = doc.substringAfterLast(':').substringAfterLast('/').ifEmpty { doc }.ifEmpty { "Local" }
        FileSources.add(FileSource(FileSource.newId(), name, FileSource.LOCAL, tree.toString(), addedAt = System.currentTimeMillis(), photos = photos), null)
    }
}
