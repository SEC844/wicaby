package com.wika.wicaby.mobile.ui

import android.app.Application
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.navigation.compose.rememberNavController
import com.wika.wicaby.core.files.FileBackend
import com.wika.wicaby.core.files.FileEntry
import com.wika.wicaby.core.files.FileError
import com.wika.wicaby.core.files.FileProgress
import com.wika.wicaby.core.files.FileSource
import com.wika.wicaby.core.files.FilesApi
import com.wika.wicaby.core.files.pure.Ids
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

// FS-10: the item page of a file (a file source seen as a server) shows no cast, download or heart: caps castSend and
// favorites are false (§2.2), and those calls would only fail with FILES-UNMAPPED. Played stays (local user data).
@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "en")
class FilesDetailTest {
    @get:Rule
    val rule = createComposeRule()

    // One film at the root of an in-memory source: nothing is contacted.
    private class OneFilm : FileBackend {
        override suspend fun list(rel: String) =
            if (rel.isEmpty()) listOf(FileEntry("Example.Movie.2019.1080p.mkv", false, 1_000, 1_700_000_000_000)) else throw FileError(FileError.Kind.NOT_FOUND)

        override fun uri(rel: String, entry: FileEntry?) = "mem://$rel"

        override suspend fun read(rel: String, entry: FileEntry?, maxBytes: Int): ByteArray = throw FileError(FileError.Kind.NOT_FOUND)
    }

    @Test
    fun aFileItemPageHasNoCastDownloadOrHeart() {
        val dir = kotlin.io.path.createTempDirectory("wicaby-files-ui").toFile()
        val source = FileSource("0123456789abcdef0123456789abcdef", "Media", FileSource.WEBDAV, "https://dav.example/media")
        val api = FilesApi(source, OneFilm(), FileProgress(File(dir, "progress.json")), "dev")
        rule.setContent {
            WicabyTheme(Accents[0]) { DetailScreen(api, Ids.encode("Example.Movie.2019.1080p.mkv")!!, rememberNavController()) }
        }
        rule.waitUntilAtLeastOneExists(hasText("Watched"), 5_000)
        rule.onAllNodesWithText("Example Movie")[0].assertExists()
        for (label in listOf("Cast", "Download", "Favorite")) rule.onNodeWithText(label).assertDoesNotExist()
    }
}
