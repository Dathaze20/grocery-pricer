package com.grocerypricer.app.backup

import android.util.Base64
import androidx.room.withTransaction
import com.grocerypricer.app.data.db.GroceryPricerDatabase
import com.grocerypricer.app.data.db.entity.OrderEntity
import com.grocerypricer.app.data.db.entity.OrderItemEntity
import com.grocerypricer.app.data.db.entity.PriceHistoryEntity
import com.grocerypricer.app.data.db.entity.PricingRuleEntity
import com.grocerypricer.app.data.db.entity.ProductEntity
import com.grocerypricer.app.data.db.entity.ReceiptImageEntity
import com.grocerypricer.app.data.db.entity.ScanHistoryEntity
import com.grocerypricer.app.data.files.ImageStore
import com.grocerypricer.app.data.model.AppSettings
import com.grocerypricer.app.data.model.ThemeMode
import com.grocerypricer.app.data.settings.SettingsRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** What a restore did, so the screen can say something concrete rather than "done". */
sealed interface RestoreResult {
    data class Success(
        val products: Int,
        val orders: Int,
        val orderItems: Int,
        val priceHistory: Int,
        val receiptImages: Int,
    ) : RestoreResult

    data class Failure(val message: String) : RestoreResult
}

/**
 * Whole-app backup and restore as a single versioned JSON document.
 *
 * The format carries its own version number so a backup taken today can still be read after the
 * database schema moves on: a future release migrates the JSON rather than being handed a raw
 * database file it cannot interpret.
 */
