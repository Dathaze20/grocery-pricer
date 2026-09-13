package com.grocerypricer.core

import com.grocerypricer.core.ai.AiError
import com.grocerypricer.core.ai.AiExtractedDiscount
import com.grocerypricer.core.ai.AiExtractedItem
import com.grocerypricer.core.ai.AiExtractionValidator
import com.grocerypricer.core.ai.AiOrderExtraction
import com.grocerypricer.core.ai.AiResponseParser
import com.grocerypricer.core.ai.AiResult
import com.grocerypricer.core.ai.ExtractionIssue
import com.grocerypricer.core.ai.OrderQuestionResolution
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A model's reply is untrusted input arriving over the network. These tests are the contract that
 * nothing it can send - truncated, chatty, wrongly typed or outright invented - reaches the
 * database or crashes the app.
 */
class AiExtractionParsingTest {

    private fun ok(raw: String) = (AiResponseParser.parseOrderExtraction(raw) as AiResult.Success).value
    private fun err(raw: String?) = (AiResponseParser.parseOrderExtraction(raw) as AiResult.Failure).error

    @Test
    fun `reads a clean extraction`() {
        val extraction = ok(
            """
            {"supplier":"Jetro / Restaurant Depot","warnings":[],"items":[
              {"rawName":"HELLM MAYONNAISE 8Z","canonicalName":"Hellmann's Mayonnaise",
               "brand":"Hellmann's","size":"8 oz","upc":null,"supplierSku":null,
               "casePrice":"33.99","unitsPerCase":12,"printedUnitCost":"2.83","casesPurchased":1,
               "discount":{"amount":"8.00","scope":"WHOLE_CASE","appliesToUnits":null},
               "category":"Condiments","sourcePhotoIds":[2],"sourceText":["HELLM MAYONNAISE 8Z"],
               "confidence":0.96}]}
            """,
        )
        val item = extraction.items.single()
        assertEquals("Jetro / Restaurant Depot", extraction.supplier)
        assertEquals("Hellmann's Mayonnaise", item.canonicalName)
        assertEquals("33.99", item.casePrice)
        assertEquals(12, item.unitsPerCase)
        assertEquals("8.00", item.discount?.amount)
        assertEquals(listOf(2L), item.sourcePhotoIds)
    }

    @Test
    fun `digs the object out of a chatty reply`() {
        val extraction = ok(
            """
            Sure! Here is the order I read from those photos:

            ```json
            {"supplier":"Jetro","warnings":[],"items":[
              {"canonicalName":"Tide Original","size":"40 fl oz","casePrice":"52.00",
               "unitsPerCase":6,"confidence":0.9}]}
            ```

            Let me know if you need anything else.
            """,
        )
        assertEquals("Tide Original", extraction.items.single().canonicalName)
    }

    @Test
    fun `a product name containing a brace does not end the object early`() {
        val extraction = ok(
            """{"supplier":null,"warnings":[],"items":[
               {"canonicalName":"Odd } Brand {Cereal}","casePrice":"10.00","unitsPerCase":4,
                "confidence":0.8}]}""",
        )
        assertEquals("Odd } Brand {Cereal}", extraction.items.single().canonicalName)
    }

    @Test
    fun `truncated json is a clean failure, not a crash`() {
        val error = err("""{"supplier":"Jetro","items":[{"canonicalName":"Tide","casePrice":"52.0""")
        assertTrue(error is AiError.MalformedResponse)
    }

    @Test
    fun `empty and prose-only replies fail cleanly`() {
        assertTrue(err(null) is AiError.MalformedResponse)
        assertTrue(err("") is AiError.MalformedResponse)
        assertTrue(err("I could not read those photographs.") is AiError.MalformedResponse)
    }

    @Test
    fun `an object with no items array is rejected`() {
        assertTrue(err("""{"supplier":"Jetro"}""") is AiError.MalformedResponse)
    }

    @Test
    fun `an empty order parses to an empty list rather than failing`() {
        assertEquals(0, ok("""{"supplier":null,"warnings":[],"items":[]}""").items.size)
    }

