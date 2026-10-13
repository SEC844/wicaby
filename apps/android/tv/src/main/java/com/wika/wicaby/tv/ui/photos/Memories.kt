package com.wika.wicaby.tv.ui.photos

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import com.wika.wicaby.core.R as CoreR
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.livetv.DeviceClassDetector
import com.wika.wicaby.core.livetv.FormFactor
import com.wika.wicaby.core.photos.Photo
import com.wika.wicaby.core.photos.PhotoSizes
import com.wika.wicaby.core.photos.TimelineState
import com.wika.wicaby.core.photos.photoDate
import com.wika.wicaby.core.photos.photoImage
import com.wika.wicaby.core.photos.quarterTurn
import com.wika.wicaby.tv.Route
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.Cache
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.dpPx
import com.wika.wicaby.tv.ui.tvFocus
import com.wika.wicaby.tv.ui.uiLocale

// "Ce jour-là" on the TV home (photos spec F7, PH-08): one card per earlier year. OK opens that year's photos in the
// viewer (Play/Pause there starts the slideshow).

// The card's cover: a photo the server shows upright (a quarter-turned one needs the decoded-size test first).
fun memoryCover(photos: List<Photo>): Photo = photos.firstOrNull { quarterTurn(it.item.imageOrientation) == 0 } ?: photos.first()

// The viewer route over one year's photos (PhotoViewerScreen reads the timeline from Cache).
fun memoryRoute(years: Int, photos: List<Photo>): Route {
    val key = "memories-view-$years"
    Cache.map[key] = TimelineState().apply {
        this.photos = photos
        total = photos.size
    }
    return Route.PhotoView(key, 0, null)
}

@Composable
fun MemoryCard(api: Api, years: Int, photos: List<Photo>, focusModifier: Modifier, onFocus: () -> Unit, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val cover = remember(photos) { memoryCover(photos) }
    // tv-low: the cover within the tile budget too (240 px).
    val context = LocalContext.current
    val w = PhotoSizes.tvTile(remember { DeviceClassDetector.detect(context, FormFactor.TV) }, dpPx(232.dp))
    Column(Modifier.width(232.dp)) {
        Box(
            Modifier.fillMaxWidth().aspectRatio(16f / 9f).then(focusModifier)
                .tvFocus(RoundedCornerShape(Radius.md), focusedScale = 1.06f, onFocusChange = { focused = it; if (it) onFocus() }, onClick = onClick)
                .background(C.elevated2),
        ) {
            val url = remember(cover.asset.id, w) { api.photoImage(cover.asset, maxWidth = w) }
            AsyncImage(url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
        Text(pluralStringResource(CoreR.plurals.photos_memories_years_ago, years, years), style = Type.callout, color = if (focused) C.label else C.label2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 12.dp, start = 2.dp))
        Text(
            photoDate(cover.asset.takenAt, uiLocale()) + " · " + pluralStringResource(CoreR.plurals.photos_count, photos.size, photos.size),
            style = Type.footnote, color = C.label3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp, start = 2.dp),
        )
    }
}
