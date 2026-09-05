package com.grocerypricer.core

import com.grocerypricer.core.model.Category
import com.grocerypricer.core.model.CategoryPricingRule
import com.grocerypricer.core.model.PriceEnding
import com.grocerypricer.core.model.PricingRules
import com.grocerypricer.core.model.PricingSource
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.pricing.PriceRounding
import com.grocerypricer.core.pricing.PricingEngine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigDecimal

class PricingEngineTest {

    private val engine = PricingEngine()

    @Test
    fun `default deli cost tiers reproduce the owner's ladder`() {
        assertEquals(Money.of("2.99"), engine.suggest(Money.of("0.85")).suggestedPrice)
        assertEquals(Money.of("3.99"), engine.suggest(Money.of("1.50")).suggestedPrice)
        assertEquals(Money.of("4.99"), engine.suggest(Money.of("2.17")).suggestedPrice)
        assertEquals(Money.of("5.99"), engine.suggest(Money.of("3.29")).suggestedPrice)
        assertEquals(Money.of("7.99"), engine.suggest(Money.of("4.56")).suggestedPrice)
        assertEquals(Money.of("8.99"), engine.suggest(Money.of("5.50")).suggestedPrice)
        assertEquals(Money.of("10.99"), engine.suggest(Money.of("7.25")).suggestedPrice)
        assertEquals(Money.of("13.99"), engine.suggest(Money.of("9.10")).suggestedPrice)
    }

    @Test
    fun `the three worked examples price the way the store owner prices them`() {
        // Hellmann's mayonnaise 8 oz at $2.1658 true cost.
        assertEquals(Money.of("4.99"), engine.suggest(Money.of("2.1658"), Category.CONDIMENTS).suggestedPrice)
        // Kellogg's Froot Loops 13.2 oz at $4.559 true cost.
        assertEquals(Money.of("7.99"), engine.suggest(Money.of("4.559"), Category.CEREAL).suggestedPrice)
        // Ultra Downy April Fresh at $3.29 true cost.
        assertEquals(Money.of("5.99"), engine.suggest(Money.of("3.29"), Category.LAUNDRY).suggestedPrice)
    }

    @Test
    fun `tier boundaries are inclusive on both ends`() {
        assertEquals(Money.of("3.99"), engine.suggest(Money.of("1.25")).suggestedPrice)
        assertEquals(Money.of("3.99"), engine.suggest(Money.of("1.99")).suggestedPrice)
        assertEquals(Money.of("4.99"), engine.suggest(Money.of("2.00")).suggestedPrice)
        assertEquals(Money.of("2.99"), engine.suggest(Money.of("1.24")).suggestedPrice)
    }

    @Test
    fun `a cost above the top tier falls back to the markup rule`() {
        val suggestion = engine.suggest(Money.of("12.00"))
        assertEquals(PricingSource.MARKUP, suggestion.source)
        // 12.00 + 60% = 19.20, taken up to the next .99
        assertEquals(Money.of("19.99"), suggestion.suggestedPrice)
    }

    @Test
    fun `a previous store price is kept while the margin still holds`() {
        val suggestion = engine.suggest(
            unitCost = Money.of("3.49"),
            category = Category.LAUNDRY,
            previousRetailPrice = Money.of("5.99"),
        )

        assertEquals(Money.of("5.99"), suggestion.suggestedPrice)
        assertEquals(PricingSource.PREVIOUS_PRICE, suggestion.source)
        assertFalse(suggestion.priceReviewRecommended)
    }

    @Test
    fun `a cost rise that breaks the margin asks for a price review instead of silently repricing`() {
        val suggestion = engine.suggest(
            unitCost = Money.of("4.60"),
            previousRetailPrice = Money.of("5.99"),
        )

        assertTrue(suggestion.priceReviewRecommended)
        assertEquals(Money.of("5.99"), suggestion.previousPrice)
        assertEquals(Money.of("7.99"), suggestion.suggestedPrice)
    }

    @Test
    fun `a product-specific price beats every rule`() {
        val suggestion = engine.suggest(
            unitCost = Money.of("2.17"),
            previousRetailPrice = Money.of("4.99"),
            productOverridePrice = Money.of("3.49"),
        )

        assertEquals(Money.of("3.49"), suggestion.suggestedPrice)
        assertEquals(PricingSource.PRODUCT_OVERRIDE, suggestion.source)
    }

