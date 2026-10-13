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
        // vendor/android/wicaby-mesh.aar (repo root): the embedded Tailscale/NetBird node
        // (packages/mesh, gomobile). Built by `npm run build:mesh-aar`; vendor/ is not in git.
        ivy {
            url = uri("../../vendor/android")
            patternLayout { artifact("[artifact].[ext]") }
            metadataSources { artifact() }
            content { includeGroup("wicaby.vendor") }
        }
    }
}
rootProject.name = "wicaby-android"
// :core is the shared, UI-free layer; :tv is Android TV, :mobile is phones and tablets.
// :mesh-ui is the "Accès à distance" panel (Compose foundation) both apps embed.
// :livetv-ui is the guide grid's drawing core (Compose foundation): the TV grid and the tablet grid.
include(":core", ":mesh-ui", ":livetv-ui", ":tv", ":mobile")
