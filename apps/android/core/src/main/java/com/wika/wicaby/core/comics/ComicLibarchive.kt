package com.wika.wicaby.core.comics

import me.zhanghai.android.libarchive.Archive
import me.zhanghai.android.libarchive.ArchiveEntry
import me.zhanghai.android.libarchive.ArchiveException
import java.io.File
import java.io.InputStream
import java.nio.ByteBuffer

// RAR (4 and 5), 7z and tar comics through libarchive (BSD-2), packaged by libarchive-android (Apache-2.0).
// No UnRAR code: libarchive's RAR readers are its own BSD code, so the GPL build stays clean. libarchive reads
// the file itself, in order (the only way for RAR and solid 7z), so nothing sits in memory.
internal object ComicLibarchive {
    // Opens [file] for [format] only (a smaller attack surface than every format libarchive knows) and hands
    // [body] the entries; each entry's stream is valid until the next one is asked for.
    fun <T> entries(file: File, format: ComicFormat, body: (Iterator<ComicFormats.Entry>) -> T): T {
        val a = Archive.readNew()
        try {
            // Names stay as stored (UTF-8 for RAR5 and 7z); no locale conversion on Android.
            Archive.setCharset(a, "UTF-8".toByteArray())
            Archive.readSupportFilterAll(a)
            when (format) {
                ComicFormat.RAR -> {
                    Archive.readSupportFormatRar(a)
                    Archive.readSupportFormatRar5(a)
                }
                ComicFormat.SEVEN_Z -> Archive.readSupportFormat7zip(a)
                ComicFormat.TAR -> Archive.readSupportFormatTar(a)
                else -> throw IllegalArgumentException(format.name)
            }
            Archive.readOpenFileName(a, file.path.toByteArray(), 64 * 1024)
            val it = iterator {
                var seen = false
                while (true) {
                    val e = try {
                        Archive.readNextHeader(a)
                    } catch (x: ArchiveException) {
                        // libarchive 3.8 stops at an encrypted RAR entry's header instead of listing it.
                        if (Archive.readHasEncryptedEntries(a) > 0) throw ComicRefused(ComicRefused.Reason.ENCRYPTED)
                        throw x
                    }
                    if (e == 0L) break
                    seen = true
                    val name = ArchiveEntry.pathnameUtf8(e) ?: ArchiveEntry.pathname(e)?.toString(Charsets.ISO_8859_1).orEmpty()
                    val isFile = ArchiveEntry.filetype(e) and ArchiveEntry.AE_IFMT == ArchiveEntry.AE_IFREG
                    val size = if (ArchiveEntry.sizeIsSet(e)) ArchiveEntry.size(e) else -1L
                    yield(ComicFormats.Entry(name, isFile, size, ArchiveEntry.isEncrypted(e), Data(a)))
                }
                // RAR5 with encrypted headers lists nothing at all.
                if (!seen && Archive.readHasEncryptedEntries(a) > 0) throw ComicRefused(ComicRefused.Reason.ENCRYPTED)
            }
            return body(it)
        } finally {
            Archive.free(a)
        }
    }

    // The current entry's bytes.
    private class Data(private val a: Long) : InputStream() {
        override fun read(): Int {
            val b = ByteArray(1)
            return if (read(b, 0, 1) < 0) -1 else b[0].toInt() and 0xff
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            val buf = ByteBuffer.wrap(b, off, len)
            try {
                Archive.readData(a, buf)
            } catch (e: ArchiveException) {
                if (e.message.orEmpty().contains(Regex("encrypt|passphrase", RegexOption.IGNORE_CASE))) throw ComicRefused(ComicRefused.Reason.ENCRYPTED)
                throw e
            }
            val n = buf.position() - off
            return if (n == 0) -1 else n
        }
    }
}
