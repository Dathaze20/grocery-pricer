package com.grocerypricer.app.data.db

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * V1 to V2.
 *
 * The V1 database holds real purchase history - what the shop paid, and what it charged - so this
 * is purely additive. Nothing is dropped, nothing is rewritten, and no row is touched. Existing
 * orders keep their V1 status strings, which still parse because the V2 states were added to the
 * enum rather than replacing it.
 *
 * Every added column is nullable, so none of them needs a SQL DEFAULT. That matters: a NOT NULL
 * column added here would need `@ColumnInfo(defaultValue = ...)` on the Kotlin field to match, and
 * getting that pair even slightly out of step makes Room reject the upgrade at launch.
 */
val MIGRATION_1_2: Migration = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        // --- why the last processing run failed, and when it ran ---
        db.execSQL("ALTER TABLE `orders` ADD COLUMN `processingError` TEXT")
        db.execSQL("ALTER TABLE `orders` ADD COLUMN `processedAt` INTEGER")

        // --- how a photograph was classified ---
        db.execSQL("ALTER TABLE `receipt_images` ADD COLUMN `imageType` TEXT")
        db.execSQL("ALTER TABLE `receipt_images` ADD COLUMN `classificationConfidence` REAL")

        // --- where an extracted row came from, and how sure the model was ---
        db.execSQL("ALTER TABLE `order_items` ADD COLUMN `brand` TEXT")
        db.execSQL("ALTER TABLE `order_items` ADD COLUMN `rawName` TEXT")
        db.execSQL("ALTER TABLE `order_items` ADD COLUMN `aiConfidence` REAL")
        db.execSQL("ALTER TABLE `order_items` ADD COLUMN `extractionIssues` TEXT")
        db.execSQL("ALTER TABLE `order_items` ADD COLUMN `sourcePhotoIdsJson` TEXT")
        db.execSQL("ALTER TABLE `order_items` ADD COLUMN `rawCasePriceText` TEXT")
        db.execSQL("ALTER TABLE `order_items` ADD COLUMN `rawDiscountText` TEXT")

        // --- the conversation ---
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `chat_sessions` (" +
                "`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                "`orderId` INTEGER NOT NULL, " +
                "`createdAt` INTEGER NOT NULL, " +
                "`updatedAt` INTEGER NOT NULL, " +
                "FOREIGN KEY(`orderId`) REFERENCES `orders`(`id`) " +
                "ON UPDATE NO ACTION ON DELETE CASCADE )",
        )
        db.execSQL(
            "CREATE UNIQUE INDEX IF NOT EXISTS `index_chat_sessions_orderId` " +
                "ON `chat_sessions` (`orderId`)",
        )

        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `chat_messages` (" +
                "`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                "`sessionId` INTEGER NOT NULL, " +
                "`role` TEXT NOT NULL, " +
                "`text` TEXT NOT NULL, " +
                "`attachedImagePath` TEXT, " +
                "`resolvedItemIdsJson` TEXT, " +
                "`pending` INTEGER NOT NULL, " +
                "`createdAt` INTEGER NOT NULL, " +
                "FOREIGN KEY(`sessionId`) REFERENCES `chat_sessions`(`id`) " +
                "ON UPDATE NO ACTION ON DELETE CASCADE )",
        )
        db.execSQL(
            "CREATE INDEX IF NOT EXISTS `index_chat_messages_sessionId` " +
                "ON `chat_messages` (`sessionId`)",
        )
        db.execSQL(
            "CREATE INDEX IF NOT EXISTS `index_chat_messages_createdAt` " +
                "ON `chat_messages` (`createdAt`)",
        )

        // --- what ran, so a failure can be diagnosed without guessing ---
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS `ai_extraction_metadata` (" +
                "`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                "`orderId` INTEGER NOT NULL, " +
                "`provider` TEXT NOT NULL, " +
                "`model` TEXT NOT NULL, " +
                "`processedAt` INTEGER NOT NULL, " +
                "`inputImageCount` INTEGER NOT NULL, " +
                "`itemsExtracted` INTEGER NOT NULL, " +
                "`itemsRejected` INTEGER NOT NULL, " +
                "`successful` INTEGER NOT NULL, " +
                "`errorType` TEXT, " +
                "FOREIGN KEY(`orderId`) REFERENCES `orders`(`id`) " +
                "ON UPDATE NO ACTION ON DELETE CASCADE )",
        )
        db.execSQL(
            "CREATE INDEX IF NOT EXISTS `index_ai_extraction_metadata_orderId` " +
                "ON `ai_extraction_metadata` (`orderId`)",
        )
    }
}
