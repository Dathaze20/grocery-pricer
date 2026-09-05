package com.grocerypricer.app

import com.grocerypricer.app.data.model.Order
import com.grocerypricer.app.data.model.OrderItem
import com.grocerypricer.app.data.model.OrderStatus
import com.grocerypricer.app.data.model.Product
import com.grocerypricer.core.model.Category
import com.grocerypricer.core.model.DiscountScope
import com.grocerypricer.core.model.ReceiptDiscount
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.pricing.CostCalculator

/** Builders for the worked examples the store owner supplied, reused across the app tests. */
object TestFactories {

    fun order(id: Long = 1L) = Order(
        id = id,
        supplier = "Jetro / Restaurant Depot",
        name = "Jetro - September 4, 2026",
        orderDate = 1_756_944_000_000L,
        status = OrderStatus.ACTIVE,
        createdAt = 1_756_944_000_000L,
        updatedAt = 1_756_944_000_000L,
    )

    /** Hellmann's mayonnaise: $33.99 case of 12, $8 flyer discount, $2.17 true unit cost. */
    fun mayonnaise(id: Long = 1L, orderId: Long = 1L, retail: Money? = Money.of("4.99")) = OrderItem(
        id = id,
        orderId = orderId,
        description = "HELLM MAYONNAISE 8Z",
        upc = "048001215252",
        size = "8 OZ",
        category = Category.CONDIMENTS,
        casePrice = Money.of("33.99"),
        unitsPerCase = 12,
        casesPurchased = 1,
        printedUnitCost = Money.of("2.83"),
        discount = ReceiptDiscount("Flyer 43", Money.of("8.00"), DiscountScope.WHOLE_CASE),
        cost = CostCalculator.calculate(
            casePrice = Money.of("33.99"),
            unitsPerCase = 12,
            discount = ReceiptDiscount("Flyer 43", Money.of("8.00"), DiscountScope.WHOLE_CASE),
        ),
        suggestedPrice = Money.of("4.99"),
        approvedPrice = retail,
        priceApproved = retail != null,
        reviewApproved = true,
    )

    /** Kellogg's Froot Loops: $57.59 case of 10, $12 flyer discount, $4.56 true unit cost. */
    fun frootLoops(id: Long = 2L, orderId: Long = 1L) = OrderItem(
        id = id,
        orderId = orderId,
        description = "KELL FROOT LOOP FM 13.2Z",
        size = "13.2 OZ",
        category = Category.CEREAL,
        casePrice = Money.of("57.59"),
        unitsPerCase = 10,
        casesPurchased = 1,
        printedUnitCost = Money.of("5.76"),
        discount = ReceiptDiscount("Flyer 43", Money.of("12.00"), DiscountScope.WHOLE_CASE),
        cost = CostCalculator.calculate(
            casePrice = Money.of("57.59"),
            unitsPerCase = 10,
            discount = ReceiptDiscount("Flyer 43", Money.of("12.00"), DiscountScope.WHOLE_CASE),
        ),
        suggestedPrice = Money.of("7.99"),
        approvedPrice = Money.of("7.99"),
        priceApproved = true,
        reviewApproved = true,
    )

    fun product(id: Long = 1L) = Product(
        id = id,
        upc = "048001215252",
        name = "Hellmann's Mayonnaise",
        size = "8 OZ",
        category = Category.CONDIMENTS,
        lastUnitCost = Money.of("2.1658"),
        lastRetailPrice = Money.of("4.99"),
        lastSupplier = "Jetro / Restaurant Depot",
        lastPurchasedAt = 1_756_944_000_000L,
        quantityReceived = 12,
    )
}
