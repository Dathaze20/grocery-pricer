package com.grocerypricer.core

import com.grocerypricer.core.matching.SizeParser
import com.grocerypricer.core.model.DiscountScope
import com.grocerypricer.core.model.ItemConfidence
import com.grocerypricer.core.model.ParseIssueType
import com.grocerypricer.core.model.PricingSource
import com.grocerypricer.core.model.ReceiptDiscount
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.parser.OcrTextNormalizer
import com.grocerypricer.core.parser.ReceiptParser
import com.grocerypricer.core.pricing.CostCalculator
import com.grocerypricer.core.pricing.PricingEngine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The cases that would cost a store money if they were wrong.
 *
 * Everything here came out of asking "what does a receipt do on a bad day?" - a free case, a
 * discount that swallows the whole product, a pack count that cannot be real, a cost that lands
 * exactly on a tier boundary.
 */
class CostEdgeCaseTest {

    @Test
    fun `a free case costs nothing per unit and does not divide by zero`() {
        val result = CostCalculator.calculate(casePrice = Money.ZERO, unitsPerCase = 12)

        assertEquals(Money.ZERO, result.trueUnitCost)
        assertEquals(Money.ZERO, result.totalWholesaleCost)
        assertEquals(12, result.totalUnits)
    }

    @Test
    fun `a case of one unit costs what the case costs`() {
        val result = CostCalculator.calculate(casePrice = Money.of("5.00"), unitsPerCase = 1)

        assertEquals(Money.of("5.00"), result.trueUnitCost)
        assertEquals(1, result.totalUnits)
    }

    @Test
    fun `a very large case still divides exactly`() {
        val result = CostCalculator.calculate(casePrice = Money.of("100.00"), unitsPerCase = 500)

        assertEquals(Money.of("0.20"), result.trueUnitCost)
        assertEquals(500, result.totalUnits)
        assertEquals(Money.of("100.00"), result.totalWholesaleCost)
    }

    @Test
    fun `a cost that does not divide evenly keeps the fraction and never leaks it into the total`() {
        // $10.00 across 3 units is $3.3333..., which no number of cents can represent.
        val result = CostCalculator.calculate(casePrice = Money.of("10.00"), unitsPerCase = 3)

        assertEquals("3.3333", result.trueUnitCost.amount.toPlainString())
        assertEquals("$3.33", result.displayUnitCost.format())
        // The total is taken from the case price, not from rounded unit costs, so the third of a
        // cent that cannot be represented never accumulates into a wrong order total.
        assertEquals(Money.of("10.00"), result.totalWholesaleCost)
    }

    @Test
    fun `three cases of an uneven division still total exactly three case prices`() {
        val result = CostCalculator.calculate(casePrice = Money.of("10.00"), unitsPerCase = 3, casesPurchased = 3)

        assertEquals(Money.of("30.00"), result.totalWholesaleCost)
        assertEquals(9, result.totalUnits)
    }

    @Test
    fun `a discount exactly equal to the case price makes the product free, not negative`() {
        val discount = ReceiptDiscount("Full promo", Money.of("33.99"), DiscountScope.WHOLE_CASE)
        val result = CostCalculator.calculate(Money.of("33.99"), 12, discount = discount)

        assertEquals(Money.ZERO, result.netCaseCost)
        assertEquals(Money.ZERO, result.trueUnitCost)
        assertFalse(result.trueUnitCost.isNegative)
        // Equal is not "exceeds" - a 100% promotion is unusual but legitimate, so it is not an error.
        assertFalse(CostCalculator.discountExceedsPrice(discount, Money.of("33.99"), 12))
    }

    @Test
    fun `a discount larger than the case is clamped and reported`() {
        val discount = ReceiptDiscount("Misread", Money.of("50.00"), DiscountScope.WHOLE_CASE)
        val result = CostCalculator.calculate(Money.of("33.99"), 12, discount = discount)

        assertEquals(Money.ZERO, result.netCaseCost)
        assertFalse(result.trueUnitCost.isNegative)
        assertTrue(CostCalculator.discountExceedsPrice(discount, Money.of("33.99"), 12))
    }

    @Test
    fun `a per-unit discount that swallows the unit cost cannot go negative`() {
        val discount = ReceiptDiscount("Too big", Money.of("5.00"), DiscountScope.PER_UNIT)
        val result = CostCalculator.calculate(Money.of("33.99"), 12, discount = discount)

        assertEquals(Money.ZERO, result.netCaseCost)
        assertTrue(CostCalculator.discountExceedsPrice(discount, Money.of("33.99"), 12))
    }

