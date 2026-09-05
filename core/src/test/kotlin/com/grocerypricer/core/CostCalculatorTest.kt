package com.grocerypricer.core

import com.grocerypricer.core.model.DiscountScope
import com.grocerypricer.core.model.ReceiptDiscount
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.pricing.CostCalculator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CostCalculatorTest {

    @Test
    fun `Hellmanns mayonnaise - case discount gives a true unit cost of 2 dollars 17`() {
        val result = CostCalculator.calculate(
            casePrice = Money.of("33.99"),
            unitsPerCase = 12,
            discount = ReceiptDiscount("Flyer 43", Money.of("8.00"), DiscountScope.WHOLE_CASE),
        )

        assertEquals(Money.of("25.99"), result.netCaseCost)
        assertEquals("$2.17", result.displayUnitCost.format())
        assertEquals(Money.of("8.00"), result.totalDiscount)
        assertEquals(12, result.totalUnits)
        assertEquals(Money.of("25.99"), result.totalWholesaleCost)
    }

    @Test
    fun `Kelloggs Froot Loops - 57 dollars 59 less 12 over 10 units is 4 dollars 56`() {
        val result = CostCalculator.calculate(
            casePrice = Money.of("57.59"),
            unitsPerCase = 10,
            discount = ReceiptDiscount("Flyer 43", Money.of("12.00"), DiscountScope.WHOLE_CASE),
        )

        assertEquals(Money.of("45.59"), result.netCaseCost)
        assertEquals("4.5590", result.trueUnitCost.amount.toPlainString())
        assertEquals("$4.56", result.displayUnitCost.format())
    }

    @Test
    fun `Ultra Downy April Fresh - six units at 3 dollars 29 each`() {
        val result = CostCalculator.calculate(casePrice = Money.of("19.74"), unitsPerCase = 6)

        assertEquals("$3.29", result.displayUnitCost.format())
        assertFalse(result.hasDiscount)
    }

    @Test
    fun `R and W vegetable oil - no discount, 39 dollars 25 over 9 units`() {
        val result = CostCalculator.calculate(casePrice = Money.of("39.25"), unitsPerCase = 9)
        assertEquals("$4.36", result.displayUnitCost.format())
    }

    @Test
    fun `three cases multiply inventory but not the unit cost`() {
        val result = CostCalculator.calculate(
            casePrice = Money.of("33.99"),
            unitsPerCase = 12,
            casesPurchased = 3,
        )

        assertEquals(36, result.totalUnits)
        assertEquals("$2.83", result.displayUnitCost.format())
        assertEquals(Money.of("101.97"), result.totalWholesaleCost)
    }

    @Test
    fun `a whole-case discount repeats for every case bought`() {
        val result = CostCalculator.calculate(
            casePrice = Money.of("33.99"),
            unitsPerCase = 12,
            casesPurchased = 3,
            discount = ReceiptDiscount("Flyer", Money.of("8.00"), DiscountScope.WHOLE_CASE),
        )

        assertEquals(Money.of("25.99"), result.netCaseCost)
        assertEquals(Money.of("24.00"), result.totalDiscount)
        assertEquals(Money.of("77.97"), result.totalWholesaleCost)
        assertEquals("$2.17", result.displayUnitCost.format())
    }

    @Test
    fun `a per-unit discount comes off every retail piece`() {
        val result = CostCalculator.calculate(
            casePrice = Money.of("33.99"),
            unitsPerCase = 12,
            discount = ReceiptDiscount("Coupon", Money.of("0.50"), DiscountScope.PER_UNIT),
        )

        assertEquals(Money.of("6.00"), result.discountPerCase)
        assertEquals(Money.of("27.99"), result.netCaseCost)
        assertEquals("$2.33", result.displayUnitCost.format())
    }

    @Test
    fun `a subset discount only applies to the units it names`() {
        val result = CostCalculator.calculate(
            casePrice = Money.of("33.99"),
            unitsPerCase = 12,
            discount = ReceiptDiscount("Coupon", Money.of("1.00"), DiscountScope.UNITS_SUBSET, appliesToUnits = 4),
        )

        assertEquals(Money.of("4.00"), result.discountPerCase)
        assertEquals(Money.of("29.99"), result.netCaseCost)
    }

    @Test
    fun `a flat custom discount spreads over the cases bought`() {
        val result = CostCalculator.calculate(
            casePrice = Money.of("33.99"),
            unitsPerCase = 12,
            casesPurchased = 2,
            discount = ReceiptDiscount("Order allowance", Money.of("10.00"), DiscountScope.CUSTOM),
        )

        assertEquals(Money.of("5.00"), result.discountPerCase)
        assertEquals(Money.of("57.98"), result.totalWholesaleCost)
        assertEquals(Money.of("10.00"), result.totalDiscount)
    }

    @Test
    fun `an unknown or ignored discount changes nothing until the user decides`() {
        val unknown = CostCalculator.calculate(
            casePrice = Money.of("33.99"),
            unitsPerCase = 12,
            discount = ReceiptDiscount("Flyer", Money.of("8.00"), DiscountScope.UNKNOWN),
        )
        val ignored = CostCalculator.calculate(
            casePrice = Money.of("33.99"),
            unitsPerCase = 12,
            discount = ReceiptDiscount("Flyer", Money.of("8.00"), DiscountScope.IGNORED),
        )

        assertEquals(Money.of("33.99"), unknown.netCaseCost)
        assertEquals(Money.of("33.99"), ignored.netCaseCost)
        assertFalse(unknown.hasDiscount)
    }

    @Test
    fun `loose units are costed at the true unit cost`() {
        val result = CostCalculator.calculate(
            casePrice = Money.of("33.99"),
            unitsPerCase = 12,
            casesPurchased = 1,
            looseUnits = 3,
            discount = ReceiptDiscount("Flyer", Money.of("8.00"), DiscountScope.WHOLE_CASE),
        )

        assertEquals(15, result.totalUnits)
        // 25.99 + (3 x 2.1658) = 32.4874
        assertEquals("$32.49", result.totalWholesaleCost.format())
    }

    @Test
    fun `a discount larger than the case never produces a negative cost`() {
        val result = CostCalculator.calculate(
            casePrice = Money.of("10.00"),
            unitsPerCase = 4,
            discount = ReceiptDiscount("Bad read", Money.of("40.00"), DiscountScope.WHOLE_CASE),
        )

        assertEquals(Money.ZERO, result.netCaseCost)
        assertEquals(Money.ZERO, result.trueUnitCost)
        assertTrue(
            CostCalculator.discountExceedsPrice(
                ReceiptDiscount("Bad read", Money.of("40.00"), DiscountScope.WHOLE_CASE),
                Money.of("10.00"),
                4,
            )
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a case with zero units is rejected rather than dividing by zero`() {
        CostCalculator.calculate(casePrice = Money.of("10.00"), unitsPerCase = 0)
    }
}
