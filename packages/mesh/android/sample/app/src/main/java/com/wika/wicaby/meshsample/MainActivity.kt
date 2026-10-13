package com.wika.wicaby.meshsample

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.wika.wicaby.core.mesh.MeshProvider
import com.wika.wicaby.core.mesh.MeshTransport
import com.wika.wicaby.meshui.MeshLoginPanel

// Debug screen: the TV panel at its real width on Graphite black.
//   adb shell am start -n com.wika.wicaby.meshsample/.MainActivity --es join tailscale|netbird
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val mesh = mesh ?: MeshTransport(applicationContext, "mesh sample").also { mesh = it }
        MeshProvider.of(intent.getStringExtra("join"))?.let { mesh.login(it) }
        if (intent.getBooleanExtra("stop", false)) mesh.disconnect()
        setContent {
            Box(Modifier.fillMaxSize().background(Color(0xFF0B0B0D)).padding(48.dp)) {
                MeshLoginPanel(mesh, Modifier.width(560.dp))
            }
        }
    }

    companion object {
        private var mesh: MeshTransport? = null
    }
}
