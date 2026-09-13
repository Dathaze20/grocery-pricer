package com.grocerypricer.app.data.repository

import com.grocerypricer.app.data.model.Product
import com.grocerypricer.core.ai.ValidatedItem
import com.grocerypricer.core.matching.MatchOutcome
import com.grocerypricer.core.matching.ProductMatcher
import com.grocerypricer.core.matching.ProductQuery
import com.grocerypricer.core.model.Category
import com.grocerypricer.core.model.DiscountScope
import com.grocerypricer.core.model.ItemConfidence
import com.grocerypricer.core.model.ReceiptDiscount
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.pricing.CostCalculator
import com.grocerypricer.core.pricing.PricingEngine

/**
 * Turns what a model read into a priced row.
 *
 * This is the hinge of the V2 architecture, and it is deliberately boring. The model's output
 * arrives as strings; [Money] parses them; [CostCalculator] does the arithmetic; [PricingEngine]
 * suggests the shelf price. That is the same path V1's receipt parser takes, unchanged - the only
 * thing that differs upstream is who read the characters off the photograph.
 *
 * No figure here is taken from the model as a number. `printedUnitCost` is recorded because the
 * receipt printed it, but the cost the shop actually uses is always recomputed.
 */
object AiOrderIngest {

    /** What a single validated row becomes once the deterministic engine has had it. */
    data class PricedRow(
        val item: ValidatedItem,
        val product: Product?,
        val category: Category,
        val casePrice: Money,
        val unitsPerCase: Int,
        val casesPurchased: Int,
        val discount: ReceiptDiscount?,
        val cost: com.grocerypricer.core.model.CostBreakdown,
        val suggestedPrice: Money?,
        val confidence: ItemConfidence,
        /** True when the case price could not be read, so the cost is a placeholder. */
        val costUnknown: Boolean,
    )

    fun price(
        validated: ValidatedItem,
        catalogue: List<Product>,
        engine: PricingEngine,
    ): PricedRow {
        val extracted = validated.item

        val name = extracted.canonicalName ?: extracted.rawName.orEmpty()
        val category = Category.fromNameOrOther(extracted.category)
            .takeIf { it != Category.OTHER }
            ?: Category.guessFrom(name)

        // A case price that could not be read is not a free case. It is recorded as zero so the
        // row still exists and can be asked about, and flagged so nothing quotes it as a cost.
        val costUnknown = extracted.casePrice == null
        val casePrice = extracted.casePrice?.let { Money.parseOrNull(it) } ?: Money.ZERO

        // An unreadable pack count means the cost per unit cannot be worked out. One is used so
        // the arithmetic stays defined; the row is flagged rather than quietly priced per case.
        val unitsPerCase = extracted.unitsPerCase?.takeIf { it > 0 } ?: 1
        val casesPurchased = extracted.casesPurchased?.takeIf { it > 0 } ?: 1

        val discount = extracted.discount?.let { raw ->
            val amount = raw.amount?.let { Money.parseOrNull(it) } ?: return@let null
            val scope = DiscountScope.entries.firstOrNull { it.name == raw.scope }
                ?: DiscountScope.UNKNOWN
            ReceiptDiscount(
                description = discountDescription(raw.amount, scope),
                amount = amount,
                scope = scope,
                appliesToUnits = raw.appliesToUnits,
            )
        }

        val cost = CostCalculator.calculate(
            casePrice = casePrice,
            unitsPerCase = unitsPerCase,
            casesPurchased = casesPurchased,
            looseUnits = 0,
            discount = discount,
        )

        val match = ProductMatcher.match(
            ProductQuery(
                upc = extracted.upc,
                supplierSku = extracted.supplierSku,
                name = name,
                size = extracted.size,
            ),
            catalogue,
        )
        // Only a confident match links to an existing product. A guess would carry the wrong
        // previous shelf price into the suggestion, which is worse than having no history.
        val product = (match as? MatchOutcome.Confident)?.match?.product as? Product

        val suggestion = engine.suggest(
            // Null means nothing was read. A genuine zero - a fully discounted case - is a real
            // cost and still deserves a price.
            unitCost = if (costUnknown) null else cost.trueUnitCost,
            category = category,
            previousRetailPrice = product?.lastRetailPrice,
            productOverridePrice = product?.overridePrice,
        )

        return PricedRow(
            item = validated,
            product = product,
            category = category,
            casePrice = casePrice,
            unitsPerCase = unitsPerCase,
            casesPurchased = casesPurchased,
            discount = discount,
            cost = cost,
            suggestedPrice = suggestion.suggestedPrice.takeIf { it.isPositive },
            confidence = confidenceFor(validated),
            costUnknown = costUnknown,
        )
    }

    /**
     * The model's own score and the validator's findings, combined.
     *
     * A row the validator had to repair is never HIGH however sure the model said it was: the
     * model's confidence describes how well it read the page, not whether the result made sense.
     */
    private fun confidenceFor(validated: ValidatedItem): ItemConfidence = when {
        !validated.isComplete -> ItemConfidence.PROBLEM
        validated.issues.isNotEmpty() -> ItemConfidence.NEEDS_REVIEW
        validated.item.confidence >= HIGH_CONFIDENCE -> ItemConfidence.HIGH
        validated.item.confidence >= REVIEW_CONFIDENCE -> ItemConfidence.NEEDS_REVIEW
        else -> ItemConfidence.PROBLEM
    }

    private fun discountDescription(amount: String?, scope: DiscountScope): String =
        buildString {
            append("Discount")
            amount?.let { append(' ').append(Money.parseOrNull(it)?.format() ?: it) }
            if (scope != DiscountScope.UNKNOWN) append(" (").append(scope.displayName).append(')')
        }

    const val HIGH_CONFIDENCE = 0.85
    const val REVIEW_CONFIDENCE = 0.55
}
