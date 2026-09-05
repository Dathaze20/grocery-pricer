package com.grocerypricer.app.data.repository

import androidx.room.withTransaction
import com.grocerypricer.app.data.db.GroceryPricerDatabase
import com.grocerypricer.app.data.db.entity.PriceHistoryEntity
import com.grocerypricer.app.data.db.entity.ReceiptImageEntity
import com.grocerypricer.app.data.db.toDomain
import com.grocerypricer.app.data.db.toEntity
import com.grocerypricer.app.data.model.CostMovement
import com.grocerypricer.app.data.model.ImageProcessingStatus
import com.grocerypricer.app.data.model.Order
import com.grocerypricer.app.data.model.OrderItem
import com.grocerypricer.app.data.model.OrderStatus
import com.grocerypricer.app.data.model.OrderSummary
import com.grocerypricer.app.data.model.Product
import com.grocerypricer.app.data.model.ReceiptImage
import com.grocerypricer.core.matching.MatchOutcome
import com.grocerypricer.core.matching.NameNormalizer
import com.grocerypricer.core.matching.ProductMatcher
import com.grocerypricer.core.matching.ProductQuery
import com.grocerypricer.core.matching.SizeParser
import com.grocerypricer.core.model.Category
import com.grocerypricer.core.model.ItemConfidence
import com.grocerypricer.core.model.ParsedReceiptItem
import com.grocerypricer.core.model.PricingRules
import com.grocerypricer.core.model.ReceiptLine
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.parser.ReceiptParser
import com.grocerypricer.core.pricing.CostCalculator
import com.grocerypricer.core.pricing.PricingEngine
import com.grocerypricer.core.pricing.ProfitCalculator
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * Everything an order goes through: photos in, OCR text parsed, rows reviewed, then committed to
 * the permanent catalogue.
 *
 * Saving an order touches products, price history and the order rows together, so it runs inside
 * a single database transaction - a half-saved order would leave the catalogue lying about costs.
 */
