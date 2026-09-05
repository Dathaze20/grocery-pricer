package com.grocerypricer.core.pricing

import com.grocerypricer.core.model.CostBreakdown
import com.grocerypricer.core.model.DiscountScope
import com.grocerypricer.core.model.ReceiptDiscount
import com.grocerypricer.core.money.Money

/**
 * Turns what the receipt says into what a single retail unit actually costs.
 *
 * This is plain deterministic arithmetic on [Money]/BigDecimal. It is the only place true unit
 * cost is derived, so every screen in the app agrees on the number.
 */
object CostCalculator {

    /**
     * @param casePrice the price of one case as printed on the receipt
     * @param unitsPerCase retail pieces inside one case (`SIZE 12` on a Jetro line)
     * @param casesPurchased how many of those cases were bought
     * @param looseUnits individual pieces bought outside a full case
     * @param discount the discount to apply, or null. A discount whose scope is
     *   [DiscountScope.UNKNOWN] or [DiscountScope.IGNORED] deliberately does not move the cost -
     *   the user has to say how it applies first.
     */
    fun calculate(
        casePrice: Money,
        unitsPerCase: Int,
        casesPurchased: Int = 1,
        looseUnits: Int = 0,
        discount: ReceiptDiscount? = null,
    ): CostBreakdown {
        require(unitsPerCase > 0) { "A case must contain at least one retail unit" }
        require(casesPurchased >= 0) { "Cases purchased cannot be negative" }
        require(looseUnits >= 0) { "Loose units cannot be negative" }

        val grossUnitCost = casePrice.divideBy(unitsPerCase)
        val grossTotal = (casePrice * casesPurchased) + (grossUnitCost * looseUnits)

        val discountPerCase = discountPerCase(discount, casePrice, unitsPerCase, casesPurchased)
        val netCaseCost = (casePrice - discountPerCase).coerceAtLeastZero()
        val trueUnitCost = netCaseCost.divideBy(unitsPerCase)

        val totalWholesaleCost = (netCaseCost * casesPurchased) + (trueUnitCost * looseUnits)
        val totalDiscount = (grossTotal - totalWholesaleCost).coerceAtLeastZero()

        return CostBreakdown(
            casePrice = casePrice,
            unitsPerCase = unitsPerCase,
            casesPurchased = casesPurchased,
            looseUnits = looseUnits,
            discountPerCase = discountPerCase,
            totalDiscount = totalDiscount,
            netCaseCost = netCaseCost,
            trueUnitCost = trueUnitCost,
            totalUnits = unitsPerCase * casesPurchased + looseUnits,
            totalWholesaleCost = totalWholesaleCost,
        )
    }

    /**
     * How much a discount takes off ONE case, given its scope.
     *
     * - [DiscountScope.WHOLE_CASE]: the printed amount, once per case.
     * - [DiscountScope.PER_UNIT]: the printed amount multiplied by every unit in the case.
     * - [DiscountScope.UNITS_SUBSET]: the printed amount on a set number of units inside each case.
     * - [DiscountScope.CUSTOM]: one flat amount spread evenly over the cases bought.
     * - [DiscountScope.IGNORED] / [DiscountScope.UNKNOWN]: nothing.
     *
     * The result is capped at the case price so a mis-read discount can never produce a negative
     * cost; the caller flags that situation separately.
     */
    private fun discountPerCase(
        discount: ReceiptDiscount?,
        casePrice: Money,
        unitsPerCase: Int,
        casesPurchased: Int,
    ): Money {
        if (discount == null || !discount.scope.affectsCost) return Money.ZERO
        val raw = when (discount.scope) {
            DiscountScope.WHOLE_CASE -> discount.amount
            DiscountScope.PER_UNIT -> discount.amount * unitsPerCase
            DiscountScope.UNITS_SUBSET -> {
                val units = (discount.appliesToUnits ?: 0).coerceIn(0, unitsPerCase)
                discount.amount * units
            }
            DiscountScope.CUSTOM -> discount.amount.divideBy(maxOf(casesPurchased, 1))
            DiscountScope.IGNORED, DiscountScope.UNKNOWN -> Money.ZERO
        }
        return if (raw > casePrice) casePrice else raw
    }

    /** True when the discount as scoped would cost more than the product does. */
    fun discountExceedsPrice(
        discount: ReceiptDiscount?,
        casePrice: Money,
        unitsPerCase: Int,
        casesPurchased: Int = 1,
    ): Boolean {
        if (discount == null || !discount.scope.affectsCost) return false
        val raw = when (discount.scope) {
            DiscountScope.WHOLE_CASE -> discount.amount
            DiscountScope.PER_UNIT -> discount.amount * unitsPerCase
            DiscountScope.UNITS_SUBSET -> discount.amount * (discount.appliesToUnits ?: 0)
            DiscountScope.CUSTOM -> discount.amount.divideBy(maxOf(casesPurchased, 1))
            else -> Money.ZERO
        }
        return raw > casePrice
    }
}
