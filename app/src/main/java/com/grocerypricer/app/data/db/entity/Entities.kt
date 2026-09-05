package com.grocerypricer.app.data.db.entity

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * A product the store has bought at least once. This is the permanent catalogue: it is what a
 * barcode scan looks up, and it carries the last cost and last shelf price forward between orders.
 */
@Entity(
    tableName = "products",
    indices = [
        Index("upc"),
        Index("supplierSku"),
        Index("normalizedName"),
    ],
)
data class ProductEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val upc: String? = null,
    val supplierSku: String? = null,
    val name: String,
    /** Normalised form used for name matching, kept in a column so the DAO can index it. */
    val normalizedName: String,
    val brand: String? = null,
    val size: String? = null,
    val unitType: String? = null,
    val category: String,
    val lastUnitCostRaw: Long? = null,
    val lastRetailPriceRaw: Long? = null,
    /** A price pinned to this product, which overrides every pricing rule. */
    val overridePriceRaw: Long? = null,
    val lastSupplier: String? = null,
    val lastPurchasedAt: Long? = null,
    val quantityReceived: Int = 0,
    val quantityAdjustment: Int = 0,
    val notes: String? = null,
    val createdAt: Long,
    val updatedAt: Long,
)

@Entity(tableName = "orders")
data class OrderEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val supplier: String,
    val name: String,
    val orderDate: Long,
    /** One of [com.grocerypricer.app.data.model.OrderStatus]. */
    val status: String,
    val createdAt: Long,
    val updatedAt: Long,
)

/**
 * One product on one order.
 *
 * Every figure is snapshotted here rather than read back off the product, so a past order still
 * shows what was actually paid even after the catalogue moves on.
 */
@Entity(
    tableName = "order_items",
    foreignKeys = [
        ForeignKey(
            entity = OrderEntity::class,
            parentColumns = ["id"],
            childColumns = ["orderId"],
            onDelete = ForeignKey.CASCADE,
        ),
        ForeignKey(
            entity = ProductEntity::class,
            parentColumns = ["id"],
            childColumns = ["productId"],
            onDelete = ForeignKey.SET_NULL,
        ),
    ],
    indices = [Index("orderId"), Index("productId"), Index("upc")],
)
data class OrderItemEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val orderId: Long,
    val productId: Long? = null,
    val description: String,
    val upc: String? = null,
    val supplierSku: String? = null,
    val size: String? = null,
    val category: String,

    val casePriceRaw: Long,
    val unitsPerCase: Int,
    val casesPurchased: Int,
    val looseUnits: Int,
    val printedUnitCostRaw: Long? = null,

    val discountDescription: String? = null,
    val discountAmountRaw: Long? = null,
    /** One of [com.grocerypricer.core.model.DiscountScope]. */
    val discountScope: String,
    val discountUnits: Int? = null,

    val netCaseCostRaw: Long,
    val trueUnitCostRaw: Long,
    val totalWholesaleCostRaw: Long,
    val totalUnits: Int,

    val suggestedPriceRaw: Long? = null,
    val approvedPriceRaw: Long? = null,
    val priceApproved: Boolean = false,

    /** One of [com.grocerypricer.core.model.ItemConfidence]. */
    val confidence: String,
    /** Comma-separated [com.grocerypricer.core.model.ParseIssueType] names. */
    val issues: String = "",
    val reviewApproved: Boolean = false,

    val receiptImageId: Long? = null,
    val rawText: String = "",
    val quantityAdjustment: Int = 0,

    val createdAt: Long,
    val updatedAt: Long,
)

/** A receipt photograph plus whatever OCR made of it. The original stays on the device. */
@Entity(
    tableName = "receipt_images",
    foreignKeys = [
        ForeignKey(
            entity = OrderEntity::class,
            parentColumns = ["id"],
            childColumns = ["orderId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("orderId")],
)
data class ReceiptImageEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val orderId: Long,
    /** Where the copy lives inside the app's own storage. */
    val localPath: String,
    /** The picker/camera URI it came from, kept for reference. */
    val sourceUri: String? = null,
    val recognizedText: String = "",
    /** One of [com.grocerypricer.app.data.model.ImageProcessingStatus]. */
    val status: String,
    val errorMessage: String? = null,
    val lineCount: Int = 0,
    val position: Int = 0,
    val createdAt: Long,
)

/** Every cost and shelf price a product has ever had. Append-only; nothing is overwritten. */
@Entity(
    tableName = "price_history",
    foreignKeys = [
        ForeignKey(
            entity = ProductEntity::class,
            parentColumns = ["id"],
            childColumns = ["productId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("productId"), Index("recordedAt")],
)
data class PriceHistoryEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val productId: Long,
    val orderId: Long? = null,
    val unitCostRaw: Long,
    val retailPriceRaw: Long? = null,
    val supplier: String? = null,
    val note: String? = null,
    val recordedAt: Long,
)

/**
 * A row of the pricing configuration: either a cost tier or a category override.
 * The global scalars (default ending, thresholds) live in DataStore settings.
 */
@Entity(tableName = "pricing_rules", indices = [Index("kind"), Index("sortOrder")])
data class PricingRuleEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** `TIER` or `CATEGORY`. */
    val kind: String,
    val category: String? = null,
    val minCostRaw: Long? = null,
    val maxCostRaw: Long? = null,
    val suggestedPriceRaw: Long? = null,
    val alternatePriceRaw: Long? = null,
    /** BigDecimal held as text so no precision is lost. */
    val markupPercent: String? = null,
    val priceEndingCents: Int? = null,
    val tierSteps: Int = 0,
    val enabled: Boolean = true,
    val sortOrder: Int = 0,
)

/** What was scanned, when, and what it resolved to. Powers "recently priced" and nothing else. */
@Entity(tableName = "scan_history", indices = [Index("scannedAt"), Index("productId")])
data class ScanHistoryEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val productId: Long? = null,
    val barcode: String? = null,
    val matchedName: String? = null,
    val approvedPriceRaw: Long? = null,
    val scannedAt: Long,
)