class OrderRepository(
    private val database: GroceryPricerDatabase,
    private val productRepository: ProductRepository,
    private val now: () -> Long = System::currentTimeMillis,
) {

    private val orderDao = database.orderDao()
    private val orderItemDao = database.orderItemDao()
    private val receiptImageDao = database.receiptImageDao()
    private val priceHistoryDao = database.priceHistoryDao()
    private val productDao = database.productDao()

    // --- Orders --------------------------------------------------------------------------------

    suspend fun createOrder(supplier: String, name: String, orderDate: Long): Long {
        val timestamp = now()
        return orderDao.insert(
            Order(
                supplier = supplier,
                name = name,
                orderDate = orderDate,
                status = OrderStatus.IMPORTING,
                createdAt = timestamp,
                updatedAt = timestamp,
            ).toEntity()
        )
    }

    fun observeOrders(): Flow<List<Order>> = orderDao.observeAll().map { rows -> rows.map { it.toDomain() } }

    fun observeOrder(orderId: Long): Flow<Order?> = orderDao.observeById(orderId).map { it?.toDomain() }

    suspend fun getOrder(orderId: Long): Order? = orderDao.getById(orderId)?.toDomain()

    suspend fun updateOrder(order: Order) {
        orderDao.update(order.copy(updatedAt = now()).toEntity())
    }

    /** Deleting an order takes its items and receipt photos with it, by foreign key. */
    suspend fun deleteOrder(orderId: Long) {
        orderDao.getById(orderId)?.let { orderDao.delete(it) }
    }

    // --- Receipt images ------------------------------------------------------------------------

    fun observeReceiptImages(orderId: Long): Flow<List<ReceiptImage>> =
        receiptImageDao.observeByOrder(orderId).map { rows -> rows.map { it.toDomain() } }

    suspend fun addReceiptImage(orderId: Long, localPath: String, sourceUri: String?): Long {
        val position = receiptImageDao.getByOrder(orderId).size
        return receiptImageDao.insert(
            ReceiptImageEntity(
                orderId = orderId,
                localPath = localPath,
                sourceUri = sourceUri,
                status = ImageProcessingStatus.PENDING.name,
                position = position,
                createdAt = now(),
            )
        )
    }

    suspend fun markImageProcessing(imageId: Long) {
        val existing = receiptImageDao.getById(imageId) ?: return
        receiptImageDao.update(existing.copy(status = ImageProcessingStatus.PROCESSING.name))
    }

    suspend fun saveImageText(imageId: Long, text: String) {
        val existing = receiptImageDao.getById(imageId) ?: return
        receiptImageDao.update(
            existing.copy(
                recognizedText = text,
                status = ImageProcessingStatus.DONE.name,
                errorMessage = null,
                lineCount = text.split("\n").count { it.isNotBlank() },
            )
        )
    }

    suspend fun saveImageFailure(imageId: Long, message: String) {
        val existing = receiptImageDao.getById(imageId) ?: return
        receiptImageDao.update(
            existing.copy(status = ImageProcessingStatus.FAILED.name, errorMessage = message)
        )
    }

    suspend fun deleteReceiptImage(imageId: Long) {
        receiptImageDao.getById(imageId)?.let { receiptImageDao.delete(it) }
    }

    // --- Parsing -------------------------------------------------------------------------------

    /**
     * Re-reads every photo on the order as one continuous receipt and replaces the order's rows.
     *
     * Lines keep the image they came from so overlapping photographs can be spotted.
     */
    suspend fun reparseOrder(orderId: Long, rules: PricingRules): Int {
        val images = receiptImageDao.getByOrder(orderId)
            .filter { it.status == ImageProcessingStatus.DONE.name && it.recognizedText.isNotBlank() }

        val lines = mutableListOf<ReceiptLine>()
        images.forEach { image ->
            lines += ReceiptParser.toLines(image.recognizedText, imageId = image.id, startIndex = lines.size)
        }
        val parsed = ReceiptParser.parse(lines)

        val catalogue = productRepository.getAll()
        val engine = PricingEngine(rules)
        val items = parsed.items.map { toOrderItem(it, orderId, catalogue, engine) }

        database.withTransaction {
            orderItemDao.deleteByOrder(orderId)
            val timestamp = now()
            orderItemDao.insertAll(items.map { it.toEntity(timestamp, timestamp) })
            orderDao.getById(orderId)?.let {
                orderDao.update(it.copy(status = OrderStatus.REVIEWING.name, updatedAt = timestamp))
            }
        }
        return items.size
    }

    private fun toOrderItem(
        parsed: ParsedReceiptItem,
        orderId: Long,
        catalogue: List<Product>,
        engine: PricingEngine,
    ): OrderItem {
        val casePrice = parsed.casePrice ?: Money.ZERO
        val unitsPerCase = parsed.unitsPerCase?.takeIf { it > 0 } ?: 1
        val cost = CostCalculator.calculate(
            casePrice = casePrice,
            unitsPerCase = unitsPerCase,
            casesPurchased = parsed.casesPurchased.coerceAtLeast(0),
            looseUnits = parsed.looseUnits.coerceAtLeast(0),
            discount = parsed.discount,
        )
        val match = ProductMatcher.match(
            ProductQuery(
                upc = parsed.upc,
                supplierSku = parsed.supplierSku,
                name = parsed.description,
                size = parsed.packageSize,
            ),
            catalogue,
        )
        // Only a confident match links a receipt row to an existing product; a guess would carry
        // the wrong previous price into the suggestion.
        val product = (match as? MatchOutcome.Confident)?.match?.product as? Product

        val suggestion = engine.suggest(
            unitCost = cost.trueUnitCost.takeIf { it.isPositive },
            category = parsed.category,
            previousRetailPrice = product?.lastRetailPrice,
            productOverridePrice = product?.overridePrice,
        )

        return OrderItem(
            orderId = orderId,
            productId = product?.id,
            description = parsed.description.orEmpty(),
            upc = parsed.upc,
            supplierSku = parsed.supplierSku,
            size = parsed.packageSize,
            category = parsed.category,
            casePrice = casePrice,
            unitsPerCase = unitsPerCase,
            casesPurchased = parsed.casesPurchased,
            looseUnits = parsed.looseUnits,
            printedUnitCost = parsed.printedUnitCost,
            discount = parsed.discount,
            cost = cost,
            suggestedPrice = suggestion.suggestedPrice.takeIf { it.isPositive },
            approvedPrice = null,
            priceApproved = false,
            confidence = parsed.confidence,
            issues = parsed.issues.map { it.type },
            reviewApproved = false,
            rawText = parsed.rawText,
        )
    }

    // --- Order items ---------------------------------------------------------------------------

    fun observeItems(orderId: Long): Flow<List<OrderItem>> =
        orderItemDao.observeByOrder(orderId).map { rows -> rows.map { it.toDomain() } }

    suspend fun getItems(orderId: Long): List<OrderItem> =
        orderItemDao.getByOrder(orderId).map { it.toDomain() }

    suspend fun getItem(itemId: Long): OrderItem? = orderItemDao.getById(itemId)?.toDomain()

    /** Saves an edited row, re-costing and re-suggesting from the values the user just typed. */
    suspend fun saveItem(item: OrderItem, rules: PricingRules) {
        val existing = orderItemDao.getById(item.id)
        val recosted = recost(item, rules)
        orderItemDao.update(
            recosted.toEntity(
                createdAt = existing?.createdAt ?: now(),
                updatedAt = now(),
            )
        )
    }

    suspend fun addManualItem(orderId: Long, item: OrderItem, rules: PricingRules): Long {
        val timestamp = now()
        val recosted = recost(item.copy(orderId = orderId, reviewApproved = true), rules)
        return orderItemDao.insert(recosted.toEntity(timestamp, timestamp))
    }

    suspend fun deleteItem(itemId: Long) {
        orderItemDao.getById(itemId)?.let { orderItemDao.delete(it) }
    }

    private suspend fun recost(item: OrderItem, rules: PricingRules): OrderItem {
        val unitsPerCase = item.unitsPerCase.coerceAtLeast(1)
        val cost = CostCalculator.calculate(
            casePrice = item.casePrice,
            unitsPerCase = unitsPerCase,
            casesPurchased = item.casesPurchased.coerceAtLeast(0),
            looseUnits = item.looseUnits.coerceAtLeast(0),
            discount = item.discount,
        )
        val product = item.productId?.let { productRepository.getById(it) }
        val suggestion = PricingEngine(rules).suggest(
            unitCost = cost.trueUnitCost.takeIf { it.isPositive },
            category = item.category,
            previousRetailPrice = product?.lastRetailPrice,
            productOverridePrice = product?.overridePrice,
        )
        return item.copy(
            unitsPerCase = unitsPerCase,
            cost = cost,
            suggestedPrice = suggestion.suggestedPrice.takeIf { it.isPositive },
        )
    }

    suspend fun setReviewApproved(itemId: Long, approved: Boolean) {
        val entity = orderItemDao.getById(itemId) ?: return
        orderItemDao.update(entity.copy(reviewApproved = approved, updatedAt = now()))
    }

    /** Bulk approval, deliberately limited to rows nothing was flagged on. */
    suspend fun approveAllHighConfidence(orderId: Long): Int {
        val rows = orderItemDao.getByOrder(orderId)
            .filter { it.confidence == ItemConfidence.HIGH.name && !it.reviewApproved }
        if (rows.isEmpty()) return 0
        orderItemDao.updateAll(rows.map { it.copy(reviewApproved = true, updatedAt = now()) })
        return rows.size
    }

    // --- Pricing -------------------------------------------------------------------------------

    /**
     * Records the shelf price the user approved: on the order row, on the product, and against the
     * price-history entry this order created.
     */
    suspend fun approvePrice(itemId: Long, price: Money) {
        database.withTransaction {
            val entity = orderItemDao.getById(itemId) ?: return@withTransaction
            orderItemDao.update(
                entity.copy(
                    approvedPriceRaw = price.toStorageLong(),
                    priceApproved = true,
                    updatedAt = now(),
                )
            )
            val productId = entity.productId ?: return@withTransaction
            productDao.getById(productId)?.let { product ->
                productDao.update(
                    product.copy(lastRetailPriceRaw = price.toStorageLong(), updatedAt = now())
                )
            }
            priceHistoryDao.setRetailPriceForOrder(productId, entity.orderId, price.toStorageLong())
        }
    }

    // --- Committing ----------------------------------------------------------------------------

    /**
     * Writes the approved rows into the permanent catalogue.
     *
     * Existing products are updated and a price-history entry is appended; nothing in the history
     * is ever overwritten. Runs as one transaction.
     */
    suspend fun commitOrder(orderId: Long): Int {
        val order = orderDao.getById(orderId) ?: return 0
        val rows = orderItemDao.getByOrder(orderId).filter { it.reviewApproved }
        if (rows.isEmpty()) return 0

        var saved = 0
        database.withTransaction {
            val catalogue = productDao.getAll().map { it.toDomain() }.toMutableList()
            rows.forEach { row ->
                val item = row.toDomain()
                val existing = item.productId?.let { id -> catalogue.firstOrNull { it.id == id } }
                    ?: findExisting(item, catalogue)

                val timestamp = now()
                val productId = if (existing == null) {
                    val created = Product(
                        upc = item.upc,
                        supplierSku = item.supplierSku,
                        name = item.description.ifBlank { "Unnamed product" },
                        size = item.size,
                        category = item.category,
                        lastUnitCost = item.cost.trueUnitCost,
                        lastRetailPrice = item.approvedPrice,
                        lastSupplier = order.supplier,
                        lastPurchasedAt = order.orderDate,
                        quantityReceived = item.cost.totalUnits,
                    )
                    val newId = productDao.insert(created.toEntity(timestamp, timestamp))
                    catalogue += created.copy(id = newId)
                    newId
                } else {
                    val updated = existing.copy(
                        upc = item.upc ?: existing.upc,
                        supplierSku = item.supplierSku ?: existing.supplierSku,
                        size = item.size ?: existing.size,
                        category = if (existing.category == Category.OTHER) item.category else existing.category,
                        lastUnitCost = item.cost.trueUnitCost,
                        lastRetailPrice = item.approvedPrice ?: existing.lastRetailPrice,
                        lastSupplier = order.supplier,
                        lastPurchasedAt = order.orderDate,
                        quantityReceived = existing.quantityReceived + item.cost.totalUnits,
                    )
                    productDao.getById(existing.id)?.let { row2 ->
                        productDao.update(updated.toEntity(row2.createdAt, timestamp))
                    }
                    val index = catalogue.indexOfFirst { it.id == existing.id }
                    if (index >= 0) catalogue[index] = updated
                    existing.id
                }

                priceHistoryDao.insert(
                    PriceHistoryEntity(
                        productId = productId,
                        orderId = orderId,
                        unitCostRaw = item.cost.trueUnitCost.toStorageLong(),
                        retailPriceRaw = item.approvedPrice?.toStorageLong(),
                        supplier = order.supplier,
                        note = order.name,
                        recordedAt = order.orderDate,
                    )
                )

                orderItemDao.update(row.copy(productId = productId, updatedAt = timestamp))
                saved++
            }

            orderDao.update(order.copy(status = OrderStatus.ACTIVE.name, updatedAt = now()))
        }
        return saved
    }

    private fun findExisting(item: OrderItem, catalogue: List<Product>): Product? {
        val outcome = ProductMatcher.match(
            ProductQuery(
                upc = item.upc,
                supplierSku = item.supplierSku,
                name = item.description,
                size = item.size ?: SizeParser.canonicalOrNull(item.description),
            ),
            catalogue,
        )
        return (outcome as? MatchOutcome.Confident)?.match?.product as? Product
    }

    // --- Lookups while pricing in the store ----------------------------------------------------

    /** A barcode is checked against the order being priced before the whole catalogue. */
    suspend fun findInOrderByBarcode(orderId: Long, barcode: String): OrderItem? {
        val normalized = ProductMatcher.normalizeUpc(barcode) ?: return null
        val variants = ProductRepository.barcodeVariants(normalized)
        val direct = orderItemDao.findInOrderByBarcode(
            orderId = orderId,
            barcode = variants.getOrElse(0) { normalized },
            alternateBarcode = variants.getOrElse(1) { normalized },
        )
        if (direct.isNotEmpty()) return direct.first().toDomain()
        return getItems(orderId).firstOrNull { item ->
            item.upc != null && ProductMatcher.upcEquivalent(
                ProductMatcher.normalizeUpc(item.upc),
                normalized,
            )
        }
    }

    suspend fun findInOrderByProduct(orderId: Long, productId: Long): OrderItem? =
        getItems(orderId).firstOrNull { it.productId == productId }

    suspend fun searchInOrder(orderId: Long, term: String): List<OrderItem> {
        val needle = term.trim().lowercase()
        if (needle.isEmpty()) return emptyList()
        val words = needle.split(" ").filter { it.isNotBlank() }
        return getItems(orderId).filter { item ->
            val haystack = listOfNotNull(item.description, item.size, item.upc, item.supplierSku)
                .joinToString(" ").lowercase()
            words.all { haystack.contains(it) }
        }
    }

    /** Matching from label words, restricted to the order currently being priced. */
    suspend fun identifyInOrderFromLabel(orderId: Long, labelText: String): List<OrderItem> {
        val items = getItems(orderId)
        if (items.isEmpty()) return emptyList()
        val size = SizeParser.canonicalOrNull(labelText)
        return items
            .map { it to NameNormalizer.similarity(labelText, it.description) }
            .filter { (item, score) ->
                score >= ProductMatcher.CANDIDATE_SCORE &&
                    ProductMatcher.sizeRelation(size, item.size) != com.grocerypricer.core.matching.SizeRelation.MISMATCH
            }
            .sortedByDescending { it.second }
            .take(5)
            .map { it.first }
    }

    // --- Summaries -----------------------------------------------------------------------------

    fun summarise(items: List<OrderItem>, rules: PricingRules): OrderSummary {
        if (items.isEmpty()) return OrderSummary()
        val wholesale = Money.sum(items.map { it.cost.totalWholesaleCost })
        val retail = Money.sum(
            items.map { item ->
                val price = item.effectivePrice ?: Money.ZERO
                price * item.cost.totalUnits
            }
        )
        val priced = items.count { it.priceApproved }
        val lowMargin = items.count { item ->
            val price = item.effectivePrice ?: return@count false
            val margin = ProfitCalculator.grossMarginPercent(item.cost.trueUnitCost, price)
            margin != null && margin < rules.minimumGrossMarginPercent
        }
        return OrderSummary(
            productCount = items.size,
            casesPurchased = items.sumOf { it.casesPurchased },
            totalUnits = items.sumOf { it.cost.totalUnits },
            wholesaleTotal = wholesale,
            estimatedRetailTotal = retail,
            estimatedGrossProfit = retail - wholesale,
            averageGrossMarginPercent = ProfitCalculator.averageGrossMarginPercent(wholesale, retail),
            pricedCount = priced,
            unpricedCount = items.size - priced,
            lowMarginCount = lowMargin,
            uncertainCount = items.count { it.confidence != ItemConfidence.HIGH },
        )
    }

    /** Products on this order whose wholesale cost moved by more than the alert threshold. */
    suspend fun costMovements(orderId: Long, rules: PricingRules): List<CostMovement> {
        val order = getOrder(orderId) ?: return emptyList()
        return getItems(orderId).mapNotNull { item ->
            val productId = item.productId ?: return@mapNotNull null
            val previous = productRepository.previousCost(productId, order.orderDate) ?: return@mapNotNull null
            val change = ProfitCalculator.compareCost(previous, item.cost.trueUnitCost, rules.costChangeAlertPercent)
            if (!change.exceedsThreshold) return@mapNotNull null
            CostMovement(item, previous, change.changeAmount, change.changePercent)
        }.sortedByDescending { it.changeAmount.amount }
    }
}
