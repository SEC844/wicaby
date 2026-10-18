package com.wika.wicaby.mobile.ui

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import com.wika.wicaby.core.Core
import com.wika.wicaby.core.mesh.MeshState
import com.wika.wicaby.core.mesh.MeshTransport
import com.wika.wicaby.core.net.LocalNetwork
import com.wika.wicaby.meshui.MeshLoginPanel
import com.wika.wicaby.meshui.MeshPanelStyle
import com.wika.wicaby.mobile.R

// "Accès à distance": the shared mesh sign-in panel, with this app's type, buttons and fields.
@Composable
fun RemoteAccessSection() {
    val context = LocalContext.current
    val accent = LocalAccent.current
    val status by Core.mesh.status.collectAsState()
    // The panel carries its own "Accès à distance" title.
    Group(Modifier.padding(top = 22.dp)) {
        MeshLoginPanel(
            mesh = Core.mesh,
            modifier = Modifier.padding(16.dp),
            // The theme's labels, so the panel reads on the light canvas too.
            style = MeshPanelStyle.Graphite.copy(
                title = Type.title3, body = Type.body, caption = Type.footnote, mono = Type.mono,
                label = G.label, label2 = G.label2, label3 = G.label3, fill = G.fill3,
                accent = accent, onAccent = onAccent(accent), positive = Color(G.palette.system.green), error = G.red,
            ),
            button = { label, primary, onClick, m -> PillButton(label, onClick, m, primary = primary, compact = true) },
            field = { placeholder, value, onValueChange, secret, m -> WicabyField(value, onValueChange, placeholder, m, password = secret) },
        )
        // On a phone the sign-in page is on this very device: a browser beats scanning a QR code.
        // Only an https page is opened (never intent:, file:, content: or cleartext http).
        status.authUrl?.takeIf { it.toUri().scheme.equals("https", ignoreCase = true) }?.let { url ->
            PillButton(
                stringResource(R.string.open_in_browser),
                { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri())) } },
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 16.dp),
                primary = true,
            )
        }
        // Android 17, management server on the LAN: ask for the permission here, then join again.
        if (status.state == MeshState.Error && status.error == MeshTransport.LOCAL_NETWORK_REFUSED) {
            var granted by rememberLocalNetworkGranted()
            var refused by rememberSaveable { mutableStateOf(false) }
            val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
                granted = it
                refused = !it
            }
            LaunchedEffect(granted) { if (granted) Core.mesh.login(Core.mesh.provider, Core.mesh.managementUrl) }
            PillButton(
                stringResource(if (refused) com.wika.wicaby.core.R.string.local_network_open_settings else com.wika.wicaby.core.R.string.local_network_allow),
                { if (refused) LocalNetwork.openSettings(context) else ask.launch(LocalNetwork.PERMISSION) },
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 16.dp),
                primary = true,
            )
        }
    }
}
