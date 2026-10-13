package com.wika.wicaby.mobile.music

import android.app.Application
import androidx.media3.common.MediaMetadata
import com.wika.wicaby.core.data.Item
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Music spec MU-12: Android Auto's browse tree on a fake library (no server): the root has the 4 sections, folders
// browse, tracks are playable leaves with their metadata, a picked track resolves to its list and index, and only
// Android Auto in the gplay flavour may browse.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class AutoBrowseTreeTest {
    private val album = Item("al1", name = "Marée basse", type = "MusicAlbum")
    private val tracks = listOf(
        Item("t1", name = "Écume", type = "Audio", album = "Marée basse", artists = listOf("Les Ondes Calmes")),
        Item("t2", name = "Phare", type = "Audio", album = "Marée basse", artists = listOf("Les Ondes Calmes")),
    )
    private val asked = mutableListOf<String>()
    private val tree = AutoBrowseTree({ "[$it]" }, { node ->
        asked += node
        when (node) {
            AutoBrowseTree.ALBUMS -> listOf(album, Item("x", name = "Not music", type = "Movie"))
            AutoBrowseTree.ARTISTS -> listOf(Item("ar1", name = "Les Ondes Calmes", type = "MusicArtist"))
            AutoBrowseTree.PLAYLISTS -> listOf(Item("p1", name = "Route", type = "Playlist"))
            AutoBrowseTree.RECENT, "album/al1" -> tracks
            "artist/ar1" -> listOf(album)
            else -> emptyList()
        }
    })

    @Test
    fun rootHasFourBrowsableSections() = runBlocking {
        assertEquals("root", tree.root().mediaId)
        assertEquals(true, tree.root().mediaMetadata.isBrowsable)
        val top = tree.children(AutoBrowseTree.ROOT)
        assertEquals(listOf("recent", "playlists", "albums", "artists"), top.map { it.mediaId })
        assertEquals(listOf("[recent]", "[playlists]", "[albums]", "[artists]"), top.map { it.mediaMetadata.title.toString() })
        assertTrue(top.all { it.mediaMetadata.isBrowsable == true && it.mediaMetadata.isPlayable == false })
        assertTrue(asked.isEmpty())
    }

    @Test
    fun foldersBrowseAndTracksArePlayableLeaves() = runBlocking {
        val albums = tree.children(AutoBrowseTree.ALBUMS)
        assertEquals(listOf("album/al1"), albums.map { it.mediaId })
        assertEquals(MediaMetadata.MEDIA_TYPE_ALBUM, albums[0].mediaMetadata.mediaType)
        assertEquals("playlist/p1", tree.children(AutoBrowseTree.PLAYLISTS).single().mediaId)
        assertEquals("artist/ar1", tree.children(AutoBrowseTree.ARTISTS).single().mediaId)
        assertEquals("album/al1", tree.children("artist/ar1").single().mediaId)
        val leaves = tree.children("album/al1")
        assertEquals(listOf("album/al1|t1", "album/al1|t2"), leaves.map { it.mediaId })
        val m = leaves[0].mediaMetadata
        assertEquals(true, m.isPlayable)
        assertEquals(false, m.isBrowsable)
        assertEquals("Écume", m.title.toString())
        assertEquals("Les Ondes Calmes", m.artist.toString())
        assertEquals("Marée basse", m.albumTitle.toString())
        assertEquals(MediaMetadata.MEDIA_TYPE_MUSIC, m.mediaType)
        assertTrue(tree.children("nonsense").isEmpty())
    }

    @Test
    fun aPickedTrackPlaysItsListFromThere() = runBlocking {
        val (list, i) = tree.queueFor("album/al1|t2")!!
        assertEquals(listOf("t1", "t2"), list.map { it.id })
        assertEquals(1, i)
        assertEquals(0, tree.queueFor("recent|t1")!!.second)
        assertNull(tree.queueFor("album/al1|gone"))
        assertNull(tree.queueFor("albums"))
    }

    @Test
    fun onlyAndroidAutoInGplayMayBrowse() {
        assertTrue(AutoBrowseTree.allowed("com.google.android.projection.gearhead", "gplay"))
        assertFalse(AutoBrowseTree.allowed("com.google.android.projection.gearhead", "foss"))
        assertFalse(AutoBrowseTree.allowed("com.example.other", "gplay"))
        assertFalse(AutoBrowseTree.allowed("com.wika.wicaby.mobile", "gplay"))
    }
}
