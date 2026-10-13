plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    // Also puts KGP (Kotlin) on the build classpath at the catalog's version: AGP 9's built-in Kotlin uses it.
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
