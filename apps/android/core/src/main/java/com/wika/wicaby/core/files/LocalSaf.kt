package com.wika.wicaby.core.files

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import com.wika.wicaby.core.files.pure.Ids
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap

// A folder the user picked with the system picker (ACTION_OPEN_DOCUMENT_TREE, spec D11): the persisted tree URI is the
// source's url. Paths are walked name by name from the tree's root document; the provider enforces the tree, and a
// child whose document id does not start with the tree's own is refused (§7.4).
class LocalSaf(private val context: Context, source: FileSource) : FileBackend {
    private val tree = Uri.parse(source.url)
    private val rootDoc = DocumentsContract.getTreeDocumentId(tree)
    private val docs = ConcurrentHashMap<String, String>().apply { put("", rootDoc) }

    private suspend fun docId(rel: String): String {
        docs[rel]?.let { return it }
        val parent = Ids.parent(rel) ?: return rootDoc
        list(parent)
        return docs[rel] ?: throw FileError(FileError.Kind.NOT_FOUND)
    }

    override suspend fun list(rel: String): List<FileEntry> {
        val parent = docId(rel)
        return withContext(Dispatchers.IO) {
            val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
            val cols = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED)
            val out = ArrayList<FileEntry>()
            val cursor = try {
                context.contentResolver.query(uri, cols, null, null, null)
            } catch (e: SecurityException) {
                // The permission was released or the folder is gone (an unplugged card): offline, never dropped.
                throw FileError(FileError.Kind.OFFLINE, cause = e)
            } ?: throw FileError(FileError.Kind.OFFLINE)
            cursor.use { c ->
                while (c.moveToNext()) {
                    val id = c.getString(0) ?: continue
                    val name = c.getString(1) ?: continue
                    if (!id.startsWith(rootDoc) || !Ids.segmentOk(name)) continue
                    val childRel = Ids.child(rel, name) ?: continue
                    docs[childRel] = id
                    out += FileEntry(
                        name, c.getString(2) == Document.MIME_TYPE_DIR, if (c.isNull(3)) 0 else c.getLong(3), if (c.isNull(4)) 0 else c.getLong(4),
                        DocumentsContract.buildDocumentUriUsingTree(tree, id).toString(),
                    )
                }
            }
            out
        }
    }

    override fun uri(rel: String, entry: FileEntry?): String =
        entry?.uri ?: DocumentsContract.buildDocumentUriUsingTree(tree, docs[rel] ?: throw FileError(FileError.Kind.NOT_FOUND)).toString()

    override suspend fun read(rel: String, entry: FileEntry?, maxBytes: Int): ByteArray = withContext(Dispatchers.IO) {
        val u = Uri.parse(entry?.uri ?: uri(rel, null))
        (context.contentResolver.openInputStream(u) ?: throw FileError(FileError.Kind.NOT_FOUND)).use { s ->
            val buf = java.io.ByteArrayOutputStream()
            val chunk = ByteArray(16 * 1024)
            while (buf.size() < maxBytes) {
                val n = s.read(chunk, 0, minOf(chunk.size, maxBytes - buf.size()))
                if (n < 0) break
                buf.write(chunk, 0, n)
            }
            buf.toByteArray()
        }
    }

    override suspend fun <T> open(rel: String, entry: FileEntry?, maxBytes: Int, use: (java.io.InputStream) -> T): T = withContext(Dispatchers.IO) {
        (context.contentResolver.openInputStream(Uri.parse(entry?.uri ?: uri(rel, null))) ?: throw FileError(FileError.Kind.NOT_FOUND)).use(use)
    }
}
