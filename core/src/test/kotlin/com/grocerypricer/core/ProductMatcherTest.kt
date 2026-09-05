package com.grocerypricer.core

import com.grocerypricer.core.matching.MatchMethod
import com.grocerypricer.core.matching.MatchOutcome
import com.grocerypricer.core.matching.ProductMatcher
import com.grocerypricer.core.matching.ProductQuery
import com.grocerypricer.core.matching.SimpleMatchable
import com.grocerypricer.core.matching.SizeParser
import com.grocerypricer.core.matching.SizeRelation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProductMatcherTest {

    private val catalog = listOf(
        SimpleMatchable(1, upc = "048001215252", name = "Hellmann's Mayonnaise", size = "8 oz"),
        SimpleMatchable(2, upc = "048001215269", name = "Hellmann's Mayonnaise", size = "15 oz"),
        SimpleMatchable(3, upc = "037000127857", name = "Tide Original", size = "25 oz"),
        SimpleMatchable(4, upc = "037000127864", name = "Tide Original", size = "40 oz"),
        SimpleMatchable(5, name = "Clorox Bleach", size = "24 oz", supplierSku = "CLX24"),
        SimpleMatchable(6, name = "Clorox Bleach", size = "81 oz", supplierSku = "CLX81"),
        SimpleMatchable(7, name = "Clorox Bleach", size = "121 oz", supplierSku = "CLX121"),
        SimpleMatchable(8, name = "Downy Soft April Fresh", size = "10 oz"),
        SimpleMatchable(9, name = "Kellogg's Froot Loops", size = "13.2 oz"),
    )

    @Test
    fun `a barcode wins outright`() {
        val outcome = ProductMatcher.match(ProductQuery(upc = "048001215269"), catalog)
        val match = assertConfident(outcome)
        assertEquals(2L, match.product.productId)
        assertEquals(MatchMethod.UPC, match.method)
    }

    @Test
    fun `a UPC-A and the EAN-13 it scans as are the same product`() {
        val outcome = ProductMatcher.match(ProductQuery(upc = "0048001215252"), catalog)
        assertEquals(1L, assertConfident(outcome).product.productId)
    }

    @Test
    fun `a supplier item number is used when there is no barcode`() {
        val outcome = ProductMatcher.match(ProductQuery(supplierSku = "CLX81"), catalog)
        val match = assertConfident(outcome)
        assertEquals(6L, match.product.productId)
        assertEquals(MatchMethod.SUPPLIER_SKU, match.method)
    }

    @Test
    fun `name plus size resolves exactly`() {
        val outcome = ProductMatcher.match(ProductQuery(name = "Tide Original", size = "40 oz"), catalog)
        val match = assertConfident(outcome)
        assertEquals(4L, match.product.productId)
        assertEquals(MatchMethod.NAME_AND_SIZE, match.method)
    }

    @Test
    fun `the same name in a different size is never merged`() {
        val outcome = ProductMatcher.match(ProductQuery(name = "Tide Original 25 oz", size = "25 oz"), catalog)
        assertEquals(3L, assertConfident(outcome).product.productId)

        // Clorox comes in three sizes; asking for one must not return another.
        val clorox = ProductMatcher.match(ProductQuery(name = "Clorox Bleach", size = "121 oz"), catalog)
        assertEquals(7L, assertConfident(clorox).product.productId)
    }

    @Test
    fun `a name with no size is ambiguous when several sizes exist`() {
        val outcome = ProductMatcher.match(ProductQuery(name = "Tide Original"), catalog)
        assertTrue(outcome is MatchOutcome.Ambiguous)
        val candidates = (outcome as MatchOutcome.Ambiguous).candidates
        assertTrue(candidates.map { it.product.productId }.containsAll(listOf(3L, 4L)))
    }

    @Test
    fun `an abbreviated receipt name matches the catalogue entry`() {
        val outcome = ProductMatcher.match(
            ProductQuery(name = "KELL FROOT LOOP FM 13.2Z", size = "13.2 OZ"),
            catalog,
        )
        val match = assertConfident(outcome)
        assertEquals(9L, match.product.productId)
    }

    @Test
    fun `words read off a product label produce candidates, never a silent pick`() {
        val outcome = ProductMatcher.matchFromLabelText("DOWNY\nAPRIL FRESH\n10 FL OZ", catalog)
        assertTrue(outcome is MatchOutcome.Ambiguous)
        val top = (outcome as MatchOutcome.Ambiguous).candidates.first()
        assertEquals(8L, top.product.productId)
        assertEquals(SizeRelation.MATCH, top.sizeRelation)
    }

    @Test
    fun `nothing recognisable returns no match`() {
        assertEquals(MatchOutcome.NoMatch, ProductMatcher.match(ProductQuery(name = "zzzz qqqq"), catalog))
        assertEquals(MatchOutcome.NoMatch, ProductMatcher.match(ProductQuery(upc = "999999999999"), emptyList()))
    }

    @Test
    fun `an unknown barcode falls through instead of matching a random product`() {
        val outcome = ProductMatcher.match(ProductQuery(upc = "111111111111"), catalog)
        assertEquals(MatchOutcome.NoMatch, outcome)
    }

    @Test
    fun `manual search covers name, size, barcode and item number`() {
        assertEquals(2, ProductMatcher.search("mayonnaise", catalog).size)
        assertEquals(2, ProductMatcher.search("Tide", catalog).size)
        assertEquals(4L, ProductMatcher.search("Tide 40", catalog).single().productId)
        assertEquals(1, ProductMatcher.search("048001215252", catalog).size)
        assertEquals(1, ProductMatcher.search("CLX24", catalog).size)
        assertEquals(1, ProductMatcher.search("froot loops", catalog).size)
        assertTrue(ProductMatcher.search("", catalog).isEmpty())
    }

    @Test
    fun `sizes are parsed out of the shapes receipts actually print`() {
        assertEquals("8 OZ", SizeParser.canonicalOrNull("HELLM MAYONNAISE 8Z"))
        assertEquals("13.2 OZ", SizeParser.canonicalOrNull("KELL FROOT LOOP FM 13.2Z"))
        assertEquals("48 OZ", SizeParser.canonicalOrNull("R&W OIL VEGETABLE 48Z"))
        assertEquals("10 OZ", SizeParser.canonicalOrNull("DOWNY ULTRA APRIL FRESH 10 FL OZ"))
        assertEquals("40 OZ", SizeParser.canonicalOrNull("Tide Original 40 oz"))
        assertEquals("2 LB", SizeParser.canonicalOrNull("SUGAR 2 LB"))
        assertEquals("12 CT", SizeParser.canonicalOrNull("PAPER TOWELS 12 CT"))
        assertNull(SizeParser.canonicalOrNull("NO SIZE HERE"))
    }

    @Test
    fun `sizes only match when the number and the unit both agree`() {
        assertEquals(SizeRelation.MATCH, ProductMatcher.sizeRelation("8 oz", "8Z"))
        assertEquals(SizeRelation.MISMATCH, ProductMatcher.sizeRelation("8 oz", "15 oz"))
        assertEquals(SizeRelation.MISMATCH, ProductMatcher.sizeRelation("2 lb", "2 oz"))
        assertEquals(SizeRelation.UNKNOWN, ProductMatcher.sizeRelation("8 oz", null))
    }

    private fun assertConfident(outcome: MatchOutcome) =
        (outcome as? MatchOutcome.Confident)?.match.also { assertNotNull("expected a confident match, got $outcome", it) }!!
}
