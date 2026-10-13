plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.compose)
}

// "Accès à distance": the Tailscale/NetBird sign-in panel (QR code) over core.mesh.
// Compose foundation only, so the TV app (tv-material) and the mobile app can both embed it
// with their own button and text-field widgets.
android {
    namespace = "com.wika.wicaby.meshui"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        minSdk = libs.versions.minSdkTv.get().toInt()
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    // French (values) and English (values-en) must stay complete.
    lint {
        // Shared rules (apps/android/lint.xml), e.g. ignore the generated local.properties.
        lintConfig = rootProject.file("lint.xml")
        error += "MissingTranslation"
    }
}

dependencies {
    api(project(":core"))
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.ui)
    // QR encoder (Apache-2.0).
    implementation(libs.zxing.core)
}
