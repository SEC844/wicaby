package com.wika.wicaby.mobile.ui

import android.content.Intent
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import com.wika.wicaby.core.Core
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
            style = MeshPanelStyle.Graphite.copy(
                title = Type.title3, body = Type.body, caption = Type.footnote, mono = Type.mono,
                accent = accent, onAccent = onAccent(accent),
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
    }
}
