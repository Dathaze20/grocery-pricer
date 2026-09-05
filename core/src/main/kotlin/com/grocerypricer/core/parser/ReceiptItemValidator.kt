package com.grocerypricer.core.parser

import com.grocerypricer.core.model.DiscountScope
import com.grocerypricer.core.model.ParseIssue
import com.grocerypricer.core.model.ParseIssueType
import com.grocerypricer.core.model.ParsedReceiptItem
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.pricing.CostCalculator
import java.math.BigDecimal

/**
 * Sanity-checks a parsed row and decides how much it can be trusted.
 *
 * Re-running this on an edited row is safe: everything it owns is recomputed from scratch, while
 * findings that came from elsewhere (character corrections, duplicate detection) are preserved.
 */
object ReceiptItemValidator {

    /** The largest believable case pack. Anything past this is a misread, not a purchase. */
    const val MAX_UNITS_PER_CASE = 500
    const val MAX_CASES = 500

    /** Printed unit costs are rounded to the cent, so a small gap is expected and fine. */
    private val ABSOLUTE_TOLERANCE = Money.of("0.02")
    private val RELATIVE_TOLERANCE = BigDecimal("0.015")

    private val COMPUTED_ISSUES = setOf(
        ParseIssueType.MISSING_DESCRIPTION,
        ParseIssueType.MISSING_CASE_PRICE,
        ParseIssueType.MISSING_UNITS_PER_CASE,
        ParseIssueType.MISSING_UNIT_COST,
        ParseIssueType.NEGATIVE_PRICE,
        ParseIssueType.IMPOSSIBLE_QUANTITY,
        ParseIssueType.DISCOUNT_EXCEEDS_PRICE,
        ParseIssueType.UNIT_PRICE_MISMATCH,
        ParseIssueType.UNCERTAIN_DISCOUNT,
    )

    fun validate(item: ParsedReceiptItem): ParsedReceiptItem {
        val kept = item.issues.filterNot { it.type in COMPUTED_ISSUES }
        val found = mutableListOf<ParseIssue>()

        if (item.description.isNullOrBlank()) {
            found += ParseIssue(ParseIssueType.MISSING_DESCRIPTION)
        }

        val casePrice = item.casePrice
        if (casePrice == null) {
            found += ParseIssue(ParseIssueType.MISSING_CASE_PRICE)
        } else if (casePrice.isNegative) {
            found += ParseIssue(ParseIssueType.NEGATIVE_PRICE, "Case price read as ${casePrice.format()}.")
        }

        val units = item.unitsPerCase
        if (units == null) {
            found += ParseIssue(ParseIssueType.MISSING_UNITS_PER_CASE)
        } else if (units !in 1..MAX_UNITS_PER_CASE) {
            found += ParseIssue(ParseIssueType.IMPOSSIBLE_QUANTITY, "Read $units units per case.")
        }

        if (item.casesPurchased !in 0..MAX_CASES) {
            found += ParseIssue(ParseIssueType.IMPOSSIBLE_QUANTITY, "Read ${item.casesPurchased} cases.")
        }
        if (item.looseUnits < 0) {
            found += ParseIssue(ParseIssueType.IMPOSSIBLE_QUANTITY, "Read ${item.looseUnits} loose units.")
        }

        val printed = item.printedUnitCost
        if (printed == null) {
            found += ParseIssue(ParseIssueType.MISSING_UNIT_COST)
        } else if (printed.isNegative) {
            found += ParseIssue(ParseIssueType.NEGATIVE_PRICE, "Unit cost read as ${printed.format()}.")
        }

        if (casePrice != null && units != null && units in 1..MAX_UNITS_PER_CASE && printed != null &&
            !casePrice.isNegative && !printed.isNegative
        ) {
            val derived = casePrice.divideBy(units)
            val gap = (derived - printed).abs()
            val allowed = maxOf(ABSOLUTE_TOLERANCE, Money.of(derived.amount.multiply(RELATIVE_TOLERANCE)))
            if (gap > allowed) {
                found += ParseIssue(
                    ParseIssueType.UNIT_PRICE_MISMATCH,
                    "${casePrice.format()} over $units units is ${derived.roundedToCents().format()}, but the receipt printed ${printed.format()}.",
                )
            }
        }

        val discount = item.discount
        if (discount != null) {
            if (discount.scope == DiscountScope.UNKNOWN) {
                found += ParseIssue(
                    ParseIssueType.UNCERTAIN_DISCOUNT,
                    "Read as \"${discount.description}\" for ${discount.amount.format()}.",
                )
            }
            if (casePrice != null && units != null && units >= 1 &&
                CostCalculator.discountExceedsPrice(discount, casePrice, units, maxOf(item.casesPurchased, 1))
            ) {
                found += ParseIssue(
                    ParseIssueType.DISCOUNT_EXCEEDS_PRICE,
                    "${discount.amount.format()} taken off a ${casePrice.format()} case.",
                )
            }
        }

        return item.copy(issues = kept + found)
    }
}
