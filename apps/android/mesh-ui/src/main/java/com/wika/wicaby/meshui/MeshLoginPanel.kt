package com.wika.wicaby.meshui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.wika.wicaby.core.mesh.MeshProvider
import com.wika.wicaby.core.mesh.MeshState
import com.wika.wicaby.core.mesh.MeshStatus
import com.wika.wicaby.core.mesh.MeshTransport
import com.wika.wicaby.core.ui.Tokens

// Text styles and colours for the panel. Each app passes its own tokens; the
// default is Graphite (near-black surface, white labels, accent for the primary action only).
@Immutable
data class MeshPanelStyle(
    val title: TextStyle,
    val body: TextStyle,
    val caption: TextStyle,
    val mono: TextStyle,
    val label: Color,
    val label2: Color,
    val label3: Color,
    val fill: Color,
    val accent: Color,
    val onAccent: Color,
    val positive: Color,
    val error: Color,
) {
    companion object {
        val Graphite = MeshPanelStyle(
            title = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 19.sp, lineHeight = 24.sp),
            body = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
            caption = TextStyle(fontSize = 13.sp, lineHeight = 17.sp),
            mono = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 17.sp),
            label = Color(Tokens.Graphite.label),
            label2 = Color(Tokens.Graphite.label2),
            label3 = Color(Tokens.Graphite.label3),
            fill = Color(Tokens.Graphite.fill3),
            accent = Color(Tokens.SystemColors.blue),
            onAccent = Color.White,
            positive = Color(Tokens.SystemColors.green),
            error = Color(Tokens.SystemColors.red),
        )
    }
}

// A focusable, D-pad and touch friendly button: the app's own (Pill on TV) or [MeshDefaultButton].
typealias MeshButton = @Composable (label: String, primary: Boolean, onClick: () -> Unit, modifier: Modifier) -> Unit

// A single-line text field: the app's own (TvTextField on TV) or [MeshDefaultField].
typealias MeshField = @Composable (placeholder: String, value: String, onValueChange: (String) -> Unit, secret: Boolean, modifier: Modifier) -> Unit

/**
 * Réglages > Accès à distance: join Tailscale or NetBird, sign in by QR code, see
 * the mesh. Works on TV (D-pad) and touch screens. In every state the first
 * element is a button, so focus entering the pane lands on it.
 */
@Composable
fun MeshLoginPanel(
    mesh: MeshTransport,
    modifier: Modifier = Modifier,
    style: MeshPanelStyle = MeshPanelStyle.Graphite,
    button: MeshButton = { label, primary, onClick, m -> MeshDefaultButton(label, primary, onClick, m, style) },
    field: MeshField = { placeholder, value, onValueChange, secret, m -> MeshDefaultField(placeholder, value, onValueChange, secret, m, style) },
) {
    val status by mesh.status.collectAsState()
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        BasicText(stringResource(R.string.mesh_title), style = style.title.copy(color = style.label))
        when (status.state) {
            MeshState.Unsupported -> Body(stringResource(R.string.mesh_unsupported), style)
            MeshState.Stopped -> Setup(mesh, style, button, field)
            MeshState.Connecting -> Waiting(mesh, status, style, button)
            MeshState.NeedsLogin -> if (status.authUrl != null) SignIn(mesh, status, style, button) else Waiting(mesh, status, style, button)
            MeshState.Connected -> Connected(mesh, status, style, button)
            MeshState.Error -> Failed(mesh, status, style, button)
        }
    }
}

@Composable
private fun Body(text: String, style: MeshPanelStyle, color: Color = style.label2) =
    BasicText(text, style = style.body.copy(color = color))

@Composable
private fun Caption(text: String, style: MeshPanelStyle, color: Color = style.label3) =
    BasicText(text, style = style.caption.copy(color = color))

