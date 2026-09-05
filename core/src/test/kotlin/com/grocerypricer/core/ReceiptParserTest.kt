package com.grocerypricer.core

import com.grocerypricer.core.model.Category
import com.grocerypricer.core.model.DiscountScope
import com.grocerypricer.core.model.ItemConfidence
import com.grocerypricer.core.model.ParseIssueType
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.parser.ReceiptParser
import com.grocerypricer.core.pricing.CostCalculator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReceiptParserTest {

    @Test
    fun `a Jetro page yields one row per product with the discount attached`() {
        val receipt = ReceiptParser.parseText(SampleReceipts.JETRO_PAGE_ONE)

        assertEquals(3, receipt.items.size)
        assertEquals(3, receipt.highConfidenceCount)
        assertTrue(receipt.unmatchedDiscounts.isEmpty())

        val mayo = receipt.items[0]
        assertEquals("HELLM MAYONNAISE 8Z", mayo.description)
        assertEquals(Money.of("33.99"), mayo.casePrice)
        assertEquals(12, mayo.unitsPerCase)
        assertEquals(Money.of("2.83"), mayo.printedUnitCost)
        assertEquals("8 OZ", mayo.packageSize)
        assertEquals(Category.CONDIMENTS, mayo.category)
        assertEquals(Money.of("8.00"), mayo.discount?.amount)
        assertEquals(DiscountScope.WHOLE_CASE, mayo.discount?.scope)
        assertEquals(ItemConfidence.HIGH, mayo.confidence)

        val oil = receipt.items[1]
        assertEquals("R&W OIL VEGETABLE 48Z", oil.description)
        assertEquals(Money.of("39.25"), oil.casePrice)
        assertEquals(9, oil.unitsPerCase)
        assertNull(oil.discount)
        assertEquals(Category.COOKING_OIL, oil.category)

        val cereal = receipt.items[2]
        assertEquals("KELL FROOT LOOP FM 13.2Z", cereal.description)
        assertEquals(Money.of("57.59"), cereal.casePrice)
        assertEquals(10, cereal.unitsPerCase)
        assertEquals(Money.of("12.00"), cereal.discount?.amount)
        assertEquals(DiscountScope.WHOLE_CASE, cereal.discount?.scope)
        assertEquals(Category.CEREAL, cereal.category)
    }

    @Test
    fun `parsed rows cost out to the numbers the store owner expects`() {
        val receipt = ReceiptParser.parseText(SampleReceipts.JETRO_PAGE_ONE)

        val costs = receipt.items.map { item ->
            CostCalculator.calculate(
                casePrice = item.casePrice!!,
                unitsPerCase = item.unitsPerCase!!,
                casesPurchased = item.casesPurchased,
                looseUnits = item.looseUnits,
                discount = item.discount,
            ).displayUnitCost.format()
        }

        assertEquals(listOf("$2.17", "$4.36", "$4.56"), costs)
    }

    @Test
    fun `receipt header and totals are not mistaken for products`() {
        val receipt = ReceiptParser.parseText(SampleReceipts.JETRO_PAGE_ONE)
        assertTrue(receipt.items.none { it.description?.contains("TOTAL", ignoreCase = true) == true })
        assertTrue(receipt.items.none { it.description?.contains("INVOICE", ignoreCase = true) == true })
    }

    @Test
    fun `common OCR character confusions are corrected and the row is flagged for a look`() {
        val receipt = ReceiptParser.parseText(SampleReceipts.JETRO_MESSY_OCR)
        val item = receipt.items.single()

        assertEquals(Money.of("33.99"), item.casePrice)
        assertEquals(12, item.unitsPerCase)
        assertEquals(Money.of("2.83"), item.printedUnitCost)
        assertTrue(item.hasIssue(ParseIssueType.AMBIGUOUS_CHARACTERS))
        assertEquals(ItemConfidence.NEEDS_REVIEW, item.confidence)
    }

    @Test
    fun `a case count on its own line multiplies the inventory`() {
        val receipt = ReceiptParser.parseText(SampleReceipts.JETRO_MULTI_CASE)
        val item = receipt.items.single()

        assertEquals(3, item.casesPurchased)
        val cost = CostCalculator.calculate(item.casePrice!!, item.unitsPerCase!!, item.casesPurchased)
        assertEquals(36, cost.totalUnits)
        assertEquals("$2.83", cost.displayUnitCost.format())
    }

    @Test
    fun `a discount naming a different product is left unapplied and flagged`() {
        val receipt = ReceiptParser.parseText(SampleReceipts.JETRO_MISMATCHED_DISCOUNT)
        val item = receipt.items.single()

        assertNotNull(item.discount)
        assertEquals(DiscountScope.UNKNOWN, item.discount?.scope)
        assertTrue(item.hasIssue(ParseIssueType.UNCERTAIN_DISCOUNT))
        assertEquals(ItemConfidence.NEEDS_REVIEW, item.confidence)

        // Until the user says how it applies, the discount must not move the cost.
        val cost = CostCalculator.calculate(item.casePrice!!, item.unitsPerCase!!, discount = item.discount)
        assertEquals(Money.of("39.25"), cost.netCaseCost)
    }

    @Test
    fun `a discount with nothing above it is reported instead of being attached at random`() {
        val receipt = ReceiptParser.parseText(
            """
            Flyer 43 - HELLM MAYONNAISE
            -${'$'}8.00
            R&W OIL VEGETABLE 48Z
            CASE ${'$'}39.25 SIZE 9 UNIT ${'$'}4.36
            """.trimIndent()
        )

        assertEquals(1, receipt.items.size)
        assertNull(receipt.items.single().discount)
        assertEquals(1, receipt.unmatchedDiscounts.size)
        assertEquals(Money.of("8.00"), receipt.unmatchedDiscounts.single().amount)
    }

    @Test
    fun `a description and its detail on one line still parse`() {
        val receipt = ReceiptParser.parseText("HELLM MAYONNAISE 8Z CASE ${'$'}33.99 SIZE 12 UNIT ${'$'}2.83")
        val item = receipt.items.single()

        assertEquals("HELLM MAYONNAISE 8Z", item.description)
        assertEquals(Money.of("33.99"), item.casePrice)
        assertEquals(ItemConfidence.HIGH, item.confidence)
    }

    @Test
    fun `a UPC on the description line is captured and kept out of the name`() {
        val receipt = ReceiptParser.parseText(
            """
            HELLM MAYONNAISE 8Z 048001215252
            CASE ${'$'}33.99 SIZE 12 UNIT ${'$'}2.83
            """.trimIndent()
        )
        val item = receipt.items.single()

        assertEquals("048001215252", item.upc)
        assertEquals("HELLM MAYONNAISE 8Z", item.description)
    }

    @Test
    fun `a case price that does not match the printed unit cost is flagged, not silently trusted`() {
        val receipt = ReceiptParser.parseText(
            """
            SOME PRODUCT 8Z
            CASE ${'$'}33.99 SIZE 12 UNIT ${'$'}9.99
            """.trimIndent()
        )
        val item = receipt.items.single()

        assertTrue(item.hasIssue(ParseIssueType.UNIT_PRICE_MISMATCH))
        assertEquals(ItemConfidence.NEEDS_REVIEW, item.confidence)
    }

    @Test
    fun `a missing case price is a problem the user has to resolve`() {
        val receipt = ReceiptParser.parseText(
            """
            SOME PRODUCT 8Z
            SIZE 12 UNIT ${'$'}2.83
            """.trimIndent()
        )
        val item = receipt.items.single()

        assertTrue(item.hasIssue(ParseIssueType.MISSING_CASE_PRICE))
        assertEquals(ItemConfidence.PROBLEM, item.confidence)
        assertFalse(item.confidence.autoApprovable)
        assertNull(item.casePrice)
    }

    @Test
    fun `a discount bigger than the case is a problem`() {
        val receipt = ReceiptParser.parseText(
            """
            HELLM MAYONNAISE 8Z
            CASE ${'$'}10.00 SIZE 12 UNIT ${'$'}0.83
            Flyer 43 - HELLM MAYONNAISE
            -${'$'}40.00
            """.trimIndent()
        )
        val item = receipt.items.single()

        assertTrue(item.hasIssue(ParseIssueType.DISCOUNT_EXCEEDS_PRICE))
        assertEquals(ItemConfidence.PROBLEM, item.confidence)
    }

    @Test
    fun `unreadable text produces no products rather than invented ones`() {
        val receipt = ReceiptParser.parseText("~~~~ \n ### \n ??? ")
        assertTrue(receipt.items.isEmpty())
    }

    @Test
    fun `empty input is handled without throwing`() {
        assertTrue(ReceiptParser.parseText("").items.isEmpty())
    }
}
