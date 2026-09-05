package com.grocerypricer.app.data.db

import com.grocerypricer.app.data.db.entity.OrderEntity
import com.grocerypricer.app.data.db.entity.OrderItemEntity
import com.grocerypricer.app.data.db.entity.PriceHistoryEntity
import com.grocerypricer.app.data.db.entity.ProductEntity
import com.grocerypricer.app.data.db.entity.ReceiptImageEntity
import com.grocerypricer.app.data.db.entity.ScanHistoryEntity
import com.grocerypricer.app.data.model.ImageProcessingStatus
import com.grocerypricer.app.data.model.Order
import com.grocerypricer.app.data.model.OrderItem
import com.grocerypricer.app.data.model.OrderStatus
import com.grocerypricer.app.data.model.PriceHistoryEntry
import com.grocerypricer.app.data.model.Product
import com.grocerypricer.app.data.model.ReceiptImage
import com.grocerypricer.app.data.model.ScanRecord
import com.grocerypricer.core.matching.NameNormalizer
import com.grocerypricer.core.model.Category
import com.grocerypricer.core.model.DiscountScope
import com.grocerypricer.core.model.ItemConfidence
import com.grocerypricer.core.model.ParseIssueType
import com.grocerypricer.core.model.ReceiptDiscount
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.pricing.CostCalculator

/**
 * Entity/domain conversion.
 *
 * Cost figures are recomputed from the stored inputs on the way out rather than trusted from the
 * stored totals, so a row can never drift away from what its own numbers say.
 */

fun ProductEntity.toDomain(): Product = Product(
    id = id,
    upc = upc,
    supplierSku = supplierSku,
    name = name,
    size = size,
    brand = brand,
    unitType = unitType,
    category = Category.fromNameOrOther(category),
    lastUnitCost = lastUnitCostRaw.toMoneyOrNull(),
    lastRetailPrice = lastRetailPriceRaw.toMoneyOrNull(),
    overridePrice = overridePriceRaw.toMoneyOrNull(),
    lastSupplier = lastSupplier,
    lastPurchasedAt = lastPurchasedAt,
    quantityReceived = quantityReceived,
    quantityAdjustment = quantityAdjustment,
    notes = notes,
)

fun Product.toEntity(createdAt: Long, updatedAt: Long): ProductEntity = ProductEntity(
    id = id,
    upc = upc?.takeIf { it.isNotBlank() },
    supplierSku = supplierSku?.takeIf { it.isNotBlank() },
    name = name,
    normalizedName = NameNormalizer.normalize(name),
    brand = brand,
    size = size,
    unitType = unitType,
    category = category.name,
    lastUnitCostRaw = lastUnitCost.toColumn(),
    lastRetailPriceRaw = lastRetailPrice.toColumn(),
    overridePriceRaw = overridePrice.toColumn(),
    lastSupplier = lastSupplier,
    lastPurchasedAt = lastPurchasedAt,
    quantityReceived = quantityReceived,
    quantityAdjustment = quantityAdjustment,
    notes = notes,
    createdAt = createdAt,
    updatedAt = updatedAt,
)

fun OrderEntity.toDomain(): Order = Order(
    id = id,
    supplier = supplier,
    name = name,
    orderDate = orderDate,
    status = OrderStatus.fromName(status),
    createdAt = createdAt,
    updatedAt = updatedAt,
)

fun Order.toEntity(): OrderEntity = OrderEntity(
    id = id,
    supplier = supplier,
    name = name,
    orderDate = orderDate,
    status = status.name,
    createdAt = createdAt,
    updatedAt = updatedAt,
)

fun ReceiptImageEntity.toDomain(): ReceiptImage = ReceiptImage(
    id = id,
    orderId = orderId,
    localPath = localPath,
    sourceUri = sourceUri,
    recognizedText = recognizedText,
    status = ImageProcessingStatus.fromName(status),
    errorMessage = errorMessage,
    lineCount = lineCount,
    position = position,
)