@Composable
private fun Setup(mesh: MeshTransport, style: MeshPanelStyle, button: MeshButton, field: MeshField) {
    var advanced by rememberSaveable { mutableStateOf(false) }
    var server by rememberSaveable { mutableStateOf(mesh.managementUrl.orEmpty()) }
    var key by remember { mutableStateOf("") }
    val join = { p: MeshProvider -> mesh.login(p, server.takeIf { advanced }, key.takeIf { advanced }) }
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        button(stringResource(R.string.mesh_join, MeshProvider.Tailscale.label), true, { join(MeshProvider.Tailscale) }, Modifier)
        button(stringResource(R.string.mesh_join, MeshProvider.NetBird.label), false, { join(MeshProvider.NetBird) }, Modifier)
    }
    Body(stringResource(R.string.mesh_intro), style)
    button(stringResource(if (advanced) R.string.mesh_advanced_hide else R.string.mesh_advanced), false, { advanced = !advanced }, Modifier)
    if (advanced) {
        field(stringResource(R.string.mesh_server_hint), server, { server = it }, false, Modifier.fillMaxWidth())
        field(stringResource(R.string.mesh_key_hint), key, { key = it }, true, Modifier.fillMaxWidth())
        Caption(stringResource(R.string.mesh_advanced_note), style)
    }
    Caption(stringResource(R.string.mesh_scope_note), style)
}

@Composable
private fun Waiting(mesh: MeshTransport, status: MeshStatus, style: MeshPanelStyle, button: MeshButton) {
    button(stringResource(R.string.mesh_cancel), false, { mesh.disconnect() }, Modifier)
    Body(stringResource(R.string.mesh_connecting, (status.provider ?: mesh.provider).label), style)
}

@Composable
private fun SignIn(mesh: MeshTransport, status: MeshStatus, style: MeshPanelStyle, button: MeshButton) {
    val url = status.authUrl ?: return
    val provider = (status.provider ?: mesh.provider).label
    Row(horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.Top) {
        val qrLabel = stringResource(R.string.mesh_qr_code)
        QrCode(url, Modifier.size(184.dp).semantics { contentDescription = qrLabel })
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            button(stringResource(R.string.mesh_cancel), false, { mesh.disconnect() }, Modifier)
            Body(stringResource(R.string.mesh_scan, provider), style, style.label)
            status.userCode?.let {
                Caption(stringResource(R.string.mesh_code), style)
                BasicText(it, style = style.mono.copy(color = style.label, fontSize = 22.sp, lineHeight = 26.sp, fontWeight = FontWeight.Medium))
            }
            Caption(stringResource(R.string.mesh_or_open), style)
            BasicText(url, style = style.mono.copy(color = style.label2), maxLines = 3, overflow = TextOverflow.Ellipsis)
            status.error?.let { Caption(it, style, style.label2) }
        }
    }
}

@Composable
private fun Connected(mesh: MeshTransport, status: MeshStatus, style: MeshPanelStyle, button: MeshButton) {
    val provider = (status.provider ?: mesh.provider).label
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        button(stringResource(R.string.mesh_disconnect), false, { mesh.disconnect() }, Modifier)
        button(stringResource(R.string.mesh_logout), false, { mesh.logout() }, Modifier)
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Dot(style.positive)
        Body(stringResource(R.string.mesh_connected, provider), style, style.label)
    }
    val self = listOfNotNull(status.selfDnsName ?: status.selfName, status.ips.firstOrNull()).joinToString(" · ")
    if (self.isNotEmpty()) Caption(stringResource(R.string.mesh_this_device, self), style, style.label2)
    status.error?.let { Caption(it, style, style.error) }
    if (status.peers.isEmpty()) {
        Caption(stringResource(R.string.mesh_no_peers), style)
    } else {
        Caption(stringResource(R.string.mesh_peers).uppercase(), style)
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val shown = status.peers.sortedByDescending { it.online }.take(8)
            for (p in shown) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Dot(if (p.online) style.positive else style.label3)
                    BasicText(p.name.ifEmpty { p.dnsName.orEmpty() }, style = style.body.copy(color = style.label), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    p.ips.firstOrNull()?.let { BasicText(it, style = style.mono.copy(color = style.label3), maxLines = 1) }
                }
            }
            if (status.peers.size > shown.size) (status.peers.size - shown.size).let { n -> Caption(pluralStringResource(R.plurals.mesh_more_peers, n, n), style) }
        }
    }
}

