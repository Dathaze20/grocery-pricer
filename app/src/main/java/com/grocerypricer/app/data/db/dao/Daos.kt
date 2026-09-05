package com.grocerypricer.app.data.db.dao

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Update
import com.grocerypricer.app.data.db.entity.OrderEntity
import com.grocerypricer.app.data.db.entity.OrderItemEntity
import com.grocerypricer.app.data.db.entity.PriceHistoryEntity
import com.grocerypricer.app.data.db.entity.PricingRuleEntity
import com.grocerypricer.app.data.db.entity.ProductEntity
import com.grocerypricer.app.data.db.entity.ReceiptImageEntity
import com.grocerypricer.app.data.db.entity.ScanHistoryEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface ProductDao {

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(product: ProductEntity): Long

    @Update
    suspend fun update(product: ProductEntity)

    @Delete
    suspend fun delete(product: ProductEntity)

    @Query("SELECT * FROM products WHERE id = :id")
    suspend fun getById(id: Long): ProductEntity?

    @Query("SELECT * FROM products WHERE id = :id")
    fun observeById(id: Long): Flow<ProductEntity?>

    @Query("SELECT * FROM products WHERE upc IN (:codes) LIMIT 10")
    suspend fun getByUpcCandidates(codes: List<String>): List<ProductEntity>

    @Query("SELECT * FROM products WHERE supplierSku = :sku LIMIT 10")
    suspend fun getBySupplierSku(sku: String): List<ProductEntity>

    @Query("SELECT * FROM products ORDER BY name COLLATE NOCASE ASC")
    fun observeAll(): Flow<List<ProductEntity>>

    @Query("SELECT * FROM products ORDER BY name COLLATE NOCASE ASC")
    suspend fun getAll(): List<ProductEntity>

    @Query("SELECT COUNT(*) FROM products")
    fun observeCount(): Flow<Int>

    @Query("DELETE FROM products")
    suspend fun deleteAll()
}

@Dao
interface OrderDao {

    @Insert
    suspend fun insert(order: OrderEntity): Long

    @Update
    suspend fun update(order: OrderEntity)

    @Delete
    suspend fun delete(order: OrderEntity)

    @Query("SELECT * FROM orders WHERE id = :id")
    suspend fun getById(id: Long): OrderEntity?

    @Query("SELECT * FROM orders WHERE id = :id")
    fun observeById(id: Long): Flow<OrderEntity?>

    @Query("SELECT * FROM orders ORDER BY orderDate DESC, id DESC")
    fun observeAll(): Flow<List<OrderEntity>>

    @Query("SELECT * FROM orders ORDER BY orderDate DESC, id DESC")
    suspend fun getAll(): List<OrderEntity>

    @Query("SELECT * FROM orders ORDER BY updatedAt DESC LIMIT 1")
    fun observeMostRecent(): Flow<OrderEntity?>

    @Query("DELETE FROM orders")
    suspend fun deleteAll()
}

@Dao
interface OrderItemDao {

    @Insert
    suspend fun insert(item: OrderItemEntity): Long

    @Insert
    suspend fun insertAll(items: List<OrderItemEntity>): List<Long>

    @Update
    suspend fun update(item: OrderItemEntity)

    @Update
    suspend fun updateAll(items: List<OrderItemEntity>)

    @Delete
    suspend fun delete(item: OrderItemEntity)

    @Query("SELECT * FROM order_items WHERE id = :id")
    suspend fun getById(id: Long): OrderItemEntity?

    @Query("SELECT * FROM order_items WHERE orderId = :orderId ORDER BY id ASC")
    fun observeByOrder(orderId: Long): Flow<List<OrderItemEntity>>

    @Query("SELECT * FROM order_items WHERE orderId = :orderId ORDER BY id ASC")
    suspend fun getByOrder(orderId: Long): List<OrderItemEntity>

    @Query("SELECT * FROM order_items ORDER BY id ASC")
    suspend fun getAll(): List<OrderItemEntity>

    @Query("SELECT * FROM order_items WHERE orderId = :orderId AND (upc = :barcode OR upc = :alternateBarcode)")
    suspend fun findInOrderByBarcode(orderId: Long, barcode: String, alternateBarcode: String): List<OrderItemEntity>

