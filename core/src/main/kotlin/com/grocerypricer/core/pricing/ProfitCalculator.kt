package com.grocerypricer.core.pricing

import com.grocerypricer.core.model.CostChange
import com.grocerypricer.core.model.ProfitSummary
import com.grocerypricer.core.money.Money
import java.math.BigDecimal
import java.math.RoundingMode

/**
 * Gross profit, gross margin and markup.
 *
 * Margin and markup are different numbers and are never used interchangeably:
 *   gross profit  = retail - cost
 *   gross margin% = gross profit / retail x 100
 *   markup%       = gross profit / cost   x 100
 */
object ProfitCalculator {

    private const val PERCENT_SCALE = 4
    private val HUNDRED = BigDecimal("100")

    fun summarise(unitCost: Money, retailPrice: Money): ProfitSummary {
        val grossProfit = retailPrice - unitCost
        return ProfitSummary(
            unitCost = unitCost,
            retailPrice = retailPrice,
            grossProfit = grossProfit,
            grossMarginPercent = percentOrNull(grossProfit, retailPrice),
            markupPercent = percentOrNull(grossProfit, unitCost),
        )
    }

    fun grossMarginPercent(unitCost: Money, retailPrice: Money): BigDecimal? =
        percentOrNull(retailPrice - unitCost, retailPrice)

    fun markupPercent(unitCost: Money, retailPrice: Money): BigDecimal? =
        percentOrNull(retailPrice - unitCost, unitCost)

    /** Weighted average gross margin across a whole order, by sales value. */
    fun averageGrossMarginPercent(totalCost: Money, totalRetail: Money): BigDecimal? =
        percentOrNull(totalRetail - totalCost, totalRetail)

    /**
     * Compares two wholesale costs for the same product.
     * [thresholdPercent] is the store's own "tell me about this" setting.
     */
    fun compareCost(
        previousCost: Money,
        newCost: Money,
        thresholdPercent: BigDecimal,
    ): CostChange {
        val change = newCost - previousCost
        val percent = percentOrNull(change, previousCost)
        val exceeds = percent != null && percent.abs() >= thresholdPercent.abs()
        return CostChange(
            previousCost = previousCost,
            newCost = newCost,
            changeAmount = change,
            changePercent = percent,
            exceedsThreshold = exceeds,
        )
    }

    /** Formats a percentage the way the screens show it: one decimal place, e.g. `42.9%`. */
    fun formatPercent(value: BigDecimal?): String =
        value?.setScale(1, RoundingMode.HALF_UP)?.toPlainString()?.plus("%") ?: "-"

    fun formatSignedPercent(value: BigDecimal?): String {
        if (value == null) return "-"
        val rounded = value.setScale(1, RoundingMode.HALF_UP)
        val sign = if (rounded.signum() > 0) "+" else ""
        return "$sign${rounded.toPlainString()}%"
    }

    private fun percentOrNull(numerator: Money, denominator: Money): BigDecimal? {
        if (denominator.isZero) return null
        return numerator.amount
            .divide(denominator.amount, PERCENT_SCALE + 2, RoundingMode.HALF_UP)
            .multiply(HUNDRED)
            .setScale(PERCENT_SCALE, RoundingMode.HALF_UP)
    }
}
