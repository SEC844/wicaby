package com.wika.wicaby.mobile.ui

import android.graphics.BitmapFactory
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.wika.wicaby.core.data.Api
import com.wika.wicaby.core.pair.PairTarget
import com.wika.wicaby.core.pair.parsePairUrl
import com.wika.wicaby.core.pair.sendPair
import com.wika.wicaby.mobile.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

// shortcut: a still photo through the camera app (no camera permission, no new dependency), not a
// live viewfinder; move to an in-app CameraX scanner if photos of TV screens fail too often.
private fun decodeQr(file: File): String? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 2000) sample *= 2
    val bmp = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
    val px = IntArray(bmp.width * bmp.height).also { bmp.getPixels(it, 0, bmp.width, 0, 0, bmp.width, bmp.height) }
    val source = RGBLuminanceSource(bmp.width, bmp.height, px)
    bmp.recycle()
    return runCatching { QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), mapOf(DecodeHintType.TRY_HARDER to true)).text }.getOrNull()
}

// Réglages > Connecter une TV: photograph the code the TV shows (tv/ui/PhonePair.kt), confirm, and
// this phone's server and session go to the TV over the home network (core/pair/Pairing.kt).
@Composable
fun PairTvRow(api: Api, userName: String) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var target by remember { mutableStateOf<PairTarget?>(null) }
    var busy by remember { mutableStateOf(false) }
    val photo = remember { File(context.cacheDir, "pair/qr.jpg").also { it.parentFile?.mkdirs() } }
    val uri = remember { FileProvider.getUriForFile(context, "${context.packageName}.pair", photo) }
    val noCode = stringResource(R.string.pair_no_code)
    val noCamera = stringResource(R.string.pair_no_camera)
    val done = stringResource(R.string.pair_done)
    val failed = stringResource(R.string.pair_failed)
    fun toast(text: String) = Toast.makeText(context, text, Toast.LENGTH_LONG).show()

    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { taken ->
        if (!taken) return@rememberLauncherForActivityResult
        scope.launch {
            val text = withContext(Dispatchers.Default) { runCatching { decodeQr(photo) }.getOrNull().also { photo.delete() } }
            target = text?.let(::parsePairUrl)
            if (target == null) toast(noCode)
        }
    }

    GroupRow(
        stringResource(R.string.pair_tv), { if (!busy && runCatching { camera.launch(uri) }.isFailure) toast(noCamera) },
        subtitle = stringResource(R.string.pair_tv_sub), icon = Ic.Scan, chevron = !busy,
    ) { if (busy) Spinner(Modifier.size(20.dp)) }

    val t = target ?: return
    val buttons = ButtonDefaults.textButtonColors(contentColor = G.label)
    AlertDialog(
        onDismissRequest = { target = null },
        title = { Text(stringResource(R.string.pair_confirm_title), style = Type.title3) },
        text = { Text(stringResource(R.string.pair_confirm_body, t.host, userName), style = Type.body) },
        confirmButton = {
            TextButton({
                target = null
                val userId = api.userId ?: return@TextButton
                val token = api.token ?: return@TextButton
                scope.launch {
                    busy = true
                    val ok = runCatching { sendPair(t, api.server.address, userId, token) }.getOrDefault(false)
                    busy = false
                    toast(if (ok) done else failed)
                }
            }, colors = buttons) { Text(stringResource(R.string.pair_connect), style = Type.headline) }
        },
        dismissButton = { TextButton({ target = null }, colors = buttons) { Text(stringResource(R.string.pair_cancel), style = Type.headline) } },
        shape = RoundedCornerShape(Radius.xl),
        containerColor = G.elevated2,
        titleContentColor = G.label,
        textContentColor = G.label2,
    )
}
