plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "org.aegisub.web"
    compileSdk = 35
    defaultConfig {
        applicationId = "org.aegisub.web"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.10.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
}

val syncWebAssets by tasks.registering(Copy::class) {
    from("../../../dist")
    into("src/main/assets/www")
}
tasks.named("preBuild") { dependsOn(syncWebAssets) }
