package com.wika.wicaby.core.data

import com.wika.wicaby.core.comics.ComicCovers

// Artwork URLs, with the fallbacks Emby web uses (series art for episodes, parent backdrops).

fun Api.poster(item: Item, maxHeight: Int): String? {
    item.imageTags["Primary"]?.let { return image(item.id, "Primary", it, maxHeight = maxHeight) }
    if (item.seriesId != null && item.seriesPrimaryImageTag != null) return image(item.seriesId, "Primary", item.seriesPrimaryImageTag, maxHeight = maxHeight)
    // A track without art of its own: its album's.
    if (item.albumId != null && item.albumPrimaryImageTag != null) return image(item.albumId, "Primary", item.albumPrimaryImageTag, maxHeight = maxHeight)
    return null
}

// Cards and detail pages: the poster, or for a comic without one its first page (ComicCoverFetcher).
fun Api.posterArt(item: Item, maxHeight: Int): Any? = poster(item, maxHeight) ?: ComicCovers.of(this, item)

fun Api.thumb(item: Item, maxWidth: Int): String? {
    if (item.isEpisode) item.imageTags["Primary"]?.let { return image(item.id, "Primary", it, maxWidth = maxWidth) }
    item.imageTags["Thumb"]?.let { return image(item.id, "Thumb", it, maxWidth = maxWidth) }
    if (item.parentThumbItemId != null && item.parentThumbImageTag != null) return image(item.parentThumbItemId, "Thumb", item.parentThumbImageTag, maxWidth = maxWidth)
    return backdrop(item, maxWidth)
}

fun Api.backdrop(item: Item, maxWidth: Int = 1920): String? {
    item.backdropImageTags.firstOrNull()?.let { return image(item.id, "Backdrop", it, maxWidth = maxWidth) }
    if (item.parentBackdropItemId != null) item.parentBackdropImageTags.firstOrNull()?.let { return image(item.parentBackdropItemId, "Backdrop", it, maxWidth = maxWidth) }
    return null
}

fun Api.logo(item: Item, maxWidth: Int = 800): String? {
    item.imageTags["Logo"]?.let { return image(item.id, "Logo", it, maxWidth = maxWidth) }
    if (item.parentLogoItemId != null && item.parentLogoImageTag != null) return image(item.parentLogoItemId, "Logo", item.parentLogoImageTag, maxWidth = maxWidth)
    return null
}
