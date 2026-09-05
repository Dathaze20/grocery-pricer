# Room generates implementations reflectively at startup.
-keep class * extends androidx.room.RoomDatabase { <init>(); }
-keep @androidx.room.Entity class * { *; }
-dontwarn androidx.room.paging.**

# ML Kit ships its own consumer rules; these cover the dynamically loaded model pieces.
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_** { *; }
-dontwarn com.google.mlkit.**

# The core pricing module is serialised into backups by field name.
-keep class com.grocerypricer.core.** { *; }

# Kotlin metadata used by Compose tooling.
-keepattributes *Annotation*, InnerClasses, Signature, RuntimeVisible*