    @Test
    fun `numbers sent where strings were asked for still read`() {
        // Models routinely answer 33.99 instead of "33.99". The literal characters survive.
        val item = ok(
            """{"items":[{"canonicalName":"Mayo","casePrice":33.99,"unitsPerCase":"12",
               "confidence":"0.9"}]}""",
        ).items.single()
        assertEquals("33.99", item.casePrice)
        assertEquals(12, item.unitsPerCase)
        assertEquals(0.9, item.confidence, 0.0001)
    }

    @Test
    fun `a missing confidence reads as unsure, never as certain`() {
        val item = ok("""{"items":[{"canonicalName":"Mayo","casePrice":"1.00"}]}""").items.single()
        assertEquals(0.0, item.confidence, 0.0)
    }

    @Test
    fun `nulls and absent fields are both absent`() {
        val item = ok(
            """{"items":[{"canonicalName":"Mayo","brand":null,"size":"null","upc":"",
               "casePrice":"1.00","confidence":0.5}]}""",
        ).items.single()
        assertNull(item.brand)
        assertNull(item.size)
        assertNull(item.upc)
    }

    @Test
    fun `an empty discount object is no discount`() {
        val item = ok(
            """{"items":[{"canonicalName":"Mayo","casePrice":"1.00","discount":{},"confidence":0.5}]}""",
        ).items.single()
        assertNull(item.discount)
    }

    @Test
    fun `unknown extra fields are ignored rather than fatal`() {
        val item = ok(
            """{"items":[{"canonicalName":"Mayo","casePrice":"1.00","confidence":0.5,
               "somethingNew":{"nested":true},"aisle":7}]}""",
        ).items.single()
        assertEquals("Mayo", item.canonicalName)
    }

    @Test
    fun `a partial extraction keeps the rows that did arrive`() {
        // The reply ran out of tokens mid-array, but the closing braces were still emitted for
        // the rows that made it. Those rows are real work and are worth keeping.
        val extraction = ok(
            """{"supplier":"Jetro","items":[
               {"canonicalName":"Mayo","casePrice":"33.99","unitsPerCase":12,"confidence":0.9},
               {"canonicalName":"Tide","casePrice":"52.00","unitsPerCase":6,"confidence":0.9}]}""",
        )
        assertEquals(2, extraction.items.size)
    }
}

class AiExtractionValidationTest {

    private fun itemOf(
        name: String? = "Hellmann's Mayonnaise",
        casePrice: String? = "33.99",
        unitsPerCase: Int? = 12,
        casesPurchased: Int? = 1,
        discount: AiExtractedDiscount? = null,
        confidence: Double = 0.9,
        sourcePhotoIds: List<Long> = listOf(1L),
    ) = AiExtractedItem(
        rawName = name,
        canonicalName = name,
        casePrice = casePrice,
        unitsPerCase = unitsPerCase,
        casesPurchased = casesPurchased,
        discount = discount,
        sourcePhotoIds = sourcePhotoIds,
        sourceText = listOf("line"),
        confidence = confidence,
    )

    private fun validate(vararg items: AiExtractedItem, photos: Set<Long> = setOf(1L)) =
        AiExtractionValidator.validate(AiOrderExtraction(null, items.toList()), photos)

    @Test
    fun `a nameless row is dropped because nothing could ever refer to it`() {
        val result = validate(itemOf(name = null))
        assertEquals(0, result.accepted.size)
        assertEquals(ExtractionIssue.NO_USABLE_NAME, result.rejected.single().reason)
    }

    @Test
    fun `an unreadable price keeps the row but marks it`() {
        val item = validate(itemOf(casePrice = "thirty three ninety nine")).accepted.single()
        assertNull(item.item.casePrice)
        assertTrue(ExtractionIssue.UNREADABLE_CASE_PRICE in item.issues)
        assertTrue(!item.isComplete)
    }

    @Test
    fun `a free case is a known cost, not a missing one`() {
        val item = validate(itemOf(casePrice = "0.00")).accepted.single()
        assertEquals("0.00", item.item.casePrice)
        assertTrue(item.isComplete)
    }

    @Test
    fun `a negative case price is refused`() {
        val item = validate(itemOf(casePrice = "-5.00")).accepted.single()
        assertNull(item.item.casePrice)
        assertTrue(ExtractionIssue.NEGATIVE_CASE_PRICE in item.issues)
    }

