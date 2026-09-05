package com.grocerypricer.app

import com.grocerypricer.app.data.repository.ProductRepository
import org.junit.Assert.assertTrue
import org.junit.Test

class BarcodeVariantsTest {

    @Test
    fun `a 12 digit UPC-A also looks for its 13 digit EAN form`() {
        val variants = ProductRepository.barcodeVariants("048001215252")
        assertTrue(variants.contains("048001215252"))
        assertTrue(variants.contains("48001215252"))
        assertTrue(variants.contains("0048001215252"))
    }

    @Test
    fun `a code stored without leading zeros is still found`() {
        val variants = ProductRepository.barcodeVariants("0048001215252")
        assertTrue(variants.contains("048001215252"))
        assertTrue(variants.contains("48001215252"))
    }

    @Test
    fun `variants are unique so the query does not repeat itself`() {
        val variants = ProductRepository.barcodeVariants("12345678")
        assertTrue(variants.size == variants.distinct().size)
    }
}
