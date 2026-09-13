package com.grocerypricer.app.chat

import com.grocerypricer.app.data.model.OrderItem
import com.grocerypricer.app.data.model.Product
import com.grocerypricer.core.chat.MatchConfidence
import com.grocerypricer.core.chat.PriceAnswer
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.query.QueryableOrderItem

/**
 * Presents an order row to the query engine.
 *
 * `productId` carries the order-item id rather than the catalogue product id: the conversation
 * talks about what was bought on this receipt, and two rows on one order can point at the same
 * catalogue product.
 */
data class OrderItemQueryView(
    val item: OrderItem,
    private val brandOverride: String? = null,
) : QueryableOrderItem {
    override val productId: Long get() = item.id
    override val upc: String? get() = item.upc
    override val supplierSku: String? get() = item.supplierSku
    override val name: String get() = item.description
    override val size: String? get() = item.size
    override val brand: String? get() = brandOverride
    override val category: String get() = item.category.displayName
    override val unitsPerCase: Int? get() = item.unitsPerCase
    override val unitCost: Money? get() = item.cost.trueUnitCost.takeIf { !costUnknown }
    override val suggestedRetail: Money? get() = item.suggestedPrice
    override val approvedRetail: Money? get() = item.approvedPrice

    /**
     * A row whose case price could not be read is stored as zero so it still exists and can be
     * asked about. Zero is a real cost elsewhere - a fully discounted case - so the two are told
     * apart by whether the row was flagged as a problem, not by the number.
     */
    private val costUnknown: Boolean
        get() = item.casePrice.isZero &&
            item.confidence == com.grocerypricer.core.model.ItemConfidence.PROBLEM
}

/**
 * Builds the authoritative answer for one row.
 *
 * Everything on the result comes from the database or from the deterministic engine. This is the
 * only place a [PriceAnswer] is made, which is what keeps the guarantee checkable.
 */
fun OrderItem.toPriceAnswer(
    product: Product? = null,
    previousUnitCost: Money? = null,
    confidence: MatchConfidence = MatchConfidence.EXACT,
    note: String? = null,
): PriceAnswer {
    val view = OrderItemQueryView(this)
    return PriceAnswer(
        itemId = id,
        displayName = description,
        size = size,
        unitCost = view.unitCost,
        suggestedRetail = suggestedPrice,
        approvedRetail = approvedPrice,
        unitsPerCase = unitsPerCase.takeIf { it > 1 || printedUnitCost != null },
        unitNoun = product?.unitType,
        previousUnitCost = previousUnitCost,
        previousRetail = product?.lastRetailPrice,
        confidence = confidence,
        note = note ?: noteForUnreadableFigures(),
    )
}

/** Says plainly when a figure is missing, rather than letting a placeholder read as a fact. */
private fun OrderItem.noteForUnreadableFigures(): String? = when {
    casePrice.isZero && confidence == com.grocerypricer.core.model.ItemConfidence.PROBLEM ->
        "I could not read the case price for this one on the receipt."
    unitsPerCase <= 1 && confidence == com.grocerypricer.core.model.ItemConfidence.PROBLEM ->
        "I could not verify how many units are in this case."
    else -> null
}