    @Test
    fun `a subset discount cannot claim more units than the case holds`() {
        val discount = ReceiptDiscount("Coupon", Money.of("1.00"), DiscountScope.UNITS_SUBSET, appliesToUnits = 99)
        val result = CostCalculator.calculate(Money.of("33.99"), 12, discount = discount)

        // Capped at the 12 units that actually exist, not 99.
        assertEquals(Money.of("12.00"), result.discountPerCase)
        assertEquals(Money.of("21.99"), result.netCaseCost)
    }

    @Test
    fun `two flyer lines on one product are added together`() {
        val receipt = ReceiptParser.parseText(
            """
            HELLM MAYONNAISE 8Z
            CASE ${'$'}33.99 SIZE 12 UNIT ${'$'}2.83
            Flyer 43 - HELLM MAYONNAISE
            -${'$'}5.00
            Flyer 44 - HELLM MAYONNAISE
            -${'$'}3.00
            """.trimIndent()
        )
        val item = receipt.items.single()

        assertEquals(Money.of("8.00"), item.discount?.amount)
        assertEquals(DiscountScope.WHOLE_CASE, item.discount?.scope)
        val cost = CostCalculator.calculate(item.casePrice!!, item.unitsPerCase!!, discount = item.discount)
        assertEquals(Money.of("25.99"), cost.netCaseCost)
        assertEquals("$2.17", cost.displayUnitCost.format())
    }

    @Test
    fun `a pack count that cannot be real is flagged rather than used`() {
        val receipt = ReceiptParser.parseText(
            """
            SOME PRODUCT 8Z
            CASE ${'$'}33.99 SIZE 9999 UNIT ${'$'}2.83
            """.trimIndent()
        )
        val item = receipt.items.single()

        assertTrue(item.hasIssue(ParseIssueType.IMPOSSIBLE_QUANTITY))
        assertEquals(ItemConfidence.PROBLEM, item.confidence)
    }
}

/** Prices must not wobble at the edges of the cost ladder. */
class PricingBoundaryTest {

    private val engine = PricingEngine()

    private fun priceAt(cost: String) = engine.suggest(Money.of(cost)).suggestedPrice.format()

    @Test
    fun `every documented tier boundary prices deterministically`() {
        assertEquals("$2.99", priceAt("0.00"))
        assertEquals("$2.99", priceAt("1.24"))
        assertEquals("$3.99", priceAt("1.25"))
        assertEquals("$3.99", priceAt("1.99"))
        assertEquals("$4.99", priceAt("2.00"))
        assertEquals("$4.99", priceAt("2.99"))
        assertEquals("$5.99", priceAt("3.00"))
        assertEquals("$5.99", priceAt("3.99"))
        assertEquals("$7.99", priceAt("4.00"))
        assertEquals("$7.99", priceAt("4.99"))
        assertEquals("$8.99", priceAt("5.00"))
        assertEquals("$8.99", priceAt("5.99"))
        assertEquals("$10.99", priceAt("6.00"))
        assertEquals("$10.99", priceAt("7.99"))
        assertEquals("$13.99", priceAt("8.00"))
        assertEquals("$13.99", priceAt("9.99"))
    }

    @Test
    fun `a free product still gets a shelf price from the first tier`() {
        val suggestion = engine.suggest(Money.ZERO)

        assertEquals(Money.of("2.99"), suggestion.suggestedPrice)
        assertEquals(PricingSource.COST_TIER, suggestion.source)
    }

    @Test
    fun `an unknown cost is not the same as a zero cost`() {
        val suggestion = engine.suggest(null)

        assertEquals(PricingSource.NO_COST, suggestion.source)
        assertEquals(Money.ZERO, suggestion.suggestedPrice)
    }

    @Test
    fun `the first cost above the ladder switches to the markup rule`() {
        val below = engine.suggest(Money.of("9.99"))
        val above = engine.suggest(Money.of("10.00"))

        assertEquals(PricingSource.COST_TIER, below.source)
        assertEquals(PricingSource.MARKUP, above.source)
        // 10.00 + 60% = 16.00, taken up to the next .99
        assertEquals(Money.of("16.99"), above.suggestedPrice)
    }

    @Test
    fun `the same cost always produces the same price`() {
        val prices = (1..25).map { engine.suggest(Money.of("4.559")).suggestedPrice }
        assertEquals(1, prices.distinct().size)
        assertEquals(Money.of("7.99"), prices.first())
    }