fun OrderItemEntity.toDomain(): OrderItem {
    val discount = discountAmountRaw?.let { raw ->
        ReceiptDiscount(
            description = discountDescription.orEmpty().ifBlank { "Discount" },
            amount = raw.toMoney(),
            scope = runCatching { DiscountScope.valueOf(discountScope) }.getOrDefault(DiscountScope.UNKNOWN),
            appliesToUnits = discountUnits,
        )
    }
    val casePrice = casePriceRaw.toMoney()
    val safeUnits = unitsPerCase.coerceAtLeast(1)
    val cost = CostCalculator.calculate(
        casePrice = casePrice,
        unitsPerCase = safeUnits,
        casesPurchased = casesPurchased.coerceAtLeast(0),
        looseUnits = looseUnits.coerceAtLeast(0),
        discount = discount,
    )
    return OrderItem(
        id = id,
        orderId = orderId,
        productId = productId,
        description = description,
        upc = upc,
        supplierSku = supplierSku,
        size = size,
        category = Category.fromNameOrOther(category),
        casePrice = casePrice,
        unitsPerCase = safeUnits,
        casesPurchased = casesPurchased,
        looseUnits = looseUnits,
        printedUnitCost = printedUnitCostRaw.toMoneyOrNull(),
        discount = discount,
        cost = cost,
        suggestedPrice = suggestedPriceRaw.toMoneyOrNull(),
        approvedPrice = approvedPriceRaw.toMoneyOrNull(),
        priceApproved = priceApproved,
        confidence = runCatching { ItemConfidence.valueOf(confidence) }.getOrDefault(ItemConfidence.NEEDS_REVIEW),
        issues = issues.split(",").mapNotNull { name ->
            name.trim().takeIf { it.isNotEmpty() }?.let { runCatching { ParseIssueType.valueOf(it) }.getOrNull() }
        },
        reviewApproved = reviewApproved,
        receiptImageId = receiptImageId,
        rawText = rawText,
        quantityAdjustment = quantityAdjustment,
    )
}

fun OrderItem.toEntity(createdAt: Long, updatedAt: Long): OrderItemEntity = OrderItemEntity(
    id = id,
    orderId = orderId,
    productId = productId,
    description = description,
    upc = upc?.takeIf { it.isNotBlank() },
    supplierSku = supplierSku?.takeIf { it.isNotBlank() },
    size = size,
    category = category.name,
    casePriceRaw = casePrice.toColumnRequired(),
    unitsPerCase = unitsPerCase,
    casesPurchased = casesPurchased,
    looseUnits = looseUnits,
    printedUnitCostRaw = printedUnitCost.toColumn(),
    discountDescription = discount?.description,
    discountAmountRaw = discount?.amount.toColumn(),
    discountScope = (discount?.scope ?: DiscountScope.IGNORED).name,
    discountUnits = discount?.appliesToUnits,
    netCaseCostRaw = cost.netCaseCost.toColumnRequired(),
    trueUnitCostRaw = cost.trueUnitCost.toColumnRequired(),
    totalWholesaleCostRaw = cost.totalWholesaleCost.toColumnRequired(),
    totalUnits = cost.totalUnits,
    suggestedPriceRaw = suggestedPrice.toColumn(),
    approvedPriceRaw = approvedPrice.toColumn(),
    priceApproved = priceApproved,
    confidence = confidence.name,
    issues = issues.joinToString(",") { it.name },
    reviewApproved = reviewApproved,
    receiptImageId = receiptImageId,
    rawText = rawText,
    quantityAdjustment = quantityAdjustment,
    createdAt = createdAt,
    updatedAt = updatedAt,
)

fun PriceHistoryEntity.toDomain(): PriceHistoryEntry = PriceHistoryEntry(
    id = id,
    productId = productId,
    orderId = orderId,
    unitCost = unitCostRaw.toMoney(),
    retailPrice = retailPriceRaw.toMoneyOrNull(),
    supplier = supplier,
    note = note,
    recordedAt = recordedAt,
)

fun PriceHistoryEntry.toEntity(): PriceHistoryEntity = PriceHistoryEntity(
    id = id,
    productId = productId,
    orderId = orderId,
    unitCostRaw = unitCost.toColumnRequired(),
    retailPriceRaw = retailPrice.toColumn(),
    supplier = supplier,
    note = note,
    recordedAt = recordedAt,
)

fun ScanHistoryEntity.toDomain(): ScanRecord = ScanRecord(
    id = id,
    productId = productId,
    barcode = barcode,
    matchedName = matchedName,
    approvedPrice = approvedPriceRaw.toMoneyOrNull(),
    scannedAt = scannedAt,
)
