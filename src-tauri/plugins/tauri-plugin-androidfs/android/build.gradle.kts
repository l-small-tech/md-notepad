plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.plugin.androidfs"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    // Whiteboard scan: EXIF orientation is baked into the captured bitmap on
    // the Kotlin side, so nothing downstream has to know phones shoot sideways.
    implementation("androidx.exifinterface:exifinterface:1.3.7")
    // Whiteboard scan OCR (S6). Digital Ink is the primary engine — an
    // on-device HANDWRITING model fed the traced strokes; language models
    // download on first use. Text Recognition is the printed-text fallback,
    // via the Play-Services-delivered variant so it adds no APK weight (the
    // model arrives through Play Services; see the manifest meta-data).
    implementation("com.google.mlkit:digital-ink-recognition:18.1.0")
    implementation("com.google.android.gms:play-services-mlkit-text-recognition:19.0.1")
    implementation("androidx.appcompat:appcompat:1.6.0")
    implementation("com.google.android.material:material:1.7.0")
    implementation(project(":tauri-android"))
}