    @Test
    fun `a category rule can push a whole category up a step`() {
        val rules = PricingRules(
            categoryRules = mapOf(
                Category.CEREAL to CategoryPricingRule(Category.CEREAL, tierSteps = 1),
            ),
        )
        val suggestion = PricingEngine(rules).suggest(Money.of("4.56"), Category.CEREAL)

        assertEquals(Money.of("8.99"), suggestion.suggestedPrice)
        assertEquals(PricingSource.CATEGORY_RULE, suggestion.source)
        // A category without a rule still uses the plain ladder.
        assertEquals(Money.of("7.99"), PricingEngine(rules).suggest(Money.of("4.56"), Category.SNACKS).suggestedPrice)
    }

    @Test
    fun `a category markup rule replaces the ladder for that category`() {
        val rules = PricingRules(
            categoryRules = mapOf(
                Category.CLEANING to CategoryPricingRule(Category.CLEANING, markupPercent = BigDecimal("150")),
            ),
        )
        val suggestion = PricingEngine(rules).suggest(Money.of("1.60"), Category.CLEANING)

        // 1.60 + 150% = 4.00, taken up to the next .99
        assertEquals(Money.of("4.99"), suggestion.suggestedPrice)
        assertEquals(PricingSource.CATEGORY_RULE, suggestion.source)
    }

    @Test
    fun `alternatives are offered around the suggestion and never at or below cost`() {
        val suggestion = engine.suggest(Money.of("2.17"))
        assertTrue(suggestion.alternatives.contains(Money.of("4.99")))
        assertTrue(suggestion.alternatives.contains(Money.of("5.99")))
        assertTrue(suggestion.alternatives.all { it > Money.of("2.17") })
        assertEquals(suggestion.alternatives.sorted(), suggestion.alternatives)
    }

    @Test
    fun `a missing cost produces no invented price`() {
        val suggestion = engine.suggest(null)
        assertEquals(PricingSource.NO_COST, suggestion.source)
        assertEquals(Money.ZERO, suggestion.suggestedPrice)
    }

    @Test
    fun `a thin margin is flagged rather than hidden`() {
        val rules = PricingRules(minimumGrossMarginPercent = BigDecimal("60"))
        val suggestion = PricingEngine(rules).suggest(Money.of("2.17"))
        assertTrue(suggestion.belowMinimumMargin)
    }
}

class PriceRoundingTest {

    @Test
    fun `a target price moves up to the next configured ending`() {
        assertEquals(Money.of("5.99"), PriceRounding.applyEnding(Money.of("5.16"), PriceEnding.NINETY_NINE))
        assertEquals(Money.of("7.99"), PriceRounding.applyEnding(Money.of("7.12"), PriceEnding.NINETY_NINE))
        assertEquals(Money.of("2.99"), PriceRounding.applyEnding(Money.of("2.05"), PriceEnding.NINETY_NINE))
    }

    @Test
    fun `a price that already ends correctly is left alone`() {
        assertEquals(Money.of("5.99"), PriceRounding.applyEnding(Money.of("5.99"), PriceEnding.NINETY_NINE))
        assertEquals(Money.of("6.00"), PriceRounding.applyEnding(Money.of("6.00"), PriceEnding.WHOLE))
    }

    @Test
    fun `other endings are supported`() {
        assertEquals(Money.of("5.49"), PriceRounding.applyEnding(Money.of("5.16"), PriceEnding.FORTY_NINE))
        assertEquals(Money.of("6.00"), PriceRounding.applyEnding(Money.of("5.16"), PriceEnding.WHOLE))
        assertEquals(Money.of("5.75"), PriceRounding.applyEnding(Money.of("5.16"), PriceEnding.custom(75)))
    }

    @Test
    fun `stepping keeps the ending`() {
        assertEquals(Money.of("8.99"), PriceRounding.step(Money.of("7.99"), 1, PriceEnding.NINETY_NINE))
        assertEquals(Money.of("6.99"), PriceRounding.step(Money.of("7.99"), -1, PriceEnding.NINETY_NINE))
        assertEquals(Money.of("7.99"), PriceRounding.step(Money.of("7.99"), 0, PriceEnding.NINETY_NINE))
    }
}
