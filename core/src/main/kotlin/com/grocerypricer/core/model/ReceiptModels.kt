package com.grocerypricer.core.model

import com.grocerypricer.core.money.Money

/** One line of recognised text, kept in reading order together with where it came from. */
data class ReceiptLine(
    val index: Int,
    val text: String,
    val imageId: Long = 0L,
    /** Order of the line inside its own image, used for overlap detection between photos. */
    val indexWithinImage: Int = index,
)

/** How much a parsed row can be trusted. Drives the colour and the gating on the review screen. */
enum class ItemConfidence(val displayName: String) {
    HIGH("High confidence"),
    NEEDS_REVIEW("Needs review"),
    PROBLEM("Problem");

    /** Only high-confidence rows may be bulk-approved. */
    val autoApprovable: Boolean get() = this == HIGH
}

/** A specific reason a row was flagged. Never a free-text string, so the UI can group and count. */
enum class ParseIssueType(val severity: ItemConfidence, val message: String) {
    MISSING_CASE_PRICE(ItemConfidence.PROBLEM, "No case price was found on this line."),
    MISSING_UNITS_PER_CASE(ItemConfidence.PROBLEM, "The number of units per case is missing."),
    MISSING_DESCRIPTION(ItemConfidence.PROBLEM, "No product description was found."),
    NEGATIVE_PRICE(ItemConfidence.PROBLEM, "The price read as a negative number."),
    IMPOSSIBLE_QUANTITY(ItemConfidence.PROBLEM, "The unit count is not a believable case quantity."),
    DISCOUNT_EXCEEDS_PRICE(ItemConfidence.PROBLEM, "The discount is larger than the product costs."),
    UNIT_PRICE_MISMATCH(ItemConfidence.NEEDS_REVIEW, "Case price does not match unit cost x units per case."),
    MISSING_UNIT_COST(ItemConfidence.NEEDS_REVIEW, "The printed unit cost is missing, so it could not be cross-checked."),
    UNCERTAIN_DISCOUNT(ItemConfidence.NEEDS_REVIEW, "Check this discount - how it applies could not be determined."),
    UNMATCHED_DISCOUNT(ItemConfidence.NEEDS_REVIEW, "A discount line was found but not matched to a product."),
    POSSIBLE_DUPLICATE_LINE(ItemConfidence.NEEDS_REVIEW, "This looks like the same line read twice."),
    POSSIBLE_PHOTO_OVERLAP(ItemConfidence.NEEDS_REVIEW, "Two receipt photos appear to overlap here."),
    AMBIGUOUS_CHARACTERS(ItemConfidence.NEEDS_REVIEW, "Characters that OCR often confuses were corrected - check the numbers.");
}

data class ParseIssue(
    val type: ParseIssueType,
    val detail: String? = null,
) {
    val message: String get() = detail?.let { "${type.message} $it" } ?: type.message
}

/**
 * A product row reconstructed from a receipt, before the user has reviewed it.
 *
 * Every numeric field is nullable on purpose: a value that could not be read stays null and gets
 * flagged, it is never invented.
 */
data class ParsedReceiptItem(
    val id: String,
    val description: String?,
    val upc: String? = null,
    val supplierSku: String? = null,
    val packageSize: String? = null,
    val casePrice: Money? = null,
    val unitsPerCase: Int? = null,
    val printedUnitCost: Money? = null,
    val casesPurchased: Int = 1,
    val looseUnits: Int = 0,
    val discount: ReceiptDiscount? = null,
    val category: Category = Category.OTHER,
    val issues: List<ParseIssue> = emptyList(),
    val sourceLineIndexes: List<Int> = emptyList(),
    val rawText: String = "",
    val imageId: Long = 0L,
) {
    val confidence: ItemConfidence
        get() = when {
            issues.any { it.type.severity == ItemConfidence.PROBLEM } -> ItemConfidence.PROBLEM
            issues.isNotEmpty() -> ItemConfidence.NEEDS_REVIEW
            else -> ItemConfidence.HIGH
        }

    fun hasIssue(type: ParseIssueType): Boolean = issues.any { it.type == type }

    fun withIssue(type: ParseIssueType, detail: String? = null): ParsedReceiptItem =
        if (hasIssue(type)) this else copy(issues = issues + ParseIssue(type, detail))

    fun withoutIssue(type: ParseIssueType): ParsedReceiptItem =
        copy(issues = issues.filterNot { it.type == type })
}

/** The complete result of parsing one order's worth of receipt text. */
data class ParsedReceipt(
    val items: List<ParsedReceiptItem>,
    val unmatchedDiscounts: List<ReceiptDiscount> = emptyList(),
    val unparsedLines: List<ReceiptLine> = emptyList(),
) {
    val highConfidenceCount: Int get() = items.count { it.confidence == ItemConfidence.HIGH }
    val needsReviewCount: Int get() = items.count { it.confidence == ItemConfidence.NEEDS_REVIEW }
    val problemCount: Int get() = items.count { it.confidence == ItemConfidence.PROBLEM }
}
