package com.grocerypricer.core.chat

import com.grocerypricer.core.money.Money
import com.grocerypricer.core.pricing.ProfitCalculator

/** How sure the app is that this row is the product the person meant. */
enum class MatchConfidence { EXACT, HIGH, LIKELY }

/**
 * One authoritative answer about one product.
 *
 * Every figure on this object was read out of the local database or produced by the deterministic
 * pricing engine. Nothing here ever comes from a model's prose - that is the whole point of the
 * type existing. The model may decide *which* product the user meant; from that moment on it has
 * no further say, and [ChatAnswerFormatter] renders these fields and nothing else.
 */
data class PriceAnswer(
    val itemId: Long,
    val displayName: String,
    val size: String? = null,
    /** True cost of one sellable unit, after discounts. Null when the receipt could not be read. */
    val unitCost: Money?,
    val suggestedRetail: Money?,
    /** What the shopkeeper actually charges, if they have said. Outranks the suggestion. */
    val approvedRetail: Money? = null,
    val unitsPerCase: Int? = null,
    /** "can", "bottle", "box" - only when the catalogue knows. */
    val unitNoun: String? = null,
    val previousUnitCost: Money? = null,
    val previousRetail: Money? = null,
    val confidence: MatchConfidence = MatchConfidence.EXACT,
    /** Why a figure is missing, when one is. */
    val note: String? = null,
) {
    /** The price to put on the shelf: what they set, else what was worked out. */
    val retail: Money? get() = approvedRetail ?: suggestedRetail

    /** Name and size as one line, the way it is spoken. */
    val title: String
        get() = listOfNotNull(displayName.trim().takeIf { it.isNotEmpty() }, size?.trim()?.takeIf { it.isNotEmpty() })
            .joinToString(" ")
}

/**
 * Renders answers in the house style the shopkeeper already worked in.
 *
 * The format is fixed by the brief and is deliberately terse: a name, then cost and shelf price
 * on one line. No margin lecture unless asked. Someone standing behind a counter with a box in
 * one hand reads two numbers, not a paragraph.
 */
object ChatAnswerFormatter {

    private const val ARROW = " → "

    /** `Hellmann's Mayonnaise 8 oz` / `$2.17 -> $4.99` */
    fun single(answer: PriceAnswer): String = buildString {
        append(answer.title).append('\n')
        append(priceLine(answer))
        answer.note?.takeIf { it.isNotBlank() }?.let { append('\n').append(it) }
    }

    /** Numbered, blank line between, same two-line shape for each. */
    fun numbered(answers: List<PriceAnswer>): String {
        if (answers.isEmpty()) return "I could not find those in this order."
        if (answers.size == 1) return single(answers.single())
        return answers.mapIndexed { index, answer ->
            buildString {
                append(index + 1).append(". ").append(answer.title).append('\n')
                append(priceLine(answer))
                answer.note?.takeIf { it.isNotBlank() }?.let { append('\n').append(it) }
            }
        }.joinToString("\n\n")
    }

    private fun priceLine(answer: PriceAnswer): String {
        val cost = answer.unitCost
        val retail = answer.retail
        return when {
            cost != null && retail != null -> cost.format() + ARROW + retail.format()
            cost != null -> cost.format() + ARROW + "no price set yet"
            retail != null -> "cost unknown" + ARROW + retail.format()
            else -> "I could not read the cost for this one."
        }
    }

    /** `Carnation Evaporated Milk 12 oz` / `8 cans per case.` */
    fun caseQuantity(answer: PriceAnswer): String = buildString {
        append(answer.title).append('\n')
        val units = answer.unitsPerCase
        if (units == null) {
            append("I could not read how many are in the case.")
        } else {
            append(units).append(' ').append(pluralNoun(answer.unitNoun, units)).append(" per case.")
        }
    }

    /**
     * The one place a margin is spelled out, because it was asked for.
     *
     * Gross profit comes from [ProfitCalculator], so margin and markup stay the distinct things
     * they are everywhere else in the app.
     */
    fun profitAt(answer: PriceAnswer, retailPrice: Money): String = buildString {
        append(answer.title).append('\n')
        val cost = answer.unitCost
        if (cost == null) {
            append("I could not read the cost for this one, so I cannot work out the profit.")
            return@buildString
        }
        val summary = ProfitCalculator.summarise(cost, retailPrice)
        append("Cost: ").append(cost.format()).append('\n')
        append("Sell: ").append(retailPrice.format()).append('\n')
        append("Gross profit: ").append(summary.grossProfit.format()).append(" each")
    }

    /** `Saved. Hellmann's Mayonnaise 15 oz -> $6.99` */
    fun savedPrice(answer: PriceAnswer, newPrice: Money): String =
        "Saved. " + answer.title + ARROW + newPrice.format()

    fun savedPrices(updates: List<Pair<PriceAnswer, Money>>): String {
        if (updates.isEmpty()) return "I could not tell which product you meant."
        if (updates.size == 1) return savedPrice(updates.single().first, updates.single().second)
        return "Saved.\n" + updates.joinToString("\n") { (answer, price) ->
            "  " + answer.title + ARROW + price.format()
        }
    }

    /** Asks about one product whose cost moved since last time. */
    fun costChange(answer: PriceAnswer): String? {
        val previous = answer.previousUnitCost ?: return null
        val current = answer.unitCost ?: return null
        val delta = current - previous
        if (delta.isZero) return null
        val direction = if (delta.isNegative) "down" else "up"
        return "The cost went " + direction + " " + delta.abs().format() +
            " from " + previous.format() + "."
    }

    fun clarification(question: String): String = question.trim()

    private fun pluralNoun(noun: String?, count: Int): String {
        val base = noun?.trim()?.takeIf { it.isNotEmpty() } ?: "unit"
        if (count == 1) return base
        return when {
            base.endsWith("s") || base.endsWith("x") || base.endsWith("ch") -> base + "es"
            else -> base + "s"
        }
    }
}
