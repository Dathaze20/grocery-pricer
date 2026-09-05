package com.grocerypricer.core.model

import com.grocerypricer.core.money.Money

/**
 * The deterministic result of costing one order line. Produced only by
 * [com.grocerypricer.core.pricing.CostCalculator] - never by OCR, never by a model.
 */
data class CostBreakdown(
    val casePrice: Money,
    val unitsPerCase: Int,
    val casesPurchased: Int,
    val looseUnits: Int,
    /** Total money taken off one case by the discount (zero when there is none). */
    val discountPerCase: Money,
    /** Total money taken off the whole order line. */
    val totalDiscount: Money,
    /** Case price after the discount. */
    val netCaseCost: Money,
    /** What one retail unit truly costs, at full internal precision. */
    val trueUnitCost: Money,
    /** Retail pieces this line puts on the shelf. */
    val totalUnits: Int,
    /** What the whole line cost at wholesale. */
    val totalWholesaleCost: Money,
) {
    /** The rounded figure shown on price tags and cards. */
    val displayUnitCost: Money get() = trueUnitCost.roundedToCents()

    val hasDiscount: Boolean get() = totalDiscount.isPositive
}
