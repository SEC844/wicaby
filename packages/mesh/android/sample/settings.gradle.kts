// Throwaway smoke test for the embedded mesh (packages/mesh + apps/android/core + apps/android/mesh-ui) on an
// emulator. Not part of the product build. Run from the repo root with the Android wrapper:
//   apps\android\gradlew.bat -p packages\mesh\android\sample :app:connectedDebugAndroidTest
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        ivy {
            url = uri("../../../../vendor/android")
            patternLayout { artifact("[artifact].[ext]") }
            metadataSources { artifact() }
            content { includeGroup("wicaby.vendor") }
        }
    }
}
rootProject.name = "wicaby-mesh-sample"
include(":core", ":mesh-ui", ":app")
project(":core").projectDir = file("../../../../apps/android/core")
project(":mesh-ui").projectDir = file("../../../../apps/android/mesh-ui")
