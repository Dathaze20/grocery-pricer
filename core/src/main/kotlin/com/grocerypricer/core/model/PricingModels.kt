package com.grocerypricer.core.model

import com.grocerypricer.core.money.Money
import java.math.BigDecimal

/**
 * The cents a suggested price should end in. Fully configurable - `.99` is only the default.
 */
data class PriceEnding(val cents: Int, val label: String) {
    init {
        require(cents in 0..99) { "A price ending must be between 0 and 99 cents" }
    }

    companion object {
        val NINETY_NINE = PriceEnding(99, ".99")
        val FORTY_NINE = PriceEnding(49, ".49")
        val WHOLE = PriceEnding(0, ".00")
        val PRESETS = listOf(NINETY_NINE, FORTY_NINE, WHOLE)

        fun custom(cents: Int) = PriceEnding(cents, "." + cents.toString().padStart(2, '0'))

        fun fromCents(cents: Int): PriceEnding =
            PRESETS.firstOrNull { it.cents == cents } ?: custom(cents)
    }
}

/**
 * One row of the deli's cost ladder: "anything costing between X and Y starts at this shelf price".
 * [alternatePrice] is offered as a one-tap second choice on the pricing screen.
 */
data class CostTier(
    val minCost: Money,
    val maxCost: Money,
    val suggestedPrice: Money,
    val alternatePrice: Money? = null,
) {
    fun contains(cost: Money): Boolean = cost >= minCost && cost <= maxCost

    val label: String
        get() = "${minCost.format()} - ${maxCost.format()}"
}

/**
 * Optional per-category override. A category may set its own markup, its own price ending, and/or
 * nudge the cost-tier result up or down by whole ending steps (a "step" is one dollar).
 */
data class CategoryPricingRule(
    val category: Category,
    val markupPercent: BigDecimal? = null,
    val priceEnding: PriceEnding? = null,
    val tierSteps: Int = 0,
    val enabled: Boolean = true,
)

/** The complete, user-editable pricing configuration. */
data class PricingRules(
    val tiers: List<CostTier> = defaultTiers(),
    /** Applied to any cost above the highest tier. */
    val highCostMarkupPercent: BigDecimal = BigDecimal("60"),
    val defaultEnding: PriceEnding = PriceEnding.NINETY_NINE,
    val categoryRules: Map<Category, CategoryPricingRule> = defaultCategoryRules(),
    /** A suggested price below this gross margin raises a warning. */
    val minimumGrossMarginPercent: BigDecimal = BigDecimal("30"),
    /** A wholesale cost move of at least this much is worth telling the user about. */
    val costChangeAlertPercent: BigDecimal = BigDecimal("10"),
) {
    fun tierFor(cost: Money): CostTier? = tiers.firstOrNull { it.contains(cost) }

    fun categoryRuleFor(category: Category): CategoryPricingRule? =
        categoryRules[category]?.takeIf { it.enabled }

    companion object {
        /**
         * Starting ladder for a small neighbourhood deli - convenience-store margins, not
         * supermarket margins. Every row is editable in Settings.
         */
        fun defaultTiers(): List<CostTier> = listOf(
            CostTier(Money.of("0.00"), Money.of("1.24"), Money.of("2.99")),
            CostTier(Money.of("1.25"), Money.of("1.99"), Money.of("3.99")),
            CostTier(Money.of("2.00"), Money.of("2.99"), Money.of("4.99"), Money.of("5.99")),
            CostTier(Money.of("3.00"), Money.of("3.99"), Money.of("5.99"), Money.of("6.99")),
            CostTier(Money.of("4.00"), Money.of("4.99"), Money.of("7.99"), Money.of("8.99")),
            CostTier(Money.of("5.00"), Money.of("5.99"), Money.of("8.99"), Money.of("9.99")),
            CostTier(Money.of("6.00"), Money.of("7.99"), Money.of("10.99"), Money.of("12.99")),
            CostTier(Money.of("8.00"), Money.of("9.99"), Money.of("13.99"), Money.of("15.99")),
        )

        /** No category overrides are switched on out of the box; the ladder alone is the default. */
        fun defaultCategoryRules(): Map<Category, CategoryPricingRule> = emptyMap()
    }
}

/** Where a suggested price came from. Always shown to the user so the number is never a black box. */
enum class PricingSource(val displayName: String) {
    PRODUCT_OVERRIDE("Product-specific price"),
    PREVIOUS_PRICE("Your previous store price"),
    CATEGORY_RULE("Category rule"),
    COST_TIER("Cost tier"),
    MARKUP("Markup rule"),
    NO_COST("No cost available"),
}

/** A price proposal. Nothing here is final until the user approves it. */
data class PricingSuggestion(
    val suggestedPrice: Money,
    val source: PricingSource,
    val rationale: String,
    val alternatives: List<Money> = emptyList(),
    val previousPrice: Money? = null,
    /** True when the old shelf price no longer clears the minimum margin at the new cost. */
    val priceReviewRecommended: Boolean = false,
    val belowMinimumMargin: Boolean = false,
)

/** Gross profit maths. Margin and markup are deliberately separate, never interchanged. */
data class ProfitSummary(
    val unitCost: Money,
    val retailPrice: Money,
    val grossProfit: Money,
    /** Gross profit / retail price x 100. Null when the retail price is zero. */
    val grossMarginPercent: BigDecimal?,
    /** Gross profit / unit cost x 100. Null when the cost is zero. */
    val markupPercent: BigDecimal?,
)

/** Direction and size of a wholesale cost move between two purchases of the same product. */
data class CostChange(
    val previousCost: Money,
    val newCost: Money,
    val changeAmount: Money,
    val changePercent: BigDecimal?,
    val exceedsThreshold: Boolean,
) {
    val isIncrease: Boolean get() = changeAmount.isPositive
    val isDecrease: Boolean get() = changeAmount.isNegative
}