    @Test
    fun `a cost landing between two printed tiers still gets a tier, not the markup fallback`() {
        // A case price divided by a pack count rarely lands on a whole cent, so $1.2450 is an
        // ordinary result. It must not fall through the gap between the 1.24 and 1.25 tiers.
        listOf("1.2401", "1.2450", "1.2499").forEach { cost ->
            val suggestion = engine.suggest(Money.of(cost))
            assertEquals("cost " + cost + " should use the ladder", PricingSource.COST_TIER, suggestion.source)
            assertEquals(Money.of("2.99"), suggestion.suggestedPrice)
        }
        assertEquals("$3.99", priceAt("1.25"))
        assertEquals(PricingSource.COST_TIER, engine.suggest(Money.of("2.995")).source)
        assertEquals(PricingSource.COST_TIER, engine.suggest(Money.of("7.9999")).source)
    }
}

/** Sizes and names as wholesale receipts actually print them. */
class SizeAndNameEdgeCaseTest {

    @Test
    fun `the package sizes a grocery receipt prints all parse`() {
        assertEquals("6 OZ", SizeParser.canonicalOrNull("STORE BRAND KETCHUP 6 OZ"))
        assertEquals("12 CT", SizeParser.canonicalOrNull("PAPER TOWELS 12 CT"))
        assertEquals("1 GAL", SizeParser.canonicalOrNull("SPRING WATER 1 GAL"))
        assertEquals("2.5 LB", SizeParser.canonicalOrNull("RICE 2.5 LB"))
        assertEquals("750 ML", SizeParser.canonicalOrNull("SPARKLING 750ML"))
    }

    @Test
    fun `a multipack prints the retail unit size last, and that is what is taken`() {
        // "24/12 OZ" is 24 cans of 12 oz - the piece on the shelf is the 12 oz can.
        assertEquals("12 OZ", SizeParser.canonicalOrNull("COLA 24/12 OZ"))
    }

    @Test
    fun `a brand containing digits is not mistaken for a size`() {
        assertNull(SizeParser.canonicalOrNull("7UP SODA"))
        assertNull(SizeParser.canonicalOrNull("V8 JUICE"))
        assertEquals("2 L", SizeParser.canonicalOrNull("7UP SODA 2 L"))
    }

    @Test
    fun `a product whose name contains numbers still parses off a receipt`() {
        val receipt = ReceiptParser.parseText(
            """
            7UP SODA 2L
            CASE ${'$'}12.00 SIZE 6 UNIT ${'$'}2.00
            """.trimIndent()
        )
        val item = receipt.items.single()

        assertEquals("7UP SODA 2L", item.description)
        assertEquals(Money.of("12.00"), item.casePrice)
        assertEquals(6, item.unitsPerCase)
        assertEquals(ItemConfidence.HIGH, item.confidence)
    }
}

/** Character correction must only ever touch things that are already numbers. */
class OcrCorrectionEdgeCaseTest {

    @Test
    fun `a letter O inside a price becomes a zero`() {
        assertEquals("${'$'}33.90", OcrTextNormalizer.normalize("${'$'}33.9O").text)
        assertEquals("${'$'}2.83", OcrTextNormalizer.normalize("${'$'}2.B3").text)
    }

    @Test
    fun `a token that is more letters than digits is left alone even though it could be a number`() {
        // "1OO" might be a misread 100 - or a product code. Correction only fires once a token
        // is already at least half digits, because corrupting a product name is worse than
        // leaving one ambiguous number for the review screen to catch.
        assertEquals("1OO", OcrTextNormalizer.normalize("1OO").text)
        assertFalse(OcrTextNormalizer.normalize("1OO").correctedCharacters)
    }

    @Test
    fun `product words that look like digits are left completely alone`() {
        // Every one of these contains an O, I, S or B that a naive global replace would destroy.
        listOf(
            "GOYA BEANS",
            "BOUNTY TOWELS",
            "LYSOL",
            "SOS PADS",
            "BIB LETTUCE",
            "ORE IDA",
        ).forEach { name ->
            assertEquals(name, OcrTextNormalizer.normalize(name).text)
            assertFalse("$name should not be reported as corrected", OcrTextNormalizer.normalize(name).correctedCharacters)
        }
    }

    @Test
    fun `a size token keeps its unit letter`() {
        assertEquals("HELLM MAYONNAISE 8Z", OcrTextNormalizer.normalize("HELLM MAYONNAISE 8Z").text)
        assertEquals("KELL FROOT LOOP FM 13.2Z", OcrTextNormalizer.normalize("KELL FROOT LOOP FM 13.2Z").text)
    }

    @Test
    fun `a misread receipt still produces the right cost once corrected`() {
        val receipt = ReceiptParser.parseText(SampleReceipts.JETRO_MESSY_OCR)
        val item = receipt.items.single()
        val cost = CostCalculator.calculate(item.casePrice!!, item.unitsPerCase!!)

        assertEquals("$2.83", cost.displayUnitCost.format())
        // Corrected, so the row is flagged for a human to glance at rather than trusted silently.
        assertTrue(item.hasIssue(ParseIssueType.AMBIGUOUS_CHARACTERS))
    }
}

