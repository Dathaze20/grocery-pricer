package com.grocerypricer.app.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import com.grocerypricer.app.data.db.dao.OrderDao
import com.grocerypricer.app.data.db.dao.OrderItemDao
import com.grocerypricer.app.data.db.dao.PriceHistoryDao
import com.grocerypricer.app.data.db.dao.PricingRuleDao
import com.grocerypricer.app.data.db.dao.ProductDao
import com.grocerypricer.app.data.db.dao.ReceiptImageDao
import com.grocerypricer.app.data.db.dao.ScanHistoryDao
import com.grocerypricer.app.data.db.entity.OrderEntity
import com.grocerypricer.app.data.db.entity.OrderItemEntity
import com.grocerypricer.app.data.db.entity.PriceHistoryEntity
import com.grocerypricer.app.data.db.entity.PricingRuleEntity
import com.grocerypricer.app.data.db.entity.ProductEntity
import com.grocerypricer.app.data.db.entity.ReceiptImageEntity
import com.grocerypricer.app.data.db.entity.ScanHistoryEntity

@Database(
    entities = [
        ProductEntity::class,
        OrderEntity::class,
        OrderItemEntity::class,
        ReceiptImageEntity::class,
        PriceHistoryEntity::class,
        PricingRuleEntity::class,
        ScanHistoryEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
abstract class GroceryPricerDatabase : RoomDatabase() {

    abstract fun productDao(): ProductDao
    abstract fun orderDao(): OrderDao
    abstract fun orderItemDao(): OrderItemDao
    abstract fun receiptImageDao(): ReceiptImageDao
    abstract fun priceHistoryDao(): PriceHistoryDao
    abstract fun pricingRuleDao(): PricingRuleDao
    abstract fun scanHistoryDao(): ScanHistoryDao

    companion object {
        const val DATABASE_NAME = "grocery_pricer.db"

        /**
         * Real migrations go here as the schema evolves. Destructive migration is deliberately
         * never enabled: a store's purchase history is not something to drop on a version bump.
         */
        val MIGRATIONS: Array<Migration> = emptyArray()

        @Volatile
        private var instance: GroceryPricerDatabase? = null

        fun get(context: Context): GroceryPricerDatabase =
            instance ?: synchronized(this) {
                instance ?: build(context.applicationContext).also { instance = it }
            }

        private fun build(context: Context): GroceryPricerDatabase =
            Room.databaseBuilder(context, GroceryPricerDatabase::class.java, DATABASE_NAME)
                .addMigrations(*MIGRATIONS)
                .build()
    }
}
