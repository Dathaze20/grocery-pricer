package com.grocerypricer.app

import com.grocerypricer.app.export.CsvExporter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CsvExporterTest {

    @Test
    fun `the order export has the columns the store owner asked for`() {
        assertTrue(CsvExporter.ORDER_HEADER.containsAll(
            listOf(
                "Product Name", "UPC", "Size", "Case Price", "Case Quantity", "Discount",
                "Net Case Cost", "Unit Cost", "Retail Price", "Gross Profit", "Margin %", "Markup %",
            )
        ))
    }

    @Test
    fun `an order row carries the real numbers, not the printed ones`() {
        val csv = CsvExporter.orderCsv(TestFactories.order(), listOf(TestFactories.mayonnaise()))
        val rows = csv.trim().split("\n")

        assertEquals(2, rows.size)
        val values = rows[1].split(",")
        val header = CsvExporter.ORDER_HEADER

        assertEquals("HELLM MAYONNAISE 8Z", values[header.indexOf("Product Name")])
        assertEquals("048001215252", values[header.indexOf("UPC")])
        assertEquals("33.99", values[header.indexOf("Case Price")])
        assertEquals("12", values[header.indexOf("Case Quantity")])
        assertEquals("8.00", values[header.indexOf("Discount")])
        assertEquals("25.99", values[header.indexOf("Net Case Cost")])
        assertEquals("2.17", values[header.indexOf("Unit Cost")])
        assertEquals("4.99", values[header.indexOf("Retail Price")])
        assertEquals("2.82", values[header.indexOf("Gross Profit")])
        assertEquals("56.6", values[header.indexOf("Margin %")])
        assertEquals("130.4", values[header.indexOf("Markup %")])
    }

    @Test
    fun `an unpriced row exports blank price columns rather than zeros`() {
        val csv = CsvExporter.orderCsv(
            TestFactories.order(),
            listOf(TestFactories.mayonnaise(retail = null).copy(suggestedPrice = null)),
        )
        val values = csv.trim().split("\n")[1].split(",")
        val header = CsvExporter.ORDER_HEADER

        assertEquals("", values[header.indexOf("Retail Price")])
        assertEquals("", values[header.indexOf("Gross Profit")])
        assertEquals("2.17", values[header.indexOf("Unit Cost")])
    }

    @Test
    fun `the catalog export includes cost, price and margin`() {
        val csv = CsvExporter.catalogCsv(listOf(TestFactories.product()))
        val rows = csv.trim().split("\n")
        val values = rows[1].split(",")
        val header = CsvExporter.CATALOG_HEADER

        assertEquals("Hellmann's Mayonnaise", values[header.indexOf("Product Name")])
        assertEquals("2.17", values[header.indexOf("Last Unit Cost")])
        assertEquals("4.99", values[header.indexOf("Last Retail Price")])
        assertEquals("56.6", values[header.indexOf("Margin %")])
        assertEquals("12", values[header.indexOf("Quantity On Hand")])
    }

    @Test
    fun `file names are safe to write to disk`() {
        val name = CsvExporter.orderFileName(TestFactories.order())
        assertTrue(name.endsWith(".csv"))
        assertTrue(name.none { it in "/\\:*?\"<>|" })
    }
}
