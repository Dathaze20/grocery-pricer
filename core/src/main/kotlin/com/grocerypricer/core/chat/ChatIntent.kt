package com.grocerypricer.core.chat

import com.grocerypricer.core.money.Money
import com.grocerypricer.core.query.QueryRequest

/** Which product a correction is aimed at. Resolved against the conversation, never guessed. */
sealed interface CorrectionTarget {
    val price: Money

    /** "number two is 7.99" - the second product in the assistant's last list. */
    data class Ordinal(val position: Int, override val price: Money) : CorrectionTarget

    /** "the mayo is 7.99" - named explicitly. */
    data class Named(val phrase: String, override val price: Money) : CorrectionTarget

    /** "I put 7.99" - whatever was just being discussed. */
    data class Current(override val price: Money) : CorrectionTarget

    /** "all five cereals are 7.99" - everything the assistant just listed. */
    data class AllListed(override val price: Money) : CorrectionTarget
}

/** What the shopkeeper appears to want, worked out on the phone before any API call. */
sealed interface ChatIntent {
    data class PriceLookup(val request: QueryRequest) : ChatIntent
    data class CaseQuantity(val request: QueryRequest) : ChatIntent
    data class ProfitAt(val request: QueryRequest?, val retailPrice: Money) : ChatIntent
    data class LastCharged(val request: QueryRequest) : ChatIntent
    data class CostUnder(val limit: Money) : ChatIntent
    data class CostOver(val limit: Money) : ChatIntent
    data class Correction(val targets: List<CorrectionTarget>) : ChatIntent
    data object OrderSummary : ChatIntent

    /** Nothing confidently recognised. The caller escalates to the model. */
    data object Unknown : ChatIntent
}

/**
 * Reads the easy sentences without spending the shopkeeper's money.
 *
 * This is deliberately not a natural-language system. It recognises the handful of shapes that
 * make up most of what gets typed at a counter and bails out to [ChatIntent.Unknown] the moment
 * it is unsure - because a wrong guess here silently rewrites a shelf price, while an
 * unrecognised sentence just costs one API call. Every rule below errs towards not recognising.
 */
object ChatIntentParser {

    private val MONEY = Regex("""\$?\s?(\d{1,6}(?:[.,]\d{1,2})?)""")
    private val ORDINAL_WORDS = mapOf(
        "one" to 1, "first" to 1, "two" to 2, "second" to 2, "three" to 3, "third" to 3,
        "four" to 4, "fourth" to 4, "five" to 5, "fifth" to 5, "six" to 6, "sixth" to 6,
        "seven" to 7, "seventh" to 7, "eight" to 8, "eighth" to 8, "nine" to 9, "ninth" to 9,
        "ten" to 10, "tenth" to 10,
    )
    private val COUNT_WORDS = mapOf(
        "both" to 2, "two" to 2, "three" to 3, "four" to 4, "five" to 5, "six" to 6,
        "seven" to 7, "eight" to 8, "nine" to 9, "ten" to 10,
    )

    private val QUESTION_OPENERS = setOf(
        "how", "what", "whats", "which", "where", "why", "who", "when", "can", "could", "do",
        "does", "did", "is", "are", "was", "were", "show", "give", "tell", "list", "find",
    )

    fun parse(raw: String): ChatIntent {
        val text = raw.trim()
        if (text.isEmpty()) return ChatIntent.Unknown
        val lower = text.lowercase()

        // Corrections are checked first, but only for sentences that are not questions: "what
        // should I charge, 7.99?" is a question about a price, not an instruction to save one.
        if (!looksLikeQuestion(lower)) {
            parseCorrection(lower)?.let { return it }
        }

        parseCostFilter(lower)?.let { return it }
        parseProfit(lower)?.let { return it }
        parseCaseQuantity(lower)?.let { return it }
        parseLastCharged(lower)?.let { return it }
        parseOrderSummary(lower)?.let { return it }
        parsePriceLookup(lower)?.let { return it }

        return ChatIntent.Unknown
    }

    private fun looksLikeQuestion(lower: String): Boolean {
        val firstWord = lower.substringBefore(' ').trim('?', '.', ',', '!')
        return firstWord in QUESTION_OPENERS || lower.endsWith("?")
    }

    // ---------------------------------------------------------------- corrections

    private val CORRECTION_LEADS = listOf(
        "i put", "i charge", "i sell", "i'm charging", "im charging", "i am charging",
        "we put", "we charge", "we sell", "make that", "make it", "change it to",
        "change that to", "set it to", "put it at", "it's", "its", "that's", "thats",
    )

