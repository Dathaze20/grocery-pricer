package com.grocerypricer.core

import com.grocerypricer.core.ai.AiExtractedItem
import com.grocerypricer.core.ai.AiOrderExtraction
import com.grocerypricer.core.ai.ExtractionMerger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ExtractionMergerTest {

    private fun item(
        name: String,
        size: String?,
        casePrice: String?,
        photo: Long,
        confidence: Double = 0.9,
        unitsPerCase: Int? = 12,
        upc: String? = null,
        cases: Int? = 1,
    ) = AiExtractedItem(
        rawName = name,
        canonicalName = name,
        size = size,
        upc = upc,
        casePrice = casePrice,
        unitsPerCase = unitsPerCase,
        casesPurchased = cases,
        sourcePhotoIds = listOf(photo),
        sourceText = listOf("$name line from photo $photo"),
        confidence = confidence,
    )

    private fun merge(vararg batches: List<AiExtractedItem>) =
        ExtractionMerger.merge(batches.map { AiOrderExtraction("Jetro", it) })

    @Test
    fun `the same product in two overlapping photos is counted once`() {
        val merged = merge(
            listOf(item("Hellmann's Mayonnaise", "8 oz", "33.99", photo = 1)),
            listOf(item("Hellmann's Mayonnaise", "8 oz", "33.99", photo = 2)),
        )
        val only = merged.items.single()
        assertEquals(listOf(1L, 2L), only.sourcePhotoIds)
        // Both photographs show one case. Two would be two cases of cost.
        assertEquals(1, only.casesPurchased)
    }

    @Test
    fun `the same product at two different case prices is two real purchases`() {
        val merged = merge(
            listOf(item("Hellmann's Mayonnaise", "8 oz", "33.99", photo = 1)),
            listOf(item("Hellmann's Mayonnaise", "8 oz", "29.99", photo = 2)),
        )
        assertEquals(2, merged.items.size)
    }

    @Test
    fun `two sizes of the same product never merge`() {
        val merged = merge(
            listOf(item("Hellmann's Mayonnaise", "8 oz", "33.99", photo = 1)),
            listOf(item("Hellmann's Mayonnaise", "15 oz", "33.99", photo = 2)),
        )
        assertEquals(2, merged.items.size)
    }

    @Test
    fun `the clearer reading wins and fills the gaps in the blurrier one`() {
        val merged = merge(
            listOf(item("HELLM MAYONNAISE", "8 oz", "33.99", photo = 1, confidence = 0.4, unitsPerCase = null)),
            listOf(item("Hellmann's Mayonnaise", "8 oz", "33.99", photo = 2, confidence = 0.95)),
        )
        val only = merged.items.single()
        assertEquals("Hellmann's Mayonnaise", only.canonicalName)
        assertEquals(12, only.unitsPerCase)
        assertEquals(0.95, only.confidence, 0.0001)
    }

    @Test
    fun `a field only the blurrier photo could read is still kept`() {
        val merged = merge(
            listOf(item("Mayo", "8 oz", "33.99", photo = 1, confidence = 0.3, upc = "050000000123")),
            listOf(item("Mayo", "8 oz", "33.99", photo = 2, confidence = 0.9, upc = null)),
        )
        assertEquals("050000000123", merged.items.single().upc)
    }

    @Test
    fun `a barcode identifies a product even when the name was read differently`() {
        val merged = merge(
            listOf(item("HELLM MAYO 8Z", null, "33.99", photo = 1, upc = "050000000123")),
            listOf(item("Hellmann's Mayonnaise", "8 oz", "33.99", photo = 2, upc = "050000000123")),
        )
        assertEquals(1, merged.items.size)
    }

    @Test
    fun `source lines from both photos are kept and not duplicated`() {
        val merged = merge(
            listOf(item("Mayo", "8 oz", "33.99", photo = 1)),
            listOf(item("Mayo", "8 oz", "33.99", photo = 2)),
            listOf(item("Mayo", "8 oz", "33.99", photo = 2)),
        )
        val only = merged.items.single()
        assertEquals(2, only.sourceText.size)
        assertEquals(listOf(1L, 2L), only.sourcePhotoIds)
    }

    @Test
    fun `rows whose price could not be read do not all collapse into one`() {
        val merged = merge(
            listOf(item("Mayo", "8 oz", null, photo = 1), item("Tide", "40 oz", null, photo = 1)),
        )
        assertEquals(2, merged.items.size)
    }

    @Test
    fun `merging nothing, or one batch, is not a special case that breaks`() {
        assertEquals(0, ExtractionMerger.merge(emptyList()).items.size)
        val single = listOf(item("Mayo", "8 oz", "33.99", photo = 1))
        assertEquals(1, merge(single).items.size)
    }

    @Test
    fun `warnings from every batch survive, without repeats`() {
        val merged = ExtractionMerger.merge(
            listOf(
                AiOrderExtraction("Jetro", emptyList(), listOf("a discount had no product")),
                AiOrderExtraction(null, emptyList(), listOf("a discount had no product", "page 3 was blurred")),
            ),
        )
        assertEquals(listOf("a discount had no product", "page 3 was blurred"), merged.warnings)
        assertTrue(merged.supplier == "Jetro")
    }
}
