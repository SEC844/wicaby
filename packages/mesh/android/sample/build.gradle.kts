plugins {
    id("com.android.application") version "9.4.1" apply false
    id("com.android.library") version "9.4.1" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.21" apply false
}

// :core and :mesh-ui live in apps/android; keep their outputs here so this build never
// races the Android build over apps/android/*/build.
listOf(":core", ":mesh-ui").forEach { path ->
    project(path) { layout.buildDirectory.set(rootProject.layout.buildDirectory.dir(path.removePrefix(":"))) }
}
