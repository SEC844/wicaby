package com.wika.wicaby.tv.ui.livetv

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.livetv.ChannelsLoad
import com.wika.wicaby.core.livetv.LiveTvRepository
import com.wika.wicaby.core.livetv.PrefField
import com.wika.wicaby.core.livetv.reconcileFavorites
import com.wika.wicaby.tv.R
import com.wika.wicaby.tv.ui.C
import com.wika.wicaby.tv.ui.OverlayHost
import com.wika.wicaby.tv.ui.Pill
import com.wika.wicaby.tv.ui.Radius
import com.wika.wicaby.tv.ui.SheetButton
import com.wika.wicaby.tv.ui.TvSheet
import com.wika.wicaby.tv.ui.Type
import com.wika.wicaby.tv.ui.tvFocus
import kotlinx.coroutines.delay

// "Gérer les chaînes" on TV (spec §3.1, §6.5, LT-07, LT-20, TV-4): favourites first, the favourite
// order (the zap order of the Favoris lens) with a D-pad pick-up reorder, and the hidden channels.
// Everything writes the synced DisplayPreferences document through LivePrefs. Client groups need
// text entry and stay on the desktop for now. PickupList is shared with the rule priorities.

fun showChannelManager(overlay: OverlayHost, api: Api, repo: LiveTvRepository) = overlay.show { ChannelManagerSheet(api, repo, onDismiss = overlay::close) }

@Composable
fun ChannelManagerSheet(api: Api, repo: LiveTvRepository, onDismiss: () -> Unit) {
    val channels by repo.channels.collectAsState()
    val prefs by repo.prefs.prefs.collectAsState()
    val load by repo.channelsLoad.collectAsState()
    val favorites = remember(channels, prefs.fav) { reconcileFavorites(channels, prefs.fav) }
    val hidden = remember(channels, prefs.hidden) { prefs.hidden.toHashSet().let { h -> channels.filter { it.id in h } } }
    // Refused while favourites or the prefs document did not load (§6.5): a reorder must not become an empty overwrite.
    val editable = repo.prefs.canEditFavorites(load == ChannelsLoad.READY)
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        delay(60)
        runCatching { first.requestFocus() }
    }

    TvSheet(onDismiss, width = 640.dp) {
        Text(stringResource(R.string.livetv_manage_title), style = Type.title2, color = C.label)
        Text(stringResource(R.string.livetv_manage_synced, api.server.name), style = Type.footnote, color = C.label3, modifier = Modifier.padding(top = 4.dp, bottom = 16.dp))
        Column(Modifier.heightIn(max = 340.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SheetButton(
                stringResource(com.wika.wicaby.core.R.string.livetv_sort_favorites_first), centered = false, checked = prefs.favFirst,
                onClick = { repo.prefs.update(PrefField.FAV_FIRST, repo.prefs.prefs.value.copy(favFirst = !prefs.favFirst)) },
                modifier = Modifier.focusRequester(first),
            )
            Section(stringResource(R.string.livetv_manage_reorder_favorites))
            if (favorites.isEmpty()) {
                Text(stringResource(com.wika.wicaby.core.R.string.livetv_lens_empty_favorites), style = Type.footnote, color = C.label3)
            } else {
                Text(stringResource(R.string.livetv_manage_reorder_hint), style = Type.footnote, color = C.label3, modifier = Modifier.padding(bottom = 4.dp))
                PickupList(
                    favorites, key = { it.id }, enabled = editable,
                    onMove = { from, to ->
                        val order = favorites.map { it.id }.toMutableList()
                        order.add(to, order.removeAt(from))
                        repo.prefs.update(PrefField.FAV, repo.prefs.prefs.value.copy(fav = order))
                    },
                ) { r, picked, focused ->
                    val fg = if (picked) C.bg else C.label
                    Text(r.number, style = Type.mono, color = pickFg(picked, focused), maxLines = 1, modifier = Modifier.width(56.dp))
                    Text(r.name, style = Type.headline, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                }
            }
            Section(stringResource(R.string.livetv_manage_hidden))
            Text(
                pluralStringResource(R.plurals.livetv_manage_hidden_count, hidden.size, hidden.size) + " · " + stringResource(R.string.livetv_manage_hidden_hint),
                style = Type.footnote, color = C.label3, modifier = Modifier.padding(bottom = 4.dp),
            )
            for (r in hidden) {
                key(r.id) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(r.number, style = Type.mono, color = C.label2, maxLines = 1, modifier = Modifier.width(56.dp))
                        Text(r.name, style = Type.headline, color = C.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        Pill(stringResource(R.string.livetv_channel_unhide), onClick = {
                            // The row goes away: focus moves to a row that stays first.
                            runCatching { first.requestFocus() }
                            val p = repo.prefs.prefs.value
                            repo.prefs.update(PrefField.HIDDEN, p.copy(hidden = p.hidden - r.id))
                        })
                    }
                }
            }
        }
    }
}

