package com.wika.wicaby.tv.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.wika.wicaby.core.Core
import com.wika.wicaby.meshui.MeshLoginPanel
import com.wika.wicaby.meshui.MeshPanelStyle

// Réglages > Accès à distance: Wicaby's own Tailscale / NetBird node (:mesh-ui panel,
// QR code sign-in). The pane is ~560 dp wide; every panel state starts with a button,
// so moving right from the section list lands on it.
@Composable
fun RemoteAccessSection(modifier: Modifier = Modifier) {
    val accent = LocalAccent.current
    MeshLoginPanel(
        mesh = Core.mesh,
        modifier = modifier.fillMaxWidth(),
        style = MeshPanelStyle(
            title = Type.title3, body = Type.body, caption = Type.footnote, mono = Type.mono,
            label = C.label, label2 = C.label2, label3 = C.label3, fill = C.fill3,
            accent = accent, onAccent = onAccent(accent), positive = Accents[6], error = C.red,
        ),
        button = { label, primary, onClick, m -> Pill(label, onClick, m, primary = primary) },
        field = { placeholder, value, onValueChange, secret, m -> TvTextField(value, onValueChange, placeholder, m, password = secret) },
    )
}
