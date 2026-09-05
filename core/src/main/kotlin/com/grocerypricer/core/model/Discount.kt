package com.grocerypricer.core.model

import com.grocerypricer.core.money.Money

/**
 * How a receipt discount line should be applied to the product above it.
 *
 * The parser never picks anything other than [WHOLE_CASE] or [UNKNOWN] on its own; every other
 * scope is an explicit choice the user made on the review screen.
 */
enum class DiscountScope(val displayName: String, val explanation: String) {
    /** The printed amount comes off one case. Net case cost = case price − amount. */
    WHOLE_CASE("Whole case", "The full amount comes off each case."),

    /** The printed amount comes off every retail unit in the case. */
    PER_UNIT("Per unit", "The amount comes off each individual retail unit."),

    /** The printed amount comes off each of a set number of units inside one case. */
    UNITS_SUBSET("Applies to N units", "The amount comes off a set number of units, not the whole case."),

    /** A single flat amount off the whole purchase, however many cases were bought. */
    CUSTOM("Flat amount off the order line", "One flat amount off everything bought on this line."),

    /** The user decided this discount does not belong to this product. */
    IGNORED("Ignore discount", "The discount is not applied to this product."),

    /** The parser found a discount but could not confidently decide how it applies. */
    UNKNOWN("Needs review", "Grocery Pricer could not tell how this discount applies.");

    /** Scopes that change the cost. [UNKNOWN] and [IGNORED] deliberately do not. */
    val affectsCost: Boolean get() = this != IGNORED && this != UNKNOWN
}

/**
 * A discount lifted off a receipt, e.g. `Flyer 43 - HELLM MAYONNAISE   -$8.00`.
 *
 * [amount] is always stored positive; [scope] decides what it is subtracted from.
 */
data class ReceiptDiscount(
    val description: String,
    val amount: Money,
    val scope: DiscountScope = DiscountScope.UNKNOWN,
    /** Only meaningful for [DiscountScope.UNITS_SUBSET]. */
    val appliesToUnits: Int? = null,
    /** Line the discount was read from, for showing the user where it came from. */
    val sourceLineIndex: Int? = null,
) {
    init {
        require(!amount.isNegative) { "Discount amounts are stored positive; scope decides the sign" }
    }

    fun withScope(newScope: DiscountScope, units: Int? = null): ReceiptDiscount =
        copy(scope = newScope, appliesToUnits = if (newScope == DiscountScope.UNITS_SUBSET) units else null)
}
