plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.compose)
}

// The guide grid's drawing core (spec §6.1, §6.2, M-4): guide state, the lanes drawn in one
// drawBehind, the ruler and the now line. Compose foundation only, so the TV app (D-pad, one
// focus node) and the tablet guide (touch scroll) share it with their own channel cells and input.
android {
    namespace = "com.wika.wicaby.livetvui"
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
        lintConfig = rootProject.file("lint.xml")
        error += "MissingTranslation"
    }
}

dependencies {
    api(project(":core"))
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.ui)
}