    private fun parseCorrection(lower: String): ChatIntent.Correction? {
        val ordinals = parseOrdinalCorrections(lower)
        if (ordinals.isNotEmpty()) return ChatIntent.Correction(ordinals)

        val price = singleMoneyIn(lower) ?: return null

        // "all five cereals are 7.99" / "all of them are 7.99"
        if (Regex("""\ball\b""").containsMatchIn(lower)) {
            return ChatIntent.Correction(listOf(CorrectionTarget.AllListed(price)))
        }

        val lead = CORRECTION_LEADS.firstOrNull { lower.startsWith(it) || lower.contains(" $it ") }
            ?: return null

        // What sits between the lead and the price, if anything, names the product.
        val after = lower.substringAfter(lead).substringBefore(MONEY.find(lower)?.value ?: "")
        val phrase = after.replace(Regex("""\b(at|to|for|is|as)\b"""), " ").trim(' ', ',', '-')

        return if (phrase.isBlank()) {
            ChatIntent.Correction(listOf(CorrectionTarget.Current(price)))
        } else {
            ChatIntent.Correction(listOf(CorrectionTarget.Named(phrase, price)))
        }
    }

    /** "number one 2.99 and number two 11.99" - each clause is its own target. */
    private fun parseOrdinalCorrections(lower: String): List<CorrectionTarget> {
        val pattern = Regex(
            """(?:number|no\.?|#|item)\s*([0-9]{1,2}|${ORDINAL_WORDS.keys.joinToString("|")})""" +
                """\s*(?:is|are|should be|=|at|to|->)?\s*\$?\s?(\d{1,6}(?:[.,]\d{1,2})?)""",
        )
        return pattern.findAll(lower).mapNotNull { match ->
            val positionText = match.groupValues[1]
            val position = positionText.toIntOrNull() ?: ORDINAL_WORDS[positionText]
            val price = Money.parseOrNull(match.groupValues[2])
            if (position == null || price == null || position <= 0) null
            else CorrectionTarget.Ordinal(position, price)
        }.toList()
    }

    // ---------------------------------------------------------------- questions

    private fun parseProfit(lower: String): ChatIntent.ProfitAt? {
        if (!lower.contains("profit") && !lower.contains("make") && !lower.contains("margin")) {
            return null
        }
        val price = lastMoneyIn(lower) ?: return null
        val phrase = productPhrase(
            lower.replace(Regex("""\b(profit|margin|gross)\b"""), " ")
                .substringBefore(" if ")
                .substringBefore(" at "),
        )
        return ChatIntent.ProfitAt(
            request = phrase?.let { QueryRequest(it) },
            retailPrice = price,
        )
    }

    private fun parseCaseQuantity(lower: String): ChatIntent.CaseQuantity? {
        val asksCount = lower.contains("how many") ||
            lower.contains("per case") ||
            lower.contains("in the case") ||
            lower.contains("in a case") ||
            lower.contains("in the box") ||
            lower.contains("case count")
        if (!asksCount) return null
        val phrase = productPhrase(
            lower.replace(
                Regex("""\b(how many|are|is|in|the|a|an|case|box|per|come|comes|there)\b"""),
                " ",
            ),
        )
        // "how many are in the case" with no product names the thing just discussed; the caller
        // resolves that from conversation context.
        return ChatIntent.CaseQuantity(QueryRequest(phrase.orEmpty()))
    }

    private fun parseLastCharged(lower: String): ChatIntent.LastCharged? {
        val asks = (lower.contains("last time") || lower.contains("previously") ||
            lower.contains("before")) &&
            (lower.contains("charge") || lower.contains("price") || lower.contains("sell"))
        if (!asks) return null
        val phrase = productPhrase(
            lower.replace(Regex("""\b(last time|previously|before|charge|charged|price|sell)\b"""), " "),
        )
        return ChatIntent.LastCharged(QueryRequest(phrase.orEmpty()))
    }

    private fun parseCostFilter(lower: String): ChatIntent? {
        val under = Regex("""\b(under|below|less than|cheaper than)\b""").containsMatchIn(lower)
        val over = Regex("""\b(over|above|more than|dearer than)\b""").containsMatchIn(lower)
        if (!under && !over) return null
        // Only a cost filter when it is actually about cost or price.
        if (!lower.contains("cost") && !lower.contains("price") && !lower.contains("$")) return null
        val limit = singleMoneyIn(lower) ?: return null
        return if (under) ChatIntent.CostUnder(limit) else ChatIntent.CostOver(limit)
    }