    @Query("DELETE FROM order_items WHERE orderId = :orderId")
    suspend fun deleteByOrder(orderId: Long)

    @Query("DELETE FROM order_items")
    suspend fun deleteAll()
}

@Dao
interface ReceiptImageDao {

    @Insert
    suspend fun insert(image: ReceiptImageEntity): Long

    @Update
    suspend fun update(image: ReceiptImageEntity)

    @Delete
    suspend fun delete(image: ReceiptImageEntity)

    @Query("SELECT * FROM receipt_images WHERE orderId = :orderId ORDER BY position ASC, id ASC")
    fun observeByOrder(orderId: Long): Flow<List<ReceiptImageEntity>>

    @Query("SELECT * FROM receipt_images WHERE orderId = :orderId ORDER BY position ASC, id ASC")
    suspend fun getByOrder(orderId: Long): List<ReceiptImageEntity>

    @Query("SELECT * FROM receipt_images WHERE id = :id")
    suspend fun getById(id: Long): ReceiptImageEntity?

    @Query("SELECT * FROM receipt_images ORDER BY id ASC")
    suspend fun getAll(): List<ReceiptImageEntity>

    @Query("DELETE FROM receipt_images")
    suspend fun deleteAll()
}

@Dao
interface PriceHistoryDao {

    @Insert
    suspend fun insert(entry: PriceHistoryEntity): Long

    @Insert
    suspend fun insertAll(entries: List<PriceHistoryEntity>)

    @Query("SELECT * FROM price_history WHERE productId = :productId ORDER BY recordedAt DESC")
    fun observeForProduct(productId: Long): Flow<List<PriceHistoryEntity>>

    @Query("SELECT * FROM price_history WHERE productId = :productId ORDER BY recordedAt DESC LIMIT :limit")
    suspend fun recentForProduct(productId: Long, limit: Int): List<PriceHistoryEntity>

    @Query("SELECT * FROM price_history ORDER BY recordedAt DESC LIMIT :limit")
    fun observeRecent(limit: Int): Flow<List<PriceHistoryEntity>>

    @Query("SELECT * FROM price_history ORDER BY id ASC")
    suspend fun getAll(): List<PriceHistoryEntity>

    /** Fills in the shelf price on the entry an order created, once the user approves it. */
    @Query("UPDATE price_history SET retailPriceRaw = :retailPriceRaw WHERE productId = :productId AND orderId = :orderId")
    suspend fun setRetailPriceForOrder(productId: Long, orderId: Long, retailPriceRaw: Long)

    @Query("DELETE FROM price_history")
    suspend fun deleteAll()
}

@Dao
interface PricingRuleDao {

    @Query("SELECT * FROM pricing_rules ORDER BY kind ASC, sortOrder ASC")
    fun observeAll(): Flow<List<PricingRuleEntity>>

    @Query("SELECT * FROM pricing_rules ORDER BY kind ASC, sortOrder ASC")
    suspend fun getAll(): List<PricingRuleEntity>

    @Query("SELECT COUNT(*) FROM pricing_rules")
    suspend fun count(): Int

    @Insert
    suspend fun insertAll(rules: List<PricingRuleEntity>)

    @Update
    suspend fun update(rule: PricingRuleEntity)

    @Delete
    suspend fun delete(rule: PricingRuleEntity)

    @Query("DELETE FROM pricing_rules")
    suspend fun deleteAll()

    /** Rules are replaced as a set, so a half-saved ladder can never be read back. */
    @Transaction
    suspend fun replaceAll(rules: List<PricingRuleEntity>) {
        deleteAll()
        insertAll(rules)
    }
}

@Dao
interface ScanHistoryDao {

    @Insert
    suspend fun insert(entry: ScanHistoryEntity): Long

    @Insert
    suspend fun insertAll(entries: List<ScanHistoryEntity>)

    @Query("SELECT * FROM scan_history ORDER BY scannedAt DESC LIMIT :limit")
    fun observeRecent(limit: Int): Flow<List<ScanHistoryEntity>>

    @Query("SELECT * FROM scan_history ORDER BY id ASC")
    suspend fun getAll(): List<ScanHistoryEntity>

    @Query("DELETE FROM scan_history")
    suspend fun deleteAll()
}
