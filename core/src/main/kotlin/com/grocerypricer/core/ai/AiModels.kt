package com.grocerypricer.core.ai

/**
 * What a multimodal model claims it read off a receipt.
 *
 * Nothing in this file is authoritative money. Every figure arrives as the text the model says it
 * saw printed, and it stays text until the deterministic Kotlin engine has parsed and recomputed
 * it. The model is allowed to decide *which characters are on the page*; it is never allowed to
 * decide what a case costs.
 */
data class AiOrderExtraction(
    val supplier: String?,
    val items: List<AiExtractedItem>,
    val warnings: List<String> = emptyList(),
)

/**
 * One product the model believes it found.
 *
 * Every money field is a [String] on purpose. Handing back a `Double` would invite somebody to do
 * arithmetic on it, and the whole point of the architecture is that arithmetic happens exactly
 * once, in [com.grocerypricer.core.money.Money].
 */
data class AiExtractedItem(
    /** The product name exactly as printed, OCR mangling included. */
    val rawName: String?,
    /** The model's reading of what that name means, e.g. `HELLM MAYONNAISE 8Z` -> `Hellmann's Mayonnaise`. */
    val canonicalName: String?,
    val brand: String? = null,
    val size: String? = null,
    val upc: String? = null,
    val supplierSku: String? = null,
    val casePrice: String? = null,
    val unitsPerCase: Int? = null,
    val printedUnitCost: String? = null,
    val casesPurchased: Int? = null,
    val discount: AiExtractedDiscount? = null,
    val category: String? = null,
    /** Which imported photographs this item was read from. Kept so an answer can be traced back. */
    val sourcePhotoIds: List<Long> = emptyList(),
    /** The receipt lines behind this item, verbatim. */
    val sourceText: List<String> = emptyList(),
    /** The model's own confidence, 0.0 to 1.0. */
    val confidence: Double = 0.0,
)

data class AiExtractedDiscount(
    val amount: String? = null,
    /** Matches [com.grocerypricer.core.model.DiscountScope] names; anything else becomes UNKNOWN. */
    val scope: String? = null,
    val appliesToUnits: Int? = null,
)

/** How an imported photograph was classified before extraction ran. */
enum class OrderImageType {
    RECEIPT,
    CASE_LABEL,
    PRODUCT_PHOTO,
    UNKNOWN,
    ;

    companion object {
        fun fromNameOrUnknown(raw: String?): OrderImageType =
            entries.firstOrNull { it.name.equals(raw?.trim(), ignoreCase = true) } ?: UNKNOWN
    }
}

data class AiImageClassification(
    val photoId: Long,
    val type: OrderImageType,
    val confidence: Double = 0.0,
)

/** One product the model says it can see in a photograph the user attached to the conversation. */
data class AiVisualProduct(
    val brand: String? = null,
    val productName: String? = null,
    val size: String? = null,
    val variant: String? = null,
    val upc: String? = null,
    /** Where it sits in the picture, left to right, so "the second one" can be resolved. */
    val position: Int = 0,
    val confidence: Double = 0.0,
) {
    /** The best single search string this sighting can offer the local query engine. */
    fun toSearchText(): String =
        listOfNotNull(brand, productName, variant, size)
            .filter { it.isNotBlank() }
            .joinToString(" ")
}

data class ProductIdentification(
    val products: List<AiVisualProduct>,
    val warnings: List<String> = emptyList(),
)

/**
 * What the model decided the user's sentence *means*. It resolves reference and intent only.
 *
 * Note what is absent: there is no variant carrying a price. The model can say "they mean item 4",
 * and it can say "that was a correction to $7.99", but the cost and the shelf price are read back
 * out of the database afterwards.
 */
sealed interface OrderQuestionResolution {
    /** The user means these specific items. */
    data class ProductMatches(
        val itemIds: List<Long>,
        val followUp: String? = null,
    ) : OrderQuestionResolution

    /** Genuinely ambiguous; ask this one short question rather than guess. */
    data class Clarification(val question: String) : OrderQuestionResolution

    /** The user asked about a whole group, e.g. "show me the oils". */
    data class CategoryMatches(val itemIds: List<Long>, val label: String? = null) : OrderQuestionResolution

    /** The user is telling us what they actually charge. */
    data class PriceCorrection(val updates: List<PriceUpdate>) : OrderQuestionResolution

    /** The user asked how much profit a given shelf price would make. */
    data class ProfitQuery(val itemIds: List<Long>, val retailPrice: String) : OrderQuestionResolution

    /** The user asked how many units are in the case. */
    data class CaseQuantityQuery(val itemIds: List<Long>) : OrderQuestionResolution

    /** Understood, but not a product lookup. The text is shown as-is. */
    data class General(val reply: String) : OrderQuestionResolution

    /** Understood nothing useful. */
    data class Unresolved(val reason: String? = null) : OrderQuestionResolution
}

data class PriceUpdate(
    val itemId: Long,
    /** Still a string. [com.grocerypricer.core.money.Money] parses it; nothing else may. */
    val retailPrice: String,
)
