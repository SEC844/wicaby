plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.wika.wicaby.core"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        minSdk = libs.versions.minSdkTv.get().toInt()
        consumerProguardFiles("consumer-rules.pro")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        // Shared rules (apps/android/lint.xml), e.g. ignore the generated local.properties.
        lintConfig = rootProject.file("lint.xml")
        disable += "UnsafeOptInUsageError"
        // values/ (French, the default) and values-en/ must stay in step.
        error += "MissingTranslation"
    }

    testOptions.unitTests.isReturnDefaultValues = true
}

dependencies {
    // Runtime only (no UI): Playback exposes snapshot state both apps' Compose UIs observe.
    api(platform(libs.androidx.compose.bom))
    api(libs.androidx.compose.runtime)
    // @StringRes / @PluralsRes on the ids :core hands to the UIs.
    api(libs.androidx.annotation)

    // exoplayer + exoplayer-hls + datasource-okhttp. Player traffic goes through the shared
    // OkHttpClient, so ServerTransport covers it too.
    api(libs.bundles.media3.player)
    // FFmpeg audio (AC3/E-AC3/DTS/TrueHD...) when the device has neither a decoder nor passthrough.
    // GPL-3.0: see README. Jellyfin ships this 1.9.0 build against Media3 1.11.1 too.
    // compileOnly (cast spec CA-10): :tv and mobile foss ship it, mobile gplay does not (no GPL §7 permission from
    // its authors). DeviceProfile probes it in runCatching and Engine loads its renderer by reflection.
    compileOnly(libs.jellyfin.media3.ffmpeg.decoder)
    // libass for ASS/SSA with full styling (MIT); built for Media3 1.8, Jellyfin runs it on 1.11.1.
    api(libs.ass.media)
    implementation(libs.ass.kt) // SubtitleLook sets the libass font scale
    // ass-media 0.5.1 pulls media3-effect 1.8.0 (runtime scope) and Media3 has no BOM or alignment
    // constraints: pin it to the catalog's Media3 so every androidx.media3 module moves in lock-step.
    runtimeOnly(libs.androidx.media3.effect)

    api(libs.okhttp)
    // ComicCoverFetcher/Keyer (comics/ComicCover.kt): both apps register them in their ImageLoader.
    implementation(libs.coil.core)
    // Comics in RAR (4 and 5), 7z and tar (comics/ComicLibarchive.kt): libarchive's own BSD readers (see THIRD_PARTY_NOTICES.md).
    // JNI, about 1 MB per ABI in the APK; its consumer ProGuard rules keep the classes the native code calls.
    implementation(libs.libarchive)
    api(libs.kotlinx.serialization.json)
    api(libs.androidx.datastore.preferences)
    // TorrentsViewModel (qBittorrent): both apps get a ready, polling StateFlow.
    api(libs.androidx.lifecycle.viewmodel)
    // Embedded Tailscale/NetBird node (packages/mesh, gomobile): core.mesh.MeshTransport.
    // ~17 MB per ABI in the APK; BSD-3 (licences: <repo>/vendor/android/wicaby-mesh-THIRD_PARTY_LICENSES.txt).
    // Stays a string: a local ivy artifact (not a published module), so not in the version catalog.
    //noinspection UseTomlInstead
    implementation("wicaby.vendor:wicaby-mesh:0@aar")

    testImplementation(libs.junit)
    // Fake qBittorrent Web API for QbitClient tests.
    testImplementation(libs.okhttp.mockwebserver3)
    testImplementation(libs.kxml2)
    // MusicSessionTest (music spec MU-07): a real ExoPlayer, never prepared, under Robolectric.
    testImplementation(libs.robolectric)

    // ComicNativeTest: libarchive (JNI) and PdfRenderer only run on a device (:core:connectedDebugAndroidTest).
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.junit)
}

// CK/fixtures/cast/ onto the unit-test classpath as /cast/* (cast spec CA-08 checks): DlnaTest, CastProfilesTest and
// CastControllerTest read the very files cast-check.mjs and the mocks use.
val copyCastFixtures = tasks.register<Copy>("copyCastFixtures") {
    from(rootProject.file("../../tools/checks/fixtures/cast"))
    into(layout.buildDirectory.dir("castFixtures/cast"))
}
// File sources (file-sources spec §3.3): the golden vectors the desktop checks too, as /files/*.json and
// /server-caps.json (FilesVectorsTest, ServerCapsTest). Copied at build time, so they cannot drift.
// The WebDAV mock itself (tools/mock-server/mock-webdav.mjs) runs in FilesMockTest when node is on the PATH.
val copyFilesFixtures = tasks.register<Copy>("copyFilesFixtures") {
    from(rootProject.file("../../tools/checks/fixtures/files")) { into("files") }
    from(rootProject.file("../../tools/checks/fixtures/server-caps.json"))
    // The saved MDBList answer ratings-check.mjs reads too (RatingsTest), as /ratings/*.
    from(rootProject.file("../../tools/checks/fixtures/ratings")) { into("ratings") }
    // The mock's TEST ONLY certificate pairs (the pin tests: FilesApiTest).
    from(rootProject.file("../../tools/mock-server/fixtures/webdav-tls")) { into("webdav-tls") }
    into(layout.buildDirectory.dir("filesFixtures"))
}
androidComponents {
    onVariants { v ->
        v.hostTests[com.android.build.api.variant.HostTestBuilder.UNIT_TEST_TYPE]?.sources?.resources
            ?.addStaticSourceDirectory(layout.buildDirectory.dir("castFixtures").get().asFile.path)
        v.hostTests[com.android.build.api.variant.HostTestBuilder.UNIT_TEST_TYPE]?.sources?.resources
            ?.addStaticSourceDirectory(layout.buildDirectory.dir("filesFixtures").get().asFile.path)
    }
}
tasks.matching { it.name.startsWith("process") && it.name.endsWith("UnitTestJavaRes") }.configureEach { dependsOn(copyCastFixtures, copyFilesFixtures) }

// The mocks' comic books, every format (tools/mock-server/write-comic-fixtures.mjs, needs node), as the device test's
// assets/comics/*: ComicNativeTest reads the very bytes the mocks serve.
val comicFixtures = tasks.register<Exec>("comicFixtures") {
    val out = layout.buildDirectory.dir("comicFixtures/comics").get().asFile
    outputs.dir(out)
    commandLine("node", rootProject.file("../../tools/mock-server/write-comic-fixtures.mjs").path, out.path)
}
androidComponents {
    onVariants { v -> v.androidTest?.sources?.assets?.addStaticSourceDirectory(layout.buildDirectory.dir("comicFixtures").get().asFile.path) }
}
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("AndroidTestAssets") }.configureEach { dependsOn(comicFixtures) }
