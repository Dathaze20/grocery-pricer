plugins {
    alias(libs.plugins.kotlin.jvm)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    // The only dependency core is allowed: a pure-Kotlin JSON reader with no Android in it.
    // AI responses arrive as untrusted text, and hand-rolling a parser for untrusted input is
    // exactly where bugs hide. The tree API is used deliberately - no codegen, no compiler
    // plugin, and a missing or wrong-typed field reads as null instead of throwing.
    implementation(libs.kotlinx.serialization.json)

    testImplementation(libs.junit)
}

tasks.withType<Test>().configureEach {
    useJUnit()
    testLogging { events("passed", "skipped", "failed") }
}