class BackupManager(
    private val database: GroceryPricerDatabase,
    private val settingsRepository: SettingsRepository,
    private val imageStore: ImageStore,
) {

    suspend fun createBackup(includeImages: Boolean): String = withContext(Dispatchers.IO) {
        val settings = settingsRepository.current()
        val root = JSONObject()
        root.put(KEY_FORMAT, FORMAT)
        root.put(KEY_VERSION, VERSION)
        root.put("createdAt", System.currentTimeMillis())
        root.put("appVersion", APP_VERSION)
        root.put("settings", settings.toJson())
        root.put("products", database.productDao().getAll().map { it.toJson() }.toJsonArray())
        root.put("orders", database.orderDao().getAll().map { it.toJson() }.toJsonArray())
        root.put("orderItems", database.orderItemDao().getAll().map { it.toJson() }.toJsonArray())
        root.put("receiptImages", database.receiptImageDao().getAll().map { it.toJson() }.toJsonArray())
        root.put("priceHistory", database.priceHistoryDao().getAll().map { it.toJson() }.toJsonArray())
        root.put("pricingRules", database.pricingRuleDao().getAll().map { it.toJson() }.toJsonArray())
        root.put("scanHistory", database.scanHistoryDao().getAll().map { it.toJson() }.toJsonArray())

        if (includeImages) {
            val payloads = database.receiptImageDao().getAll().mapNotNull { image ->
                val bytes = imageStore.readBytes(image.localPath) ?: return@mapNotNull null
                JSONObject().apply {
                    put("imageId", image.id)
                    put("fileName", File(image.localPath).name)
                    put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                }
            }
            root.put("receiptImageData", payloads.toJsonArray())
        }

        root.toString(2)
    }

    /**
     * Replaces everything currently stored with the contents of [json].
     *
     * Destructive by design - the screen warns first - but it either replaces the lot or leaves
     * the existing data untouched, because it all happens in one transaction.
     */
    suspend fun restore(json: String): RestoreResult = withContext(Dispatchers.IO) {
        val root = try {
            JSONObject(json)
        } catch (e: Exception) {
            return@withContext RestoreResult.Failure("This file is not a Grocery Pricer backup.")
        }

        if (root.optString(KEY_FORMAT) != FORMAT) {
            return@withContext RestoreResult.Failure("This file is not a Grocery Pricer backup.")
        }
        val version = root.optInt(KEY_VERSION, 0)
        if (version > VERSION) {
            return@withContext RestoreResult.Failure(
                "This backup was made by a newer version of Grocery Pricer (format $version). Update the app and try again."
            )
        }
        if (version < 1) {
            return@withContext RestoreResult.Failure("This backup is missing its format version.")
        }

        val products = root.optJSONArray("products").mapObjects { it.toProduct() }
        val orders = root.optJSONArray("orders").mapObjects { it.toOrder() }
        val orderItems = root.optJSONArray("orderItems").mapObjects { it.toOrderItem() }
        val receiptImages = root.optJSONArray("receiptImages").mapObjects { it.toReceiptImage() }
        val priceHistory = root.optJSONArray("priceHistory").mapObjects { it.toPriceHistory() }
        val pricingRules = root.optJSONArray("pricingRules").mapObjects { it.toPricingRule() }
        val scanHistory = root.optJSONArray("scanHistory").mapObjects { it.toScanHistory() }

        try {
            database.withTransaction {
                database.scanHistoryDao().deleteAll()
                database.priceHistoryDao().deleteAll()
                database.receiptImageDao().deleteAll()
                database.orderItemDao().deleteAll()
                database.orderDao().deleteAll()
                database.productDao().deleteAll()
                database.pricingRuleDao().deleteAll()

                products.forEach { database.productDao().insert(it) }
                orders.forEach { database.orderDao().insert(it) }
                receiptImages.forEach { database.receiptImageDao().insert(it) }
                orderItems.forEach { database.orderItemDao().insert(it) }
                database.priceHistoryDao().insertAll(priceHistory)
                database.pricingRuleDao().insertAll(pricingRules)
                database.scanHistoryDao().insertAll(scanHistory)
            }
        } catch (e: Exception) {
            return@withContext RestoreResult.Failure("The backup could not be restored: ${e.message ?: "unknown error"}")
        }

        root.optJSONObject("settings")?.let { settingsJson ->
            settingsRepository.update { settingsJson.toSettings(it) }
        }

        RestoreResult.Success(
            products = products.size,
            orders = orders.size,
            orderItems = orderItems.size,
            priceHistory = priceHistory.size,
            receiptImages = receiptImages.size,
        )
    }

    fun suggestedFileName(): String = "grocery-pricer-backup-${System.currentTimeMillis()}.json"

    // --- Serialisation -------------------------------------------------------------------------

    private fun AppSettings.toJson() = JSONObject().apply {
        put("storeName", storeName)
        put("defaultSupplier", defaultSupplier)
        put("priceEndingCents", priceEndingCents)
        put("highCostMarkupPercent", highCostMarkupPercent)
        put("minimumGrossMarginPercent", minimumGrossMarginPercent)
        put("costChangeAlertPercent", costChangeAlertPercent)
        put("cameraVibration", cameraVibration)
        put("cameraSound", cameraSound)
        put("includeImagesInBackup", includeImagesInBackup)
        put("themeMode", themeMode.name)
        put("tutorialCompleted", tutorialCompleted)
    }

    private fun JSONObject.toSettings(current: AppSettings) = current.copy(
        storeName = optString("storeName", current.storeName),
        defaultSupplier = optString("defaultSupplier", current.defaultSupplier),
        priceEndingCents = optInt("priceEndingCents", current.priceEndingCents),
        highCostMarkupPercent = optString("highCostMarkupPercent", current.highCostMarkupPercent),
        minimumGrossMarginPercent = optString("minimumGrossMarginPercent", current.minimumGrossMarginPercent),
        costChangeAlertPercent = optString("costChangeAlertPercent", current.costChangeAlertPercent),
        cameraVibration = optBoolean("cameraVibration", current.cameraVibration),
        cameraSound = optBoolean("cameraSound", current.cameraSound),
        includeImagesInBackup = optBoolean("includeImagesInBackup", current.includeImagesInBackup),
        themeMode = ThemeMode.fromName(optString("themeMode", current.themeMode.name)),
        tutorialCompleted = optBoolean("tutorialCompleted", current.tutorialCompleted),
    )

    private fun ProductEntity.toJson() = JSONObject().apply {
        put("id", id); putOrNull("upc", upc); putOrNull("supplierSku", supplierSku)
        put("name", name); put("normalizedName", normalizedName)
        putOrNull("brand", brand); putOrNull("size", size); putOrNull("unitType", unitType)
        put("category", category)
        putOrNull("lastUnitCostRaw", lastUnitCostRaw); putOrNull("lastRetailPriceRaw", lastRetailPriceRaw)
        putOrNull("overridePriceRaw", overridePriceRaw); putOrNull("lastSupplier", lastSupplier)
        putOrNull("lastPurchasedAt", lastPurchasedAt)
        put("quantityReceived", quantityReceived); put("quantityAdjustment", quantityAdjustment)
        putOrNull("notes", notes); put("createdAt", createdAt); put("updatedAt", updatedAt)
    }

    private fun JSONObject.toProduct() = ProductEntity(
        id = getLong("id"), upc = stringOrNull("upc"), supplierSku = stringOrNull("supplierSku"),
        name = optString("name", ""), normalizedName = optString("normalizedName", ""),
        brand = stringOrNull("brand"), size = stringOrNull("size"), unitType = stringOrNull("unitType"),
        category = optString("category", "OTHER"),
        lastUnitCostRaw = longOrNull("lastUnitCostRaw"), lastRetailPriceRaw = longOrNull("lastRetailPriceRaw"),
        overridePriceRaw = longOrNull("overridePriceRaw"), lastSupplier = stringOrNull("lastSupplier"),
        lastPurchasedAt = longOrNull("lastPurchasedAt"),
        quantityReceived = optInt("quantityReceived", 0), quantityAdjustment = optInt("quantityAdjustment", 0),
        notes = stringOrNull("notes"), createdAt = optLong("createdAt", 0L), updatedAt = optLong("updatedAt", 0L),
    )

    private fun OrderEntity.toJson() = JSONObject().apply {
        put("id", id); put("supplier", supplier); put("name", name); put("orderDate", orderDate)
        put("status", status); put("createdAt", createdAt); put("updatedAt", updatedAt)
    }

    private fun JSONObject.toOrder() = OrderEntity(
        id = getLong("id"), supplier = optString("supplier", ""), name = optString("name", ""),
        orderDate = optLong("orderDate", 0L), status = optString("status", "IMPORTING"),
        createdAt = optLong("createdAt", 0L), updatedAt = optLong("updatedAt", 0L),
    )

    private fun OrderItemEntity.toJson() = JSONObject().apply {
        put("id", id); put("orderId", orderId); putOrNull("productId", productId)
        put("description", description); putOrNull("upc", upc); putOrNull("supplierSku", supplierSku)
        putOrNull("size", size); put("category", category)
        put("casePriceRaw", casePriceRaw); put("unitsPerCase", unitsPerCase)
        put("casesPurchased", casesPurchased); put("looseUnits", looseUnits)
        putOrNull("printedUnitCostRaw", printedUnitCostRaw)
        putOrNull("discountDescription", discountDescription); putOrNull("discountAmountRaw", discountAmountRaw)
        put("discountScope", discountScope); putOrNull("discountUnits", discountUnits)
        put("netCaseCostRaw", netCaseCostRaw); put("trueUnitCostRaw", trueUnitCostRaw)
        put("totalWholesaleCostRaw", totalWholesaleCostRaw); put("totalUnits", totalUnits)
        putOrNull("suggestedPriceRaw", suggestedPriceRaw); putOrNull("approvedPriceRaw", approvedPriceRaw)
        put("priceApproved", priceApproved); put("confidence", confidence); put("issues", issues)
        put("reviewApproved", reviewApproved); putOrNull("receiptImageId", receiptImageId)
        put("rawText", rawText); put("quantityAdjustment", quantityAdjustment)
        put("createdAt", createdAt); put("updatedAt", updatedAt)
    }

    private fun JSONObject.toOrderItem() = OrderItemEntity(
        id = getLong("id"), orderId = getLong("orderId"), productId = longOrNull("productId"),
        description = optString("description", ""), upc = stringOrNull("upc"),
        supplierSku = stringOrNull("supplierSku"), size = stringOrNull("size"),
        category = optString("category", "OTHER"),
        casePriceRaw = optLong("casePriceRaw", 0L), unitsPerCase = optInt("unitsPerCase", 1),
        casesPurchased = optInt("casesPurchased", 1), looseUnits = optInt("looseUnits", 0),
        printedUnitCostRaw = longOrNull("printedUnitCostRaw"),
        discountDescription = stringOrNull("discountDescription"),
        discountAmountRaw = longOrNull("discountAmountRaw"),
        discountScope = optString("discountScope", "IGNORED"), discountUnits = intOrNull("discountUnits"),
        netCaseCostRaw = optLong("netCaseCostRaw", 0L), trueUnitCostRaw = optLong("trueUnitCostRaw", 0L),
        totalWholesaleCostRaw = optLong("totalWholesaleCostRaw", 0L), totalUnits = optInt("totalUnits", 0),
        suggestedPriceRaw = longOrNull("suggestedPriceRaw"), approvedPriceRaw = longOrNull("approvedPriceRaw"),
        priceApproved = optBoolean("priceApproved", false), confidence = optString("confidence", "NEEDS_REVIEW"),
        issues = optString("issues", ""), reviewApproved = optBoolean("reviewApproved", false),
        receiptImageId = longOrNull("receiptImageId"), rawText = optString("rawText", ""),
        quantityAdjustment = optInt("quantityAdjustment", 0),
        createdAt = optLong("createdAt", 0L), updatedAt = optLong("updatedAt", 0L),
    )

    private fun ReceiptImageEntity.toJson() = JSONObject().apply {
        put("id", id); put("orderId", orderId); put("localPath", localPath)
        putOrNull("sourceUri", sourceUri); put("recognizedText", recognizedText)
        put("status", status); putOrNull("errorMessage", errorMessage)
        put("lineCount", lineCount); put("position", position); put("createdAt", createdAt)
    }

    private fun JSONObject.toReceiptImage() = ReceiptImageEntity(
        id = getLong("id"), orderId = getLong("orderId"), localPath = optString("localPath", ""),
        sourceUri = stringOrNull("sourceUri"), recognizedText = optString("recognizedText", ""),
        status = optString("status", "PENDING"), errorMessage = stringOrNull("errorMessage"),
        lineCount = optInt("lineCount", 0), position = optInt("position", 0),
        createdAt = optLong("createdAt", 0L),
    )

    private fun PriceHistoryEntity.toJson() = JSONObject().apply {
        put("id", id); put("productId", productId); putOrNull("orderId", orderId)
        put("unitCostRaw", unitCostRaw); putOrNull("retailPriceRaw", retailPriceRaw)
        putOrNull("supplier", supplier); putOrNull("note", note); put("recordedAt", recordedAt)
    }

    private fun JSONObject.toPriceHistory() = PriceHistoryEntity(
        id = getLong("id"), productId = getLong("productId"), orderId = longOrNull("orderId"),
        unitCostRaw = optLong("unitCostRaw", 0L), retailPriceRaw = longOrNull("retailPriceRaw"),
        supplier = stringOrNull("supplier"), note = stringOrNull("note"),
        recordedAt = optLong("recordedAt", 0L),
    )

    private fun PricingRuleEntity.toJson() = JSONObject().apply {
        put("id", id); put("kind", kind); putOrNull("category", category)
        putOrNull("minCostRaw", minCostRaw); putOrNull("maxCostRaw", maxCostRaw)
        putOrNull("suggestedPriceRaw", suggestedPriceRaw); putOrNull("alternatePriceRaw", alternatePriceRaw)
        putOrNull("markupPercent", markupPercent); putOrNull("priceEndingCents", priceEndingCents)
        put("tierSteps", tierSteps); put("enabled", enabled); put("sortOrder", sortOrder)
    }

    private fun JSONObject.toPricingRule() = PricingRuleEntity(
        id = getLong("id"), kind = optString("kind", "TIER"), category = stringOrNull("category"),
        minCostRaw = longOrNull("minCostRaw"), maxCostRaw = longOrNull("maxCostRaw"),
        suggestedPriceRaw = longOrNull("suggestedPriceRaw"), alternatePriceRaw = longOrNull("alternatePriceRaw"),
        markupPercent = stringOrNull("markupPercent"), priceEndingCents = intOrNull("priceEndingCents"),
        tierSteps = optInt("tierSteps", 0), enabled = optBoolean("enabled", true),
        sortOrder = optInt("sortOrder", 0),
    )

    private fun ScanHistoryEntity.toJson() = JSONObject().apply {
        put("id", id); putOrNull("productId", productId); putOrNull("barcode", barcode)
        putOrNull("matchedName", matchedName); putOrNull("approvedPriceRaw", approvedPriceRaw)
        put("scannedAt", scannedAt)
    }

    private fun JSONObject.toScanHistory() = ScanHistoryEntity(
        id = getLong("id"), productId = longOrNull("productId"), barcode = stringOrNull("barcode"),
        matchedName = stringOrNull("matchedName"), approvedPriceRaw = longOrNull("approvedPriceRaw"),
        scannedAt = optLong("scannedAt", 0L),
    )

    companion object {
        const val FORMAT = "grocery-pricer-backup"
        const val VERSION = 1
        const val APP_VERSION = "1.0.0"
        private const val KEY_FORMAT = "format"
        private const val KEY_VERSION = "version"
    }
}

// --- Small JSON helpers ------------------------------------------------------------------------

private fun List<JSONObject>.toJsonArray(): JSONArray =
    JSONArray().also { array -> forEach { array.put(it) } }

private fun <T> JSONArray?.mapObjects(transform: (JSONObject) -> T): List<T> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { index ->
        optJSONObject(index)?.let { runCatching { transform(it) }.getOrNull() }
    }
}

private fun JSONObject.putOrNull(key: String, value: Any?) {
    put(key, value ?: JSONObject.NULL)
}

private fun JSONObject.stringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) getString(key) else null

private fun JSONObject.longOrNull(key: String): Long? =
    if (has(key) && !isNull(key)) getLong(key) else null

private fun JSONObject.intOrNull(key: String): Int? =
    if (has(key) && !isNull(key)) getInt(key) else null
