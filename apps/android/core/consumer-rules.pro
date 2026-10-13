-dontwarn org.slf4j.**
# compileOnly in :core: absent from the mobile gplay flavour (cast spec CA-10), probed in runCatching.
-dontwarn androidx.media3.decoder.ffmpeg.**

# ass-media reads these MatroskaExtractor fields by reflection.
-keepclassmembers class androidx.media3.extractor.mkv.MatroskaExtractor {
    *** extractorOutput;
    *** subtitleSample;
}

# gomobile bindings: libgojni calls back into these classes by name over JNI.
-keep class go.** { *; }
-keep class com.wika.wicaby.mesh.** { *; }
