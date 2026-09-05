package com.grocerypricer.app.export

import com.grocerypricer.app.data.model.Order
import com.grocerypricer.app.data.model.OrderItem
import com.grocerypricer.app.data.model.Product
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.pricing.ProfitCalculator
import com.grocerypricer.core.util.CsvWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Builds the CSV files the store can open in a spreadsheet.
 *
 * Pure string work, no Android types, so the exact column layout is covered by unit tests.
 */
object CsvExporter {

    val ORDER_HEADER = listOf(
        "Product Name",
        "UPC",
        "Size",
        "Category",
        "Case Price",
        "Case Quantity",
        "Cases Purchased",
        "Loose Units",
        "Discount",
        "Discount Applies To",
        "Net Case Cost",
        "Unit Cost",
        "Retail Price",
        "Gross Profit",
        "Margin %",
        "Markup %",
        "Total Units",
        "Total Wholesale Cost",
    )

    val CATALOG_HEADER = listOf(
        "Product Name",
        "Brand",
        "UPC",
        "Supplier Item Number",
        "Size",
        "Category",
        "Last Unit Cost",
        "Last Retail Price",
        "Fixed Price",
        "Gross Profit",
        "Margin %",
        "Markup %",
        "Last Supplier",
        "Last Purchased",
        "Quantity On Hand",
    )

    fun orderCsv(order: Order, items: List<OrderItem>): String =
        CsvWriter.build(ORDER_HEADER, items.map { it.toRow() })

    fun catalogCsv(products: List<Product>): String =
        CsvWriter.build(CATALOG_HEADER, products.map { it.toRow() })

    fun orderFileName(order: Order): String =
        "grocery-pricer-order-${order.id}-${safe(order.name)}.csv"

    fun catalogFileName(): String =
        "grocery-pricer-catalog-${formatDate(System.currentTimeMillis())}.csv"

    private fun OrderItem.toRow(): List<String?> {
        val price = effectivePrice
        val profit = price?.let { it - cost.trueUnitCost }
        return listOf(
            description,
            upc,
            size,
            category.displayName,
            casePrice.toPlainString(),
            unitsPerCase.toString(),
            casesPurchased.toString(),
            looseUnits.toString(),
            discount?.amount?.toPlainString() ?: "0.00",
            discount?.scope?.displayName ?: "None",
            cost.netCaseCost.toPlainString(),
            cost.trueUnitCost.roundedToCents().toPlainString(),
            price?.toPlainString(),
            profit?.toPlainString(),
            percent(price?.let { ProfitCalculator.grossMarginPercent(cost.trueUnitCost, it) }),
            percent(price?.let { ProfitCalculator.markupPercent(cost.trueUnitCost, it) }),
            cost.totalUnits.toString(),
            cost.totalWholesaleCost.toPlainString(),
        )
    }

    private fun Product.toRow(): List<String?> {
        val cost = lastUnitCost
        val price = lastRetailPrice
        val profit = if (cost != null && price != null) price - cost else null
        return listOf(
            name,
            brand,
            upc,
            supplierSku,
            size,
            category.displayName,
            cost?.roundedToCents()?.toPlainString(),
            price?.toPlainString(),
            overridePrice?.toPlainString(),
            profit?.toPlainString(),
            percent(marginOf(cost, price)),
            percent(markupOf(cost, price)),
            lastSupplier,
            lastPurchasedAt?.let { formatDate(it) },
            quantityOnHand.toString(),
        )
    }

    private fun marginOf(cost: Money?, price: Money?) =
        if (cost != null && price != null) ProfitCalculator.grossMarginPercent(cost, price) else null

    private fun markupOf(cost: Money?, price: Money?) =
        if (cost != null && price != null) ProfitCalculator.markupPercent(cost, price) else null

    private fun percent(value: java.math.BigDecimal?): String? =
        value?.setScale(1, java.math.RoundingMode.HALF_UP)?.toPlainString()

    private fun formatDate(millis: Long): String =
        SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(millis))

    private fun safe(value: String): String =
        value.replace(Regex("[^A-Za-z0-9-]+"), "-").trim('-').lowercase().ifEmpty { "order" }
}
