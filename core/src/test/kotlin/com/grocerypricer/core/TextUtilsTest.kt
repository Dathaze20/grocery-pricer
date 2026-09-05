package com.grocerypricer.core

import com.grocerypricer.core.parser.OcrTextNormalizer
import com.grocerypricer.core.util.CsvWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OcrTextNormalizerTest {

    @Test
    fun `a dollar sign misread as S is restored`() {
        val result = OcrTextNormalizer.normalize("CASE S33.99 SIZE 12")
        assertEquals("CASE ${'$'}33.99 SIZE 12", result.text)
        assertTrue(result.correctedCharacters)
    }

    @Test
    fun `letters inside numeric tokens are corrected`() {
        assertEquals("12", OcrTextNormalizer.normalize("l2").text)
        assertEquals("10.50", OcrTextNormalizer.normalize("1O.5O").text)
        // A lone letter is a letter, not a digit; only mostly-numeric tokens are touched.
        assertEquals("B", OcrTextNormalizer.normalize("B").text)
        assertEquals("58.00", OcrTextNormalizer.normalize("5B.00").text)
    }

    @Test
    fun `words are never mangled into numbers`() {
        assertEquals("SIZE", OcrTextNormalizer.normalize("SIZE").text)
        assertEquals("CASE", OcrTextNormalizer.normalize("CASE").text)
        assertEquals("HELLM MAYONNAISE 8Z", OcrTextNormalizer.normalize("HELLM MAYONNAISE 8Z").text)
        assertEquals("R&W OIL VEGETABLE 48Z", OcrTextNormalizer.normalize("R&W OIL VEGETABLE 48Z").text)
        assertFalse(OcrTextNormalizer.normalize("KELL FROOT LOOP FM 13.2Z").correctedCharacters)
    }

    @Test
    fun `a comma decimal point is repaired`() {
        assertEquals("33.99", OcrTextNormalizer.normalize("33,99").text)
    }

    @Test
    fun `whitespace is collapsed and a spaced dollar sign is tightened`() {
        assertEquals("CASE ${'$'}33.99", OcrTextNormalizer.normalize("  CASE   ${'$'} 33.99  ").text)
    }

    @Test
    fun `a clean line is reported as untouched`() {
        val result = OcrTextNormalizer.normalize("CASE ${'$'}33.99 SIZE 12 UNIT ${'$'}2.83")
        assertEquals("CASE ${'$'}33.99 SIZE 12 UNIT ${'$'}2.83", result.text)
        assertFalse(result.correctedCharacters)
    }
}

class CsvWriterTest {

    @Test
    fun `plain values are written as-is`() {
        assertEquals("Tide Original,40 oz,13.99", CsvWriter.row(listOf("Tide Original", "40 oz", "13.99")))
    }

    @Test
    fun `commas and quotes are escaped`() {
        assertEquals("\"Hellmann's, 8 oz\"", CsvWriter.escape("Hellmann's, 8 oz"))
        assertEquals("\"He said \"\"hi\"\"\"", CsvWriter.escape("He said \"hi\""))
    }

    @Test
    fun `a value that a spreadsheet would run as a formula is defused`() {
        assertEquals("'=SUM(A1:A2)", CsvWriter.escape("=SUM(A1:A2)"))
        assertEquals("'@import", CsvWriter.escape("@import"))
        // A negative number is still a number, not a formula.
        assertEquals("-8.00", CsvWriter.escape("-8.00"))
    }

    @Test
    fun `null and empty values become empty fields`() {
        assertEquals(",,", CsvWriter.row(listOf(null, "", null)))
    }

    @Test
    fun `a full document has a header row and one row per record`() {
        val csv = CsvWriter.build(
            header = listOf("Product", "Cost"),
            rows = listOf(listOf("Mayo", "2.17"), listOf("Froot Loops", "4.56")),
        )
        assertEquals("Product,Cost\nMayo,2.17\nFroot Loops,4.56\n", csv)
    }
}
