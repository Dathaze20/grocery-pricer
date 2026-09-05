package com.grocerypricer.core

import com.grocerypricer.core.money.Money
import com.grocerypricer.core.pricing.ProfitCalculator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigDecimal

class ProfitCalculatorTest {

    @Test
    fun `the Froot Loops example matches the numbers on the pricing screen`() {
        val summary = ProfitCalculator.summarise(Money.of("4.559"), Money.of("7.99"))

        assertEquals("$3.43", summary.grossProfit.format())
        assertEquals("42.9%", ProfitCalculator.formatPercent(summary.grossMarginPercent))
        assertEquals("75.3%", ProfitCalculator.formatPercent(summary.markupPercent))
    }

    @Test
    fun `margin and markup are different numbers and are not swapped`() {
        val summary = ProfitCalculator.summarise(Money.of("2.00"), Money.of("4.00"))

        assertEquals(Money.of("2.00"), summary.grossProfit)
        assertEquals("50.0%", ProfitCalculator.formatPercent(summary.grossMarginPercent))
        assertEquals("100.0%", ProfitCalculator.formatPercent(summary.markupPercent))
    }

    @Test
    fun `a zero denominator yields no percentage rather than a crash`() {
        assertNull(ProfitCalculator.summarise(Money.ZERO, Money.of("4.00")).markupPercent)
        assertNull(ProfitCalculator.summarise(Money.of("2.00"), Money.ZERO).grossMarginPercent)
        assertEquals("-", ProfitCalculator.formatPercent(null))
    }

    @Test
    fun `selling below cost produces a negative profit, not an absolute value`() {
        val summary = ProfitCalculator.summarise(Money.of("5.00"), Money.of("4.00"))
        assertTrue(summary.grossProfit.isNegative)
        assertEquals("-25.0%", ProfitCalculator.formatPercent(summary.grossMarginPercent))
    }

    @Test
    fun `a wholesale cost increase is reported with amount and percent`() {
        val change = ProfitCalculator.compareCost(Money.of("4.36"), Money.of("5.12"), BigDecimal("10"))

        assertEquals("$0.76", change.changeAmount.format())
        assertEquals("+17.4%", ProfitCalculator.formatSignedPercent(change.changePercent))
        assertTrue(change.exceedsThreshold)
        assertTrue(change.isIncrease)
    }

    @Test
    fun `a move under the threshold is not raised as an alert`() {
        val change = ProfitCalculator.compareCost(Money.of("4.36"), Money.of("4.50"), BigDecimal("10"))
        assertFalse(change.exceedsThreshold)
    }

    @Test
    fun `a cost drop is detected too`() {
        val change = ProfitCalculator.compareCost(Money.of("5.12"), Money.of("4.36"), BigDecimal("10"))
        assertTrue(change.isDecrease)
        assertTrue(change.exceedsThreshold)
        assertEquals("-14.8%", ProfitCalculator.formatSignedPercent(change.changePercent))
    }

    @Test
    fun `average gross margin is weighted by sales value`() {
        val average = ProfitCalculator.averageGrossMarginPercent(Money.of("100.00"), Money.of("250.00"))
        assertEquals("60.0%", ProfitCalculator.formatPercent(average))
    }
}