    @Test
    fun `a zero or absurd pack count is refused rather than used`() {
        assertTrue(
            ExtractionIssue.INVALID_UNITS_PER_CASE in
                validate(itemOf(unitsPerCase = 0)).accepted.single().issues,
        )
        assertTrue(
            ExtractionIssue.INVALID_UNITS_PER_CASE in
                validate(itemOf(unitsPerCase = 99_999)).accepted.single().issues,
        )
    }

    @Test
    fun `a missing case count means one case`() {
        assertEquals(1, validate(itemOf(casesPurchased = null)).accepted.single().item.casesPurchased)
    }

    @Test
    fun `a discount larger than the case is a misread and is refused`() {
        val item = validate(
            itemOf(casePrice = "33.99", discount = AiExtractedDiscount("40.00", "WHOLE_CASE")),
        ).accepted.single()
        assertNull(item.item.discount)
        assertTrue(ExtractionIssue.DISCOUNT_EXCEEDS_CASE_PRICE in item.issues)
    }

    @Test
    fun `a discount equal to the case price is allowed - the case really is free`() {
        val item = validate(
            itemOf(casePrice = "33.99", discount = AiExtractedDiscount("33.99", "WHOLE_CASE")),
        ).accepted.single()
        assertEquals("33.99", item.item.discount?.amount)
    }

    @Test
    fun `a negative discount is refused so it cannot raise the cost`() {
        val item = validate(
            itemOf(discount = AiExtractedDiscount("-8.00", "WHOLE_CASE")),
        ).accepted.single()
        assertNull(item.item.discount)
        assertTrue(ExtractionIssue.NEGATIVE_DISCOUNT in item.issues)
    }

    @Test
    fun `an unrecognised discount scope never silently becomes whole case`() {
        val item = validate(
            itemOf(discount = AiExtractedDiscount("8.00", "EVERY_OTHER_TUESDAY")),
        ).accepted.single()
        assertEquals("UNKNOWN", item.item.discount?.scope)
        assertTrue(ExtractionIssue.UNKNOWN_DISCOUNT_SCOPE in item.issues)
    }

    @Test
    fun `a subset discount cannot claim more units than the case holds`() {
        val item = validate(
            itemOf(
                unitsPerCase = 12,
                discount = AiExtractedDiscount("1.00", "UNITS_SUBSET", appliesToUnits = 40),
            ),
        ).accepted.single()
        assertEquals(12, item.item.discount?.appliesToUnits)
        assertTrue(ExtractionIssue.SUBSET_UNITS_EXCEED_CASE in item.issues)
    }

    @Test
    fun `confidence outside zero to one is clamped and noted`() {
        val high = validate(itemOf(confidence = 4.0)).accepted.single()
        assertEquals(1.0, high.item.confidence, 0.0)
        assertTrue(ExtractionIssue.CONFIDENCE_OUT_OF_RANGE in high.issues)

        val nan = validate(itemOf(confidence = Double.NaN)).accepted.single()
        assertEquals(0.0, nan.item.confidence, 0.0)
    }

    @Test
    fun `a citation to a photograph that was never imported is discarded`() {
        val item = validate(itemOf(sourcePhotoIds = listOf(1L, 77L)), photos = setOf(1L))
            .accepted.single()
        assertEquals(listOf(1L), item.item.sourcePhotoIds)
        assertTrue(ExtractionIssue.UNKNOWN_SOURCE_PHOTO in item.issues)
    }

    @Test
    fun `money with symbols and separators is normalised, not rejected`() {
        val item = validate(itemOf(casePrice = "${'$'}1,234.56")).accepted.single()
        assertNotNull(item.item.casePrice)
    }
}

class AiQuestionResolutionTest {

    private val allowed = setOf(1L, 2L, 3L)

    private fun parse(raw: String) =
        AiResponseParser.parseQuestionResolution(raw, allowed)

    @Test
    fun `an invented item id is dropped rather than obeyed`() {
        val result = parse("""{"kind":"PRODUCT_MATCHES","itemIds":[2,999]}""")
        val matches = (result as AiResult.Success).value as OrderQuestionResolution.ProductMatches
        assertEquals(listOf(2L), matches.itemIds)
    }

