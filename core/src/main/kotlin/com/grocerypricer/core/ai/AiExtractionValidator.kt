package com.grocerypricer.core.ai

import com.grocerypricer.core.model.DiscountScope
import com.grocerypricer.core.money.Money

/** Something wrong with an extracted row, recorded rather than silently swallowed. */
enum class ExtractionIssue {
    NO_USABLE_NAME,
    UNREADABLE_CASE_PRICE,
    NEGATIVE_CASE_PRICE,
    MISSING_CASE_PRICE,
    UNREADABLE_UNIT_COST,
    INVALID_UNITS_PER_CASE,
    MISSING_UNITS_PER_CASE,
    INVALID_CASES_PURCHASED,
    UNREADABLE_DISCOUNT,
    NEGATIVE_DISCOUNT,
    DISCOUNT_EXCEEDS_CASE_PRICE,
    UNKNOWN_DISCOUNT_SCOPE,
    SUBSET_UNITS_EXCEED_CASE,
    CONFIDENCE_OUT_OF_RANGE,
    UNKNOWN_SOURCE_PHOTO,
    NO_SOURCE_EVIDENCE,
}

/** An item that survived validation, with whatever was wrong with it written down. */
data class ValidatedItem(
    val item: AiExtractedItem,
    val issues: List<ExtractionIssue> = emptyList(),
) {
    /** True when this row can be priced without asking the user anything. */
    val isComplete: Boolean
        get() = item.casePrice != null &&
            item.unitsPerCase != null &&
            issues.none { it in BLOCKING_ISSUES }

    companion object {
        private val BLOCKING_ISSUES = setOf(
            ExtractionIssue.MISSING_CASE_PRICE,
            ExtractionIssue.UNREADABLE_CASE_PRICE,
            ExtractionIssue.MISSING_UNITS_PER_CASE,
            ExtractionIssue.INVALID_UNITS_PER_CASE,
        )
    }
}

data class RejectedItem(
    val item: AiExtractedItem,
    val reason: ExtractionIssue,
)

data class ValidatedExtraction(
    val supplier: String?,
    val accepted: List<ValidatedItem>,
    val rejected: List<RejectedItem>,
    val warnings: List<String> = emptyList(),
) {
    val itemsNeedingAttention: List<ValidatedItem> get() = accepted.filterNot { it.isComplete }
}

/**
 * The gate between what a model claimed and what gets written down.
 *
 * The policy is repair-then-record, not reject-everything: a row with an unreadable price is still
 * worth keeping, because the user can ask about it and be told honestly that the price could not
 * be read. Only a row with no name at all is thrown away, because there is no way to ever refer
 * to it again.
 *
 * Nothing here computes a cost. It decides which claimed figures are *usable*; the arithmetic
 * happens afterwards in [com.grocerypricer.core.pricing.CostCalculator].
 */
object AiExtractionValidator {

    /** Above this, a claimed pack count is a misread of something else on the line. */
    const val MAX_PLAUSIBLE_UNITS_PER_CASE = 1_000

    /** Above this, a claimed case count is a misread. */
    const val MAX_PLAUSIBLE_CASES = 500

    fun validate(
        extraction: AiOrderExtraction,
        knownPhotoIds: Set<Long> = emptySet(),
    ): ValidatedExtraction {
        val accepted = mutableListOf<ValidatedItem>()
        val rejected = mutableListOf<RejectedItem>()

        for (item in extraction.items) {
            val validated = validateItem(item, knownPhotoIds)
            when (validated) {
                is ItemOutcome.Keep -> accepted += validated.value
                is ItemOutcome.Drop -> rejected += RejectedItem(item, validated.reason)
            }
        }

        return ValidatedExtraction(
            supplier = extraction.supplier?.takeIf { it.isNotBlank() },
            accepted = accepted,
            rejected = rejected,
            warnings = extraction.warnings,
        )
    }

    private sealed interface ItemOutcome {
        data class Keep(val value: ValidatedItem) : ItemOutcome
        data class Drop(val reason: ExtractionIssue) : ItemOutcome
    }