@Composable
internal fun Section(title: String) =
    Text(title, style = Type.title3, color = C.label, modifier = Modifier.padding(top = 14.dp, bottom = 2.dp))

/**
 * A D-pad pick-up list (spec §9.4, TV-4): OK picks the focused row up (inverted), ↑/↓ move it, OK or
 * Back drops it. Every move calls [onMove] at once. TalkBack gets "Monter" / "Descendre" custom
 * actions and a "moving" state, since a pick-up cannot be discovered otherwise (§21.7).
 */
@Composable
internal fun <T> PickupList(
    items: List<T>,
    key: (T) -> String,
    onMove: (from: Int, to: Int) -> Unit,
    enabled: Boolean = true,
    onDrop: () -> Unit = {},
    row: @Composable RowScope.(T, picked: Boolean, focused: Boolean) -> Unit,
) {
    var picked by remember { mutableStateOf<String?>(null) }
    val up = stringResource(R.string.livetv_manage_move_up)
    val down = stringResource(R.string.livetv_manage_move_down)
    val moving = stringResource(R.string.livetv_manage_moving)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        items.forEachIndexed { i, item ->
            val k = key(item)
            key(k) {
                var focused by remember { mutableStateOf(false) }
                val isPicked = picked == k
                val requester = remember { FocusRequester() }
                // The moved row keeps focus at its new place.
                LaunchedEffect(i, isPicked) { if (isPicked) runCatching { requester.requestFocus() } }
                fun drop() {
                    picked = null
                    onDrop()
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .focusRequester(requester)
                        .onPreviewKeyEvent { e ->
                            if (!isPicked) return@onPreviewKeyEvent false
                            when (e.key) {
                                Key.DirectionUp, Key.DirectionDown -> {
                                    val to = i + if (e.key == Key.DirectionUp) -1 else 1
                                    if (e.type == KeyEventType.KeyDown && to in items.indices) onMove(i, to)
                                    true
                                }
                                Key.DirectionLeft, Key.DirectionRight -> true // focus stays on the lifted row
                                Key.Back, Key.Escape -> {
                                    if (e.type == KeyEventType.KeyUp) drop()
                                    true
                                }
                                else -> false
                            }
                        }
                        .tvFocus(
                            RoundedCornerShape(Radius.sm), focusedScale = 1f, sheen = false, elevation = 0.dp,
                            onFocusChange = { focused = it },
                            onClick = { if (isPicked) drop() else if (enabled) picked = k },
                        )
                        .background(
                            when {
                                isPicked -> C.label
                                focused -> C.fill4
                                else -> C.fill1
                            },
                        )
                        .semantics {
                            if (isPicked) stateDescription = moving
                            if (enabled) {
                                customActions = listOfNotNull(
                                    CustomAccessibilityAction(up) { onMove(i, i - 1); onDrop(); true }.takeIf { i > 0 },
                                    CustomAccessibilityAction(down) { onMove(i, i + 1); onDrop(); true }.takeIf { i < items.lastIndex },
                                )
                            }
                        }
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) { row(item, isPicked, focused) }
            }
        }
    }
}

/** The text colour on a pick-up row. */
internal fun pickFg(picked: Boolean, focused: Boolean): Color = if (picked) C.bg else if (focused) C.label else C.label2
