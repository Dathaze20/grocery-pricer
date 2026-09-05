package com.grocerypricer.app.data.repository

import com.grocerypricer.app.data.db.dao.PriceHistoryDao
import com.grocerypricer.app.data.db.dao.ProductDao
import com.grocerypricer.app.data.db.dao.ScanHistoryDao
import com.grocerypricer.app.data.db.entity.ScanHistoryEntity
import com.grocerypricer.app.data.db.toDomain
import com.grocerypricer.app.data.db.toEntity
import com.grocerypricer.app.data.model.PriceHistoryEntry
import com.grocerypricer.app.data.model.Product
import com.grocerypricer.app.data.model.ScanRecord
import com.grocerypricer.core.matching.MatchOutcome
import com.grocerypricer.core.matching.ProductMatcher
import com.grocerypricer.core.matching.ProductQuery
import com.grocerypricer.core.money.Money
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/** Reads and writes the permanent product catalogue, plus its price history and scan log. */
class ProductRepository(
    private val productDao: ProductDao,
    private val priceHistoryDao: PriceHistoryDao,
    private val scanHistoryDao: ScanHistoryDao,
    private val now: () -> Long = System::currentTimeMillis,
) {

    fun observeAll(): Flow<List<Product>> = productDao.observeAll().map { rows -> rows.map { it.toDomain() } }

    fun observeCount(): Flow<Int> = productDao.observeCount()

    fun observeById(id: Long): Flow<Product?> = productDao.observeById(id).map { it?.toDomain() }

    suspend fun getById(id: Long): Product? = productDao.getById(id)?.toDomain()

    suspend fun getAll(): List<Product> = productDao.getAll().map { it.toDomain() }

    /**
     * Looks a barcode up in the catalogue. A UPC-A and the EAN-13 the same item scans as differ
     * only by leading zeros, so every plausible form is queried.
     */
    suspend fun findByBarcode(barcode: String): MatchOutcome {
        val normalized = ProductMatcher.normalizeUpc(barcode) ?: return MatchOutcome.NoMatch
        val candidates = productDao.getByUpcCandidates(barcodeVariants(normalized))
        if (candidates.isEmpty()) return MatchOutcome.NoMatch
        return ProductMatcher.match(ProductQuery(upc = normalized), candidates.map { it.toDomain() })
    }

    suspend fun search(term: String): List<Product> =
        ProductMatcher.search(term, getAll()).filterIsInstance<Product>()

    /** Matching from words read off a product label when no barcode is visible. */
    suspend fun identifyFromLabel(labelText: String): MatchOutcome =
        ProductMatcher.matchFromLabelText(labelText, getAll())

    suspend fun insert(product: Product): Long {
        val timestamp = now()
        return productDao.insert(product.toEntity(createdAt = timestamp, updatedAt = timestamp))
    }

    suspend fun update(product: Product) {
        val existing = productDao.getById(product.id) ?: return
        productDao.update(product.toEntity(createdAt = existing.createdAt, updatedAt = now()))
    }

    suspend fun delete(product: Product) {
        productDao.getById(product.id)?.let { productDao.delete(it) }
    }

    suspend fun setOverridePrice(productId: Long, price: Money?) {
        val product = getById(productId) ?: return
        update(product.copy(overridePrice = price))
    }

    suspend fun adjustQuantity(productId: Long, adjustment: Int) {
        val product = getById(productId) ?: return
        update(product.copy(quantityAdjustment = adjustment))
    }

    fun observePriceHistory(productId: Long): Flow<List<PriceHistoryEntry>> =
        priceHistoryDao.observeForProduct(productId).map { rows -> rows.map { it.toDomain() } }

    fun observeRecentPriceHistory(limit: Int = 100): Flow<List<PriceHistoryEntry>> =
        priceHistoryDao.observeRecent(limit).map { rows -> rows.map { it.toDomain() } }

    suspend fun recordPriceHistory(entry: PriceHistoryEntry) {
        priceHistoryDao.insert(entry.toEntity())
    }

    /** The cost this product was last bought at before the given moment, if there is one. */
    suspend fun previousCost(productId: Long, before: Long): Money? =
        priceHistoryDao.recentForProduct(productId, limit = 10)
            .firstOrNull { it.recordedAt < before }
            ?.let { Money.fromStorageLong(it.unitCostRaw) }

    fun observeRecentScans(limit: Int = 30): Flow<List<ScanRecord>> =
        scanHistoryDao.observeRecent(limit).map { rows -> rows.map { it.toDomain() } }

    suspend fun recordScan(productId: Long?, barcode: String?, matchedName: String?, approvedPrice: Money?) {
        scanHistoryDao.insert(
            ScanHistoryEntity(
                productId = productId,
                barcode = barcode,
                matchedName = matchedName,
                approvedPriceRaw = approvedPrice?.toStorageLong(),
                scannedAt = now(),
            )
        )
    }

    companion object {
        /** The same product can be stored as 8, 12, 13 or 14 digits depending on where it came from. */
        fun barcodeVariants(normalized: String): List<String> {
            val bare = normalized.trimStart('0').ifEmpty { normalized }
            return buildList {
                add(normalized)
                add(bare)
                listOf(8, 12, 13, 14)
                    .filter { it >= bare.length }
                    .forEach { add(bare.padStart(it, '0')) }
            }.distinct()
        }
    }
}
