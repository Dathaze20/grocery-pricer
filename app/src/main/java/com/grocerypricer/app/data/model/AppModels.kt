package com.grocerypricer.app.data.model

import com.grocerypricer.core.matching.MatchableProduct
import com.grocerypricer.core.model.Category
import com.grocerypricer.core.model.CostBreakdown
import com.grocerypricer.core.model.ItemConfidence
import com.grocerypricer.core.model.ParseIssueType
import com.grocerypricer.core.model.ReceiptDiscount
import com.grocerypricer.core.money.Money
import java.math.BigDecimal

enum class OrderStatus(val displayName: String) {
    /** Photos are still being added and read. */
    IMPORTING("Importing"),

    /** OCR is done; the user is checking the numbers. */
    REVIEWING("Needs review"),

    /** Approved and saved; this is the order being priced in the store. */
    ACTIVE("Active"),

    /** Everything has an approved shelf price. */
    COMPLETED("Completed");

    companion object {
        fun fromName(value: String?): OrderStatus =
            entries.firstOrNull { it.name == value } ?: IMPORTING
    }
}

enum class ImageProcessingStatus(val displayName: String) {
    PENDING("Waiting"),
    PROCESSING("Reading"),
    DONE("Read"),
    FAILED("Could not read");

    companion object {
        fun fromName(value: String?): ImageProcessingStatus =
            entries.firstOrNull { it.name == value } ?: PENDING
    }
}

enum class ThemeMode(val displayName: String) {
    SYSTEM("System"),
    LIGHT("Light"),
    DARK("Dark");

    companion object {
        fun fromName(value: String?): ThemeMode =
            entries.firstOrNull { it.name == value } ?: SYSTEM
    }
}

data class Product(
    val id: Long = 0,
    override val upc: String? = null,
    override val supplierSku: String? = null,
    override val name: String,
    override val size: String? = null,
    val brand: String? = null,
    val unitType: String? = null,
    val category: Category = Category.OTHER,
    val lastUnitCost: Money? = null,
    val lastRetailPrice: Money? = null,
    val overridePrice: Money? = null,
    val lastSupplier: String? = null,
    val lastPurchasedAt: Long? = null,
    val quantityReceived: Int = 0,
    val quantityAdjustment: Int = 0,
    val notes: String? = null,
) : MatchableProduct {
    override val productId: Long get() = id

    /** Received minus any manual correction the user made while counting the shelf. */
    val quantityOnHand: Int get() = quantityReceived + quantityAdjustment

    val displayName: String
        get() = listOfNotNull(name.takeIf { it.isNotBlank() }, size).joinToString(" ")
}

data class Order(
    val id: Long = 0,
    val supplier: String,
    val name: String,
    val orderDate: Long,
    val status: OrderStatus = OrderStatus.IMPORTING,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
)

data class ReceiptImage(
    val id: Long = 0,
    val orderId: Long,
    val localPath: String,
    val sourceUri: String? = null,
    val recognizedText: String = "",
    val status: ImageProcessingStatus = ImageProcessingStatus.PENDING,
    val errorMessage: String? = null,
    val lineCount: Int = 0,
    val position: Int = 0,
)

data class OrderItem(
    val id: Long = 0,
    val orderId: Long,
    val productId: Long? = null,
    val description: String,
    val upc: String? = null,
    val supplierSku: String? = null,
    val size: String? = null,
    val category: Category = Category.OTHER,
    val casePrice: Money,
    val unitsPerCase: Int,
    val casesPurchased: Int = 1,
    val looseUnits: Int = 0,
    val printedUnitCost: Money? = null,
    val discount: ReceiptDiscount? = null,
    val cost: CostBreakdown,
    val suggestedPrice: Money? = null,
    val approvedPrice: Money? = null,
    val priceApproved: Boolean = false,
    val confidence: ItemConfidence = ItemConfidence.HIGH,
    val issues: List<ParseIssueType> = emptyList(),
    val reviewApproved: Boolean = false,
    val receiptImageId: Long? = null,
    val rawText: String = "",
    val quantityAdjustment: Int = 0,
) {
    val unitCost: Money get() = cost.trueUnitCost
    val displayUnitCost: Money get() = cost.displayUnitCost
    val effectivePrice: Money? get() = approvedPrice ?: suggestedPrice
    val displayName: String get() = listOfNotNull(description.takeIf { it.isNotBlank() }, size).joinToString(" ")
}

data class PriceHistoryEntry(
    val id: Long = 0,
    val productId: Long,
    val orderId: Long? = null,
    val unitCost: Money,
    val retailPrice: Money? = null,
    val supplier: String? = null,
    val note: String? = null,
    val recordedAt: Long,
)

data class ScanRecord(
    val id: Long = 0,
    val productId: Long? = null,
    val barcode: String? = null,
    val matchedName: String? = null,
    val approvedPrice: Money? = null,
    val scannedAt: Long,
)

/** Everything the order summary screen needs, computed in one pass over the items. */
data class OrderSummary(
    val productCount: Int = 0,
    val casesPurchased: Int = 0,
    val totalUnits: Int = 0,
    val wholesaleTotal: Money = Money.ZERO,
    val estimatedRetailTotal: Money = Money.ZERO,
    val estimatedGrossProfit: Money = Money.ZERO,
    val averageGrossMarginPercent: BigDecimal? = null,
    val pricedCount: Int = 0,
    val unpricedCount: Int = 0,
    val lowMarginCount: Int = 0,
    val uncertainCount: Int = 0,
)

/** A product whose wholesale cost moved between orders. */
data class CostMovement(
    val item: OrderItem,
    val previousCost: Money,
    val changeAmount: Money,
    val changePercent: BigDecimal?,
)

/** Store-wide preferences. Held in DataStore rather than the database. */
data class AppSettings(
    val storeName: String = "",
    val defaultSupplier: String = "Jetro / Restaurant Depot",
    val priceEndingCents: Int = 99,
    val highCostMarkupPercent: String = "60",
    val minimumGrossMarginPercent: String = "30",
    val costChangeAlertPercent: String = "10",
    val cameraVibration: Boolean = true,
    val cameraSound: Boolean = false,
    val includeImagesInBackup: Boolean = false,
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val tutorialCompleted: Boolean = false,
    val currentOrderId: Long = 0,
)