/** Deduplication must never quietly delete a real purchase. */
class DuplicateEdgeCaseTest {

    @Test
    fun `the same product bought twice at different prices is two separate rows`() {
        val receipt = ReceiptParser.parseText(
            """
            HELLM MAYONNAISE 8Z
            CASE ${'$'}33.99 SIZE 12 UNIT ${'$'}2.83
            HELLM MAYONNAISE 8Z
            CASE ${'$'}31.99 SIZE 12 UNIT ${'$'}2.67
            """.trimIndent()
        )

        assertEquals(2, receipt.items.size)
        // Different case prices means different signatures - never a duplicate.
        assertTrue(receipt.items.none { it.hasIssue(ParseIssueType.POSSIBLE_DUPLICATE_LINE) })
    }

    @Test
    fun `an overlap is flagged but both rows survive for the user to decide`() {
        val first = ReceiptParser.toLines(SampleReceipts.PHOTO_ONE, imageId = 1L)
        val second = ReceiptParser.toLines(SampleReceipts.PHOTO_TWO, imageId = 2L, startIndex = first.size)
        val receipt = ReceiptParser.parse(first + second)

        // Nothing is deleted. The user is told, and keeps or drops the row themselves.
        assertEquals(4, receipt.items.size)
        assertEquals(1, receipt.items.count { it.hasIssue(ParseIssueType.POSSIBLE_PHOTO_OVERLAP) })
    }

    @Test
    fun `a discount is never attached to a product it does not name`() {
        val receipt = ReceiptParser.parseText(SampleReceipts.JETRO_MISMATCHED_DISCOUNT)
        val item = receipt.items.single()

        assertNotNull(item.discount)
        assertEquals(DiscountScope.UNKNOWN, item.discount?.scope)
        // Unknown scope changes nothing until a human says how it applies.
        val cost = CostCalculator.calculate(item.casePrice!!, item.unitsPerCase!!, discount = item.discount)
        assertEquals(Money.of("39.25"), cost.netCaseCost)
    }
}

/** A CSV that a spreadsheet cannot read is a CSV that failed. */
class CsvEdgeCaseTest {

    @Test
    fun `a value containing a line break survives as one field`() {
        val csv = com.grocerypricer.core.util.CsvWriter.build(
            header = listOf("Product", "Note"),
            rows = listOf(listOf("Mayo", "Damaged case\nrefund pending")),
        )
        assertTrue(csv.contains("\"Damaged case\nrefund pending\""))
        // Header, then one record whose embedded newline is inside quotes.
        assertEquals(2, csv.trim().split("\n").count { it.startsWith("Product") || it.startsWith("Mayo") })
    }

    @Test
    fun `accented and non-latin product names are preserved`() {
        val csv = com.grocerypricer.core.util.CsvWriter.build(
            header = listOf("Product"),
            rows = listOf(listOf("Café Bustelo"), listOf("Jalapeños"), listOf("Goya Adobo")),
        )
        assertTrue(csv.contains("Café Bustelo"))
        assertTrue(csv.contains("Jalapeños"))
    }

    @Test
    fun `the spreadsheet form carries a UTF-8 byte order mark and nothing else changes`() {
        val plain = com.grocerypricer.core.util.CsvWriter.build(listOf("A"), listOf(listOf("1")))
        val forFile = com.grocerypricer.core.util.CsvWriter.buildForSpreadsheet(listOf("A"), listOf(listOf("1")))

        assertTrue(forFile.startsWith("﻿"))
        assertEquals(plain, forFile.removePrefix("﻿"))
        // The mark is a single character, so byte length grows by exactly the UTF-8 BOM.
        assertEquals(plain.toByteArray(Charsets.UTF_8).size + 3, forFile.toByteArray(Charsets.UTF_8).size)
    }

    @Test
    fun `a quote inside a name is doubled, not dropped`() {
        val csv = com.grocerypricer.core.util.CsvWriter.build(
            header = listOf("Product"),
            rows = listOf(listOf("6\" Foil Pan")),
        )
        assertTrue(csv.contains("\"6\"\" Foil Pan\""))
    }

    @Test
    fun `every row has the same number of fields as the header`() {
        val csv = com.grocerypricer.core.util.CsvWriter.build(
            header = listOf("A", "B", "C"),
            rows = listOf(listOf("1", null, "3"), listOf(null, null, null)),
        )
        csv.trim().split("\n").forEach { line ->
            assertEquals("row \"$line\" should have 3 fields", 3, line.split(",").size)
        }
    }
}