    private fun validateItem(item: AiExtractedItem, knownPhotoIds: Set<Long>): ItemOutcome {
        val name = item.canonicalName?.takeIf { it.isNotBlank() }
            ?: item.rawName?.takeIf { it.isNotBlank() }
            ?: return ItemOutcome.Drop(ExtractionIssue.NO_USABLE_NAME)

        val issues = mutableListOf<ExtractionIssue>()

        val casePrice = readMoney(
            raw = item.casePrice,
            issues = issues,
            missing = ExtractionIssue.MISSING_CASE_PRICE,
            unreadable = ExtractionIssue.UNREADABLE_CASE_PRICE,
            negative = ExtractionIssue.NEGATIVE_CASE_PRICE,
        )

        val printedUnitCost = readMoney(
            raw = item.printedUnitCost,
            issues = issues,
            missing = null, // The printed per-unit figure is a nicety, never required.
            unreadable = ExtractionIssue.UNREADABLE_UNIT_COST,
            negative = ExtractionIssue.UNREADABLE_UNIT_COST,
        )

        val unitsPerCase = when {
            item.unitsPerCase == null -> {
                issues += ExtractionIssue.MISSING_UNITS_PER_CASE
                null
            }
            item.unitsPerCase <= 0 || item.unitsPerCase > MAX_PLAUSIBLE_UNITS_PER_CASE -> {
                issues += ExtractionIssue.INVALID_UNITS_PER_CASE
                null
            }
            else -> item.unitsPerCase
        }

        // A receipt line with no case count means one case, which is the overwhelmingly common
        // reading. A nonsense count is corrected to one and written down as an issue.
        val casesPurchased = when {
            item.casesPurchased == null -> 1
            item.casesPurchased <= 0 || item.casesPurchased > MAX_PLAUSIBLE_CASES -> {
                issues += ExtractionIssue.INVALID_CASES_PURCHASED
                1
            }
            else -> item.casesPurchased
        }

        val discount = validateDiscount(item.discount, casePrice, unitsPerCase, issues)

        val confidence = when {
            item.confidence.isNaN() -> {
                issues += ExtractionIssue.CONFIDENCE_OUT_OF_RANGE
                0.0
            }
            item.confidence < 0.0 || item.confidence > 1.0 -> {
                issues += ExtractionIssue.CONFIDENCE_OUT_OF_RANGE
                item.confidence.coerceIn(0.0, 1.0)
            }
            else -> item.confidence
        }

        // A source photo id that was never imported is a fabricated citation. Drop the id, keep
        // the row, and note that its provenance is not trustworthy.
        val sourcePhotoIds = if (knownPhotoIds.isEmpty()) {
            item.sourcePhotoIds
        } else {
            val kept = item.sourcePhotoIds.filter { it in knownPhotoIds }
            if (kept.size != item.sourcePhotoIds.size) issues += ExtractionIssue.UNKNOWN_SOURCE_PHOTO
            kept
        }

        if (sourcePhotoIds.isEmpty() && item.sourceText.isEmpty()) {
            issues += ExtractionIssue.NO_SOURCE_EVIDENCE
        }

        val cleaned = item.copy(
            canonicalName = item.canonicalName?.takeIf { it.isNotBlank() } ?: name,
            rawName = item.rawName?.takeIf { it.isNotBlank() },
            casePrice = casePrice?.toPlainString(),
            printedUnitCost = printedUnitCost?.toPlainString(),
            unitsPerCase = unitsPerCase,
            casesPurchased = casesPurchased,
            discount = discount,
            sourcePhotoIds = sourcePhotoIds,
            confidence = confidence,
        )

        return ItemOutcome.Keep(ValidatedItem(cleaned, issues.distinct()))
    }

    private fun readMoney(
        raw: String?,
        issues: MutableList<ExtractionIssue>,
        missing: ExtractionIssue?,
        unreadable: ExtractionIssue,
        negative: ExtractionIssue,
    ): Money? {
        if (raw == null) {
            missing?.let { issues += it }
            return null
        }
        val parsed = Money.parseOrNull(raw)
        if (parsed == null) {
            issues += unreadable
            return null
        }
        if (parsed.isNegative) {
            issues += negative
            return null
        }
        return parsed
    }

    private fun validateDiscount(
        discount: AiExtractedDiscount?,
        casePrice: Money?,
        unitsPerCase: Int?,
        issues: MutableList<ExtractionIssue>,
    ): AiExtractedDiscount? {
        if (discount == null) return null

        val amount = discount.amount?.let { Money.parseOrNull(it) }
        if (discount.amount != null && amount == null) {
            issues += ExtractionIssue.UNREADABLE_DISCOUNT
            return null
        }
        if (amount != null && amount.isNegative) {
            // A discount printed as "-$8.00" is still eight dollars off. A genuinely negative
            // discount is a misread, and applying it would silently *raise* the cost.
            issues += ExtractionIssue.NEGATIVE_DISCOUNT
            return null
        }

        val scopeName = discount.scope?.trim()?.uppercase()
        val scope = DiscountScope.entries.firstOrNull { it.name == scopeName }
        if (scopeName != null && scope == null) {
            issues += ExtractionIssue.UNKNOWN_DISCOUNT_SCOPE
        }

        // A discount bigger than the case is not a free case plus change; it is a misread.
        // Record it and refuse the discount rather than inventing negative money.
        if (amount != null && casePrice != null && amount > casePrice) {
            issues += ExtractionIssue.DISCOUNT_EXCEEDS_CASE_PRICE
            return null
        }

        val appliesToUnits = discount.appliesToUnits?.let { claimed ->
            when {
                claimed <= 0 -> null
                unitsPerCase != null && claimed > unitsPerCase -> {
                    issues += ExtractionIssue.SUBSET_UNITS_EXCEED_CASE
                    unitsPerCase
                }
                else -> claimed
            }
        }

        if (amount == null && scope == null) return null

        return AiExtractedDiscount(
            amount = amount?.toPlainString(),
            // An unreadable scope must never silently become "take it off the whole case".
            scope = (scope ?: DiscountScope.UNKNOWN).name,
            appliesToUnits = appliesToUnits,
        )
    }
}
