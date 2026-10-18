package com.wika.wicaby.core.data

import java.io.File

// Item ids and file extensions that come from the server or from an intent end up in file
// names and player intents; only plain names get through (no "../", no separators).
object SafeNames {
    private val ID = Regex("^[A-Za-z0-9_-]{1,64}$")
    private val EXT = Regex("^[a-z0-9]{1,8}$")

    fun isValidId(id: String?): Boolean = id != null && ID.matches(id)

    // The container's first entry ("mkv,webm" -> "mkv"), else "mkv".
    fun extension(container: String?): String =
        container?.substringBefore(',')?.trim()?.lowercase()?.takeIf { EXT.matches(it) } ?: "mkv"

    // True when [file] resolves (symlinks and "..") to a path inside [dir].
    fun isInside(dir: File, file: File): Boolean = runCatching {
        val base = dir.canonicalPath
        val path = file.canonicalPath
        path.startsWith(base + File.separator)
    }.getOrDefault(false)
}
