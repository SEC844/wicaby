package com.wika.wicaby.mobile.ui.photos

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.photos.Photo
import com.wika.wicaby.core.photos.photoDate
import com.wika.wicaby.core.photos.photoImage
import com.wika.wicaby.core.photos.quarterTurn
import com.wika.wicaby.mobile.ui.G
import com.wika.wicaby.mobile.ui.Radius
import com.wika.wicaby.mobile.ui.SectionTitle
import com.wika.wicaby.mobile.ui.Type
import com.wika.wicaby.mobile.ui.dpPx
import com.wika.wicaby.mobile.ui.pressScale
import com.wika.wicaby.mobile.ui.uiLocale

// "Ce jour-là" on the mobile home (photos spec F7, PH-08): one card per earlier year, nearest first. A tap opens that
// year's photos in the viewer (its slideshow button plays them as a story).
@Composable
fun MemoriesRow(api: Api, groups: List<Pair<Int, List<Photo>>>) {
    var open by remember { mutableStateOf<List<Photo>?>(null) }
    val width = 264.dp
    val px = dpPx(width)
    Column(Modifier.fillMaxWidth().padding(top = 22.dp).testTag("memories")) {
        SectionTitle(stringResource(CoreR.string.photos_memories_title))
        LazyRow(contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            items(groups, key = { it.first }) { (years, photos) ->
                val source = remember { MutableInteractionSource() }
                // A cover the server shows upright: a quarter-turned photo needs the decoded-size test first.
                val cover = remember(photos) { photos.firstOrNull { quarterTurn(it.item.imageOrientation) == 0 } ?: photos.first() }
                val url = remember(cover.asset.id, px) { api.photoImage(cover.asset, maxWidth = px) }
                Column(Modifier.width(width).pressScale(source).clickable(source, null, role = Role.Button) { open = photos }) {
                    Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(Radius.md)).background(G.elevated2)) {
                        AsyncImage(url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    }
                    Text(pluralStringResource(CoreR.plurals.photos_memories_years_ago, years, years), style = Type.callout, color = G.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp, start = 2.dp))
                    Text(
                        photoDate(cover.asset.takenAt, uiLocale()) + " · " + pluralStringResource(CoreR.plurals.photos_count, photos.size, photos.size),
                        style = Type.footnote, color = G.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 2.dp),
                    )
                }
            }
        }
    }
    open?.let { PhotoViewerDialog(api, it, 0, onClose = { open = null }) }
}