@Composable
private fun Failed(mesh: MeshTransport, status: MeshStatus, style: MeshPanelStyle, button: MeshButton) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        button(stringResource(R.string.mesh_retry), true, { mesh.login(status.provider ?: mesh.provider, mesh.managementUrl) }, Modifier)
        button(stringResource(R.string.mesh_disconnect), false, { mesh.disconnect() }, Modifier)
        button(stringResource(R.string.mesh_logout), false, { mesh.logout() }, Modifier)
    }
    Body(stringResource(R.string.mesh_failed, (status.provider ?: mesh.provider).label), style, style.label)
    status.error?.let { Caption(it, style, style.error) }
}

@Composable
private fun Dot(color: Color, size: Dp = 8.dp) {
    Box(Modifier.size(size).clip(CircleShape).background(color))
}

/** A QR code on a white card (with the quiet zone scanners need), black modules. */
@Composable
fun QrCode(text: String, modifier: Modifier = Modifier) {
    val matrix = remember(text) {
        runCatching {
            QRCodeWriter().encode(
                text, BarcodeFormat.QR_CODE, 0, 0,
                mapOf(EncodeHintType.MARGIN to 0, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M),
            )
        }.getOrNull()
    }
    Box(modifier.clip(RoundedCornerShape(12.dp)).background(Color.White).padding(12.dp)) {
        if (matrix == null) return@Box
        Canvas(Modifier.fillMaxSize()) {
            val n = matrix.width
            val cell = minOf(size.width, size.height) / n
            val origin = Offset((size.width - cell * n) / 2f, (size.height - cell * n) / 2f)
            // Cells overlap by a hair so no seams show between dark modules.
            val px = Size(cell + 0.5f, cell + 0.5f)
            for (y in 0 until n) for (x in 0 until n) {
                if (matrix.get(x, y)) drawRect(Color.Black, origin + Offset(x * cell, y * cell), px)
            }
        }
    }
}

@Composable
fun MeshDefaultButton(label: String, primary: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, style: MeshPanelStyle = MeshPanelStyle.Graphite) {
    var focused by remember { mutableStateOf(false) }
    val bg = when {
        primary -> style.accent
        focused -> Color.White
        else -> style.fill
    }
    val fg = when {
        primary -> style.onAccent
        focused -> Color.Black
        else -> style.label
    }
    Box(
        modifier
            .onFocusChanged { focused = it.hasFocus }
            .clip(RoundedCornerShape(50))
            .background(bg)
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 10.dp),
    ) {
        BasicText(label, style = style.body.copy(color = fg, fontWeight = FontWeight.SemiBold), maxLines = 1)
    }
}

@Composable
fun MeshDefaultField(placeholder: String, value: String, onValueChange: (String) -> Unit, secret: Boolean, modifier: Modifier = Modifier, style: MeshPanelStyle = MeshPanelStyle.Graphite) {
    var focused by remember { mutableStateOf(false) }
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        textStyle = style.body.copy(color = style.label),
        cursorBrush = SolidColor(style.accent),
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        modifier = modifier.onFocusChanged { focused = it.isFocused },
        decorationBox = { inner ->
            Box(
                Modifier
                    .clip(RoundedCornerShape(12.dp))
                    .background(if (focused) Color(Tokens.raisedFocus) else style.fill)
                    .padding(horizontal = 16.dp, vertical = 12.dp),
            ) {
                if (value.isEmpty()) BasicText(placeholder, style = style.body.copy(color = style.label3), maxLines = 1)
                inner()
            }
        },
    )
}
