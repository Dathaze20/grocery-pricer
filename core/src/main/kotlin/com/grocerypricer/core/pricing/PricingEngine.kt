package com.grocerypricer.core.pricing

import com.grocerypricer.core.model.Category
import com.grocerypricer.core.model.PriceEnding
import com.grocerypricer.core.model.PricingRules
import com.grocerypricer.core.model.PricingSource
import com.grocerypricer.core.model.PricingSuggestion
import com.grocerypricer.core.money.Money
import java.math.BigDecimal
import java.math.RoundingMode

/**
 * Turns a true unit cost into a suggested shelf price.
 *
 * Resolution order, exactly as the store owner described it:
 *   1. a price the owner pinned to this specific product
 *   2. the price this product was last sold at, if it still clears the minimum margin
 *   3. the category rule, if one is switched on
 *   4. the global cost ladder
 *   5. a markup for anything above the top of the ladder
 *
 * Nothing here is automatic: the result is a *suggestion* the user still has to approve.
 */
class PricingEngine(private val rules: PricingRules = PricingRules()) {

    fun suggest(
        unitCost: Money?,
        category: Category = Category.OTHER,
        previousRetailPrice: Money? = null,
        productOverridePrice: Money? = null,
    ): PricingSuggestion {
        if (unitCost == null || !unitCost.isPositive) {
            val fallback = productOverridePrice ?: previousRetailPrice ?: Money.ZERO
            return PricingSuggestion(
                suggestedPrice = fallback,
                source = PricingSource.NO_COST,
                rationale = "No wholesale cost is known for this product yet.",
                previousPrice = previousRetailPrice,
                alternatives = alternativesAround(fallback, unitCost, endingFor(category)),
            )
        }

        val ending = endingFor(category)
        val baseline = baselinePrice(unitCost, category, ending)

        if (productOverridePrice != null && productOverridePrice.isPositive) {
            return finish(
                price = productOverridePrice,
                source = PricingSource.PRODUCT_OVERRIDE,
                rationale = "This product has its own fixed price.",
                unitCost = unitCost,
                previousPrice = previousRetailPrice,
                ending = ending,
            )
        }

        if (previousRetailPrice != null && previousRetailPrice.isPositive) {
            val marginAtPrevious = ProfitCalculator.grossMarginPercent(unitCost, previousRetailPrice)
            val stillHealthy = marginAtPrevious != null &&
                marginAtPrevious >= rules.minimumGrossMarginPercent
            return if (stillHealthy) {
                finish(
                    price = previousRetailPrice,
                    source = PricingSource.PREVIOUS_PRICE,
                    rationale = "Keeps the price you used last time; the margin still holds at the new cost.",
                    unitCost = unitCost,
                    previousPrice = previousRetailPrice,
                    ending = ending,
                )
            } else {
                finish(
                    price = baseline.price,
                    source = baseline.source,
                    rationale = "Cost has risen far enough that ${previousRetailPrice.format()} no longer holds your minimum margin. ${baseline.rationale}",
                    unitCost = unitCost,
                    previousPrice = previousRetailPrice,
                    ending = ending,
                    priceReviewRecommended = true,
                )
            }
        }

        return finish(
            price = baseline.price,
            source = baseline.source,
            rationale = baseline.rationale,
            unitCost = unitCost,
            previousPrice = null,
            ending = ending,
        )
    }

    /** The ladder/category/markup answer, before previous-price and override handling. */
    private fun baselinePrice(unitCost: Money, category: Category, ending: PriceEnding): Baseline {
        val categoryRule = rules.categoryRuleFor(category)

        categoryRule?.markupPercent?.let { markup ->
            val target = unitCost * (BigDecimal.ONE + markup.divide(BigDecimal("100"), 6, RoundingMode.HALF_UP))
            return Baseline(
                price = PriceRounding.applyEnding(target, ending),
                source = PricingSource.CATEGORY_RULE,
                rationale = "${category.displayName} rule: ${markup.stripTrailingZeros().toPlainString()}% markup on cost.",
            )
        }

        val tier = rules.tierFor(unitCost)
        if (tier != null) {
            val stepped = PriceRounding.step(tier.suggestedPrice, categoryRule?.tierSteps ?: 0, ending)
            val priced = PriceRounding.applyEnding(stepped, ending)
            val source = if ((categoryRule?.tierSteps ?: 0) != 0 || categoryRule?.priceEnding != null) {
                PricingSource.CATEGORY_RULE
            } else {
                PricingSource.COST_TIER
            }
            val rationale = if (source == PricingSource.CATEGORY_RULE) {
                "${category.displayName} rule applied on top of the ${tier.label} cost tier."
            } else {
                "Cost tier ${tier.label}."
            }
            return Baseline(priced, source, rationale)
        }

        val markup = rules.highCostMarkupPercent
        val target = unitCost * (BigDecimal.ONE + markup.divide(BigDecimal("100"), 6, RoundingMode.HALF_UP))
        return Baseline(
            price = PriceRounding.applyEnding(target, ending),
            source = PricingSource.MARKUP,
            rationale = "Above the top cost tier, so a ${markup.stripTrailingZeros().toPlainString()}% markup was used.",
        )
    }

    private fun finish(
        price: Money,
        source: PricingSource,
        rationale: String,
        unitCost: Money,
        previousPrice: Money?,
        ending: PriceEnding,
        priceReviewRecommended: Boolean = false,
    ): PricingSuggestion {
        val margin = ProfitCalculator.grossMarginPercent(unitCost, price)
        return PricingSuggestion(
            suggestedPrice = price.roundedToCents(),
            source = source,
            rationale = rationale,
            alternatives = alternativesAround(price, unitCost, ending),
            previousPrice = previousPrice,
            priceReviewRecommended = priceReviewRecommended,
            belowMinimumMargin = margin != null && margin < rules.minimumGrossMarginPercent,
        )
    }

    /**
     * One-tap alternatives shown next to the suggestion: the tier's second price when there is one,
     * plus a dollar either side. Anything at or below cost is dropped.
     */
    private fun alternativesAround(price: Money, unitCost: Money?, ending: PriceEnding): List<Money> {
        if (!price.isPositive) return emptyList()
        val tierAlternate = unitCost?.let { rules.tierFor(it)?.alternatePrice }
        val candidates = listOfNotNull(
            PriceRounding.step(price, -1, ending),
            price,
            tierAlternate,
            PriceRounding.step(price, 1, ending),
            PriceRounding.step(price, 2, ending),
        )
        return candidates
            .map { it.roundedToCents() }
            .filter { it.isPositive && (unitCost == null || it > unitCost) }
            .distinct()
            .sorted()
    }

    private fun endingFor(category: Category): PriceEnding =
        rules.categoryRuleFor(category)?.priceEnding ?: rules.defaultEnding

    private data class Baseline(
        val price: Money,
        val source: PricingSource,
        val rationale: String,
    )
}