    @Test
    fun `a match naming only invented ids resolves to nothing at all`() {
        val result = parse("""{"kind":"PRODUCT_MATCHES","itemIds":[999]}""")
        assertTrue((result as AiResult.Success).value is OrderQuestionResolution.Unresolved)
    }

    @Test
    fun `a price correction for a product that was never offered is refused`() {
        // This is the dangerous one: obeying it would rewrite the shelf price of a product the
        // user was not even talking about.
        val result = parse(
            """{"kind":"PRICE_CORRECTION","updates":[{"itemId":42,"retailPrice":"7.99"}]}""",
        )
        assertTrue((result as AiResult.Success).value is OrderQuestionResolution.Unresolved)
    }

    @Test
    fun `a valid price correction survives`() {
        val result = parse(
            """{"kind":"PRICE_CORRECTION","updates":[
               {"itemId":2,"retailPrice":"7.99"},{"itemId":3,"retailPrice":"11.99"}]}""",
        )
        val correction =
            (result as AiResult.Success).value as OrderQuestionResolution.PriceCorrection
        assertEquals(2, correction.updates.size)
        assertEquals("7.99", correction.updates.first().retailPrice)
    }

    @Test
    fun `a clarification with no question is malformed`() {
        assertTrue(parse("""{"kind":"CLARIFICATION"}""") is AiResult.Failure)
    }

    @Test
    fun `a clarification carries its question through`() {
        val result = parse("""{"kind":"CLARIFICATION","question":"Which one - 8 oz or 15 oz?"}""")
        val clarification =
            (result as AiResult.Success).value as OrderQuestionResolution.Clarification
        assertEquals("Which one - 8 oz or 15 oz?", clarification.question)
    }

    @Test
    fun `a reply with no kind is malformed`() {
        assertTrue(parse("""{"itemIds":[1]}""") is AiResult.Failure)
    }

    @Test
    fun `an unrecognised kind is unresolved rather than fatal`() {
        val result = parse("""{"kind":"SOMETHING_NEW","itemIds":[1]}""")
        assertTrue((result as AiResult.Success).value is OrderQuestionResolution.Unresolved)
    }

    @Test
    fun `a profit query needs both a product and a price`() {
        assertTrue(
            (parse("""{"kind":"PROFIT_QUERY","itemIds":[1]}""") as AiResult.Success).value
                is OrderQuestionResolution.Unresolved,
        )
        val good = parse("""{"kind":"PROFIT_QUERY","itemIds":[1],"retailPrice":"7.99"}""")
        assertTrue((good as AiResult.Success).value is OrderQuestionResolution.ProfitQuery)
    }
}

class AiProductIdentificationTest {

    @Test
    fun `reads several products and keeps their left-to-right order`() {
        val result = AiResponseParser.parseProductIdentification(
            """{"warnings":[],"products":[
               {"brand":"Downy","productName":"Downy Soft","variant":"April Fresh",
                "size":"10 fl oz","upc":null,"position":0,"confidence":0.9},
               {"brand":"Mr. Clean","productName":"Mr. Clean","variant":null,
                "size":"23 fl oz","upc":null,"position":1,"confidence":0.8}]}""",
        )
        val products = (result as AiResult.Success).value.products
        assertEquals(2, products.size)
        assertEquals(0, products.first().position)
        assertTrue(products.first().toSearchText().contains("April Fresh"))
    }

    @Test
    fun `a sighting with nothing identifiable in it is discarded`() {
        val result = AiResponseParser.parseProductIdentification(
            """{"products":[{"brand":null,"productName":null,"size":"10 oz","confidence":0.2}]}""",
        )
        assertEquals(0, (result as AiResult.Success).value.products.size)
    }

    @Test
    fun `position falls back to reading order when the model omits it`() {
        val result = AiResponseParser.parseProductIdentification(
            """{"products":[{"brand":"A"},{"brand":"B"}]}""",
        )
        val products = (result as AiResult.Success).value.products
        assertEquals(listOf(0, 1), products.map { it.position })
    }
}