    private fun parseOrderSummary(lower: String): ChatIntent? {
        val summaryWords = listOf("order summary", "summary of the order", "how many products",
            "how many items", "what's in this order", "whats in this order")
        return if (summaryWords.any { lower.contains(it) }) ChatIntent.OrderSummary else null
    }

    private val PRICE_QUESTION_LEADS = listOf(
        "how much is", "how much are", "how much was", "how much were", "how much for",
        "how much do", "how much did", "what did we pay for", "what did you pay for",
        "what do we pay for", "what did we pay", "what should i charge for",
        "what should i charge", "what should i sell", "cost of", "price of", "price for",
        "show me the", "show me", "give me the", "give me", "what about the", "what about",
        "how much",
    )

    /**
     * Only fires when the sentence actually opened like a price question.
     *
     * A bare phrase - "8 oz", "Hellmann's Mayonnaise 8 oz" - deliberately falls through to
     * [ChatIntent.Unknown]. The router tries those against the local query engine anyway, so
     * they still answer without an API call; what this avoids is treating every unrecognised
     * sentence as a product lookup and confidently answering the wrong question.
     */
    private fun parsePriceLookup(lower: String): ChatIntent.PriceLookup? {
        val lead = PRICE_QUESTION_LEADS.firstOrNull { lower.startsWith(it) } ?: return null
        val phrase = productPhrase(stripFillers(lower.removePrefix(lead))) ?: return null

        val plural = Regex("""\b(are|were|these|those|them|all|both|each)\b""")
            .containsMatchIn(lower) || COUNT_WORDS.keys.any { Regex("""\b$it\b""").containsMatchIn(lower) }
        val count = COUNT_WORDS.entries
            .firstOrNull { Regex("""\b${it.key}\b""").containsMatchIn(lower) }?.value
            ?: Regex("""\ball (\d{1,2})\b""").find(lower)?.groupValues?.get(1)?.toIntOrNull()

        return ChatIntent.PriceLookup(
            QueryRequest(phrase = phrase, expectMultiple = plural, expectedCount = count),
        )
    }

    // ---------------------------------------------------------------- helpers

    private val LEADING_ARTICLE = Regex("^(?:the|a|an)\\s+")

    /**
     * Connective words left over once the opening phrase is removed.
     *
     * "How much should I charge for the cereal" matches the lead "how much", which leaves
     * "should i charge for the cereal" - and every one of those words would then be treated as
     * part of the product name. Longest first, applied repeatedly, until only the noun is left.
     */
    private val BODY_FILLERS = listOf(
        "should i be charging for", "should i be charging", "should i charge for",
        "should i sell it for", "should i sell for", "should i charge", "should i sell",
        "should we charge for", "should we charge", "do i charge for", "did we pay for",
        "did i pay for", "do we pay for", "can i charge for", "i charge for", "we charge for",
        "to charge for", "charge for", "pay for", "for", "is", "are", "was", "were", "it",
    ).sortedByDescending { it.length }

    private fun stripFillers(raw: String): String {
        var text = raw.trim(' ', '?', '.', ',', '!', ':', ';', '-')
        var changed = true
        while (changed) {
            changed = false
            for (filler in BODY_FILLERS) {
                if (text == filler) return ""
                if (text.startsWith(filler + " ")) {
                    text = text.removePrefix(filler + " ").trimStart()
                    changed = true
                    break
                }
            }
            val withoutArticle = LEADING_ARTICLE.replace(text, "")
            if (withoutArticle != text) {
                text = withoutArticle
                changed = true
            }
        }
        return text
    }

    private fun productPhrase(raw: String): String? =
        LEADING_ARTICLE.replace(raw.trim(' ', '?', '.', ',', '!', ':', ';', '-'), "")
            .trim(' ', '?', '.', ',', '!', ':', ';', '-')
            .takeIf { it.isNotBlank() }

    private fun singleMoneyIn(text: String): Money? {
        val matches = MONEY.findAll(text).toList()
        if (matches.size != 1) return null
        return Money.parseOrNull(matches.single().groupValues[1])
    }

    private fun lastMoneyIn(text: String): Money? =
        MONEY.findAll(text).lastOrNull()?.let { Money.parseOrNull(it.groupValues[1]) }
}
