package com.wika.wicaby.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import com.wika.wicaby.core.VoiceSearch
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.data.Item
import com.wika.wicaby.core.data.Servers
import com.wika.wicaby.mobile.R
import kotlinx.coroutines.delay

@Composable
fun SearchScreen(api: Api, nav: NavController) {
    var query by rememberSaveable { mutableStateOf("") }
    val keyboard = LocalSoftwareKeyboardController.current
    val q = query.trim()
    // Voice search: the system speech recognizer fills the field; no mic without one.
    val context = LocalContext.current
    val voice = remember { VoiceSearch.available(context) }
    val listen = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        VoiceSearch.result(r.data)?.let { query = it }
    }
    val prompt = stringResource(com.wika.wicaby.core.R.string.voice_search_prompt)
    val locale = LocalConfiguration.current.locales[0]
    val results by produceState<List<Item>?>(null, q) {
        if (q.length < 2) {
            value = null
            return@produceState
        }
        // Debounce typing.
        delay(300)
        value = runCatching {
            Servers.merged(api) { it.items("SearchTerm" to q, "IncludeItemTypes" to "Movie,Series,Episode", "Recursive" to true, "Limit" to 60).items }
        }.getOrDefault(emptyList())
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
        LargeTitle(stringResource(R.string.tab_search))
        WicabyField(
            query, { query = it }, stringResource(R.string.search_hint), leading = Ic.Search, imeAction = ImeAction.Search,
            onSubmit = { keyboard?.hide() },
            // Always present: adding the trailing slot on the first letter rebuilt the field and sent
            // the cursor back to the start.
            trailing = {
                if (query.isNotEmpty()) IconButton({ query = "" }) { Icon(Ic.Close, stringResource(R.string.clear), tint = G.label2, modifier = Modifier.size(18.dp)) }
                else if (voice) IconButton({ runCatching { listen.launch(VoiceSearch.intent(prompt, locale)) } }) {
                    Icon(Ic.Mic, stringResource(com.wika.wicaby.core.R.string.voice_search), tint = G.label2, modifier = Modifier.size(20.dp))
                }
            },
        )
        val list = results
        when {
            list == null -> Centered(Modifier.imePadding()) { Text(stringResource(R.string.search_prompt), style = Type.body, color = G.label3) }
            list.isEmpty() -> Centered(Modifier.imePadding()) { Text(stringResource(R.string.search_empty), style = Type.title3, color = G.label2) }
            else -> LazyVerticalGrid(
                columns = GridCells.Adaptive(108.dp),
                modifier = Modifier.fillMaxSize().imeAware(),
                contentPadding = PaddingValues(top = 16.dp, bottom = 24.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                items(list, key = { Servers.key(it) }, contentType = { "poster" }) { item ->
                    PosterCard(item, api, onClick = { keyboard?.hide(); nav.open(item) }, width = null)
                }
            }
        }
    }
}
