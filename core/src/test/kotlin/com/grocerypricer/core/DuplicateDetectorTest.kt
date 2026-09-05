package com.grocerypricer.core

import com.grocerypricer.core.model.ParseIssueType
import com.grocerypricer.core.parser.ReceiptParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DuplicateDetectorTest {

    @Test
    fun `overlapping receipt photos are flagged, not silently merged`() {
        val first = ReceiptParser.toLines(SampleReceipts.PHOTO_ONE, imageId = 1L)
        val second = ReceiptParser.toLines(SampleReceipts.PHOTO_TWO, imageId = 2L, startIndex = first.size)
        val receipt = ReceiptParser.parse(first + second)

        assertEquals(4, receipt.items.size)
        val flagged = receipt.items.filter { it.hasIssue(ParseIssueType.POSSIBLE_PHOTO_OVERLAP) }
        assertEquals(1, flagged.size)
        assertEquals("KELL FROOT LOOP FM 13.2Z", flagged.single().description)
        assertEquals(2L, flagged.single().imageId)
    }

    @Test
    fun `the same line read twice in one photo is flagged`() {
        val receipt = ReceiptParser.parseText(
            """
            HELLM MAYONNAISE 8Z
            CASE ${'$'}33.99 SIZE 12 UNIT ${'$'}2.83
            HELLM MAYONNAISE 8Z
            CASE ${'$'}33.99 SIZE 12 UNIT ${'$'}2.83
            """.trimIndent()
        )

        assertEquals(2, receipt.items.size)
        assertFalse(receipt.items[0].hasIssue(ParseIssueType.POSSIBLE_DUPLICATE_LINE))
        assertTrue(receipt.items[1].hasIssue(ParseIssueType.POSSIBLE_DUPLICATE_LINE))
    }

    @Test
    fun `the same product bought twice on one receipt is left alone`() {
        val receipt = ReceiptParser.parseText(
            """
            HELLM MAYONNAISE 8Z
            CASE ${'$'}33.99 SIZE 12 UNIT ${'$'}2.83
            R&W OIL VEGETABLE 48Z
            CASE ${'$'}39.25 SIZE 9 UNIT ${'$'}4.36
            KELL FROOT LOOP FM 13.2Z
            CASE ${'$'}57.59 SIZE 10 UNIT ${'$'}5.76
            DOWNY ULTRA APRIL FRESH 10Z
            CASE ${'$'}19.74 SIZE 6 UNIT ${'$'}3.29
            HELLM MAYONNAISE 8Z
            CASE ${'$'}33.99 SIZE 12 UNIT ${'$'}2.83
            """.trimIndent()
        )

        assertEquals(5, receipt.items.size)
        assertTrue(receipt.items.none { it.hasIssue(ParseIssueType.POSSIBLE_DUPLICATE_LINE) })
    }

    @Test
    fun `two different products are never treated as duplicates`() {
        val receipt = ReceiptParser.parseText(
            """
            HELLM MAYONNAISE 8Z
            CASE ${'$'}33.99 SIZE 12 UNIT ${'$'}2.83
            HELLM MAYONNAISE 15Z
            CASE ${'$'}44.99 SIZE 12 UNIT ${'$'}3.75
            """.trimIndent()
        )

        assertEquals(2, receipt.items.size)
        assertTrue(receipt.items.none { it.hasIssue(ParseIssueType.POSSIBLE_DUPLICATE_LINE) })
    }
}
