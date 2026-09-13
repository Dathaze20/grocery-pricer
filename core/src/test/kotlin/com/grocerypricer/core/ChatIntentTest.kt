package com.grocerypricer.core

import com.grocerypricer.core.ai.AiResponseParser
import com.grocerypricer.core.ai.AiResult
import com.grocerypricer.core.ai.OrderQuestionResolution
import com.grocerypricer.core.chat.ChatAnswerFormatter
import com.grocerypricer.core.chat.ChatIntent
import com.grocerypricer.core.chat.ChatIntentParser
import com.grocerypricer.core.chat.CorrectionTarget
import com.grocerypricer.core.chat.PriceAnswer
import com.grocerypricer.core.money.Money
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatIntentParserTest {

    private fun lookup(text: String): ChatIntent.PriceLookup {
        val intent = ChatIntentParser.parse(text)
        assertTrue("expected a price lookup for \"$text\", got $intent", intent is ChatIntent.PriceLookup)
        return intent as ChatIntent.PriceLookup
    }

    @Test
    fun `the everyday price questions are all recognised locally`() {
        assertEquals("carnation milk", lookup("How much is the Carnation milk?").request.phrase)
        assertEquals("cereal", lookup("What did we pay for the cereal?").request.phrase)
        assertEquals("cereal", lookup("How much should I charge for the cereal?").request.phrase)
        assertTrue(lookup("how much is hellmann's mayonnaise 8 oz").request.phrase.contains("mayonnaise"))
    }

    @Test
    fun `plural wording asks for several answers, singular does not`() {
        assertTrue(lookup("How much are the two juices?").request.expectMultiple)
        assertEquals(2, lookup("How much are the two juices?").request.expectedCount)
        assertEquals(3, lookup("How much are these three oils?").request.expectedCount)
        assertTrue(!lookup("How much is the mayonnaise?").request.expectMultiple)
    }

    @Test
    fun `how many in the case is a case-quantity question, not a price question`() {
        assertTrue(ChatIntentParser.parse("How many bottles are in the case?") is ChatIntent.CaseQuantity)
        assertTrue(ChatIntentParser.parse("how many come in the box") is ChatIntent.CaseQuantity)
    }

    @Test
    fun `profit questions carry the price the user proposed`() {
        val intent = ChatIntentParser.parse("What's my profit if I sell it for 7.99?")
        assertTrue(intent is ChatIntent.ProfitAt)
        assertEquals(Money.of("7.99"), (intent as ChatIntent.ProfitAt).retailPrice)
    }

    @Test
    fun `cost filters are recognised`() {
        val under = ChatIntentParser.parse("Show me all the products under ${'$'}3 cost")
        assertTrue(under is ChatIntent.CostUnder)
        assertEquals(Money.of("3"), (under as ChatIntent.CostUnder).limit)
    }

    @Test
    fun `what did I charge last time is its own question`() {
        assertTrue(ChatIntentParser.parse("What did I charge last time?") is ChatIntent.LastCharged)
    }

    // ------------------------------------------------------------ corrections

    private fun correction(text: String): List<CorrectionTarget> {
        val intent = ChatIntentParser.parse(text)
        assertTrue("expected a correction for \"$text\", got $intent", intent is ChatIntent.Correction)
        return (intent as ChatIntent.Correction).targets
    }

    @Test
    fun `I put seven ninety nine corrects whatever was being discussed`() {
        val target = correction("I put 7.99").single()
        assertTrue(target is CorrectionTarget.Current)
        assertEquals(Money.of("7.99"), target.price)
    }

    @Test
    fun `make that corrects the current product too`() {
        assertTrue(correction("Make that 8.99").single() is CorrectionTarget.Current)
    }

    @Test
    fun `numbered corrections resolve against the last list`() {
        val target = correction("Number two should be 7.99").single()
        assertEquals(2, (target as CorrectionTarget.Ordinal).position)
        assertEquals(Money.of("7.99"), target.price)
    }

    @Test
    fun `two numbered corrections in one sentence both land`() {
        val targets = correction("Number one 2.99 and number two 11.99")
        assertEquals(2, targets.size)
        assertEquals(1, (targets[0] as CorrectionTarget.Ordinal).position)
        assertEquals(Money.of("2.99"), targets[0].price)
        assertEquals(2, (targets[1] as CorrectionTarget.Ordinal).position)
        assertEquals(Money.of("11.99"), targets[1].price)
    }

    @Test
    fun `all five cereals are seven ninety nine applies to everything just listed`() {
        val target = correction("All the cereals are 7.99").single()
        assertTrue(target is CorrectionTarget.AllListed)
        assertEquals(Money.of("7.99"), target.price)
    }

    @Test
    fun `a question that merely mentions a price is never treated as a correction`() {
        // This is the one that would quietly rewrite a shelf price if it went wrong.
        assertTrue(ChatIntentParser.parse("What's my profit if I sell it for 7.99?") !is ChatIntent.Correction)
        assertTrue(ChatIntentParser.parse("How much is the 7.99 cereal?") !is ChatIntent.Correction)
        assertTrue(ChatIntentParser.parse("Is 7.99 too much?") !is ChatIntent.Correction)
    }

    @Test
    fun `an unrecognised sentence bails out to the model rather than guessing`() {
        assertEquals(ChatIntent.Unknown, ChatIntentParser.parse("hmm"))
        assertEquals(ChatIntent.Unknown, ChatIntentParser.parse(""))
    }
}

class ChatAnswerFormatterTest {

    private val mayo = PriceAnswer(
        itemId = 1,
        displayName = "Hellmann's Mayonnaise",
        size = "8 oz",
        unitCost = Money.of("2.17"),
        suggestedRetail = Money.of("4.99"),
    )

    private val milk = PriceAnswer(
        itemId = 2,
        displayName = "Carnation Evaporated Milk",
        size = "12 oz",
        unitCost = Money.of("4.20"),
        suggestedRetail = Money.of("7.99"),
        unitsPerCase = 8,
        unitNoun = "can",
    )

    @Test
    fun `one product renders exactly as the brief specifies`() {
        assertEquals("Hellmann's Mayonnaise 8 oz\n${'$'}2.17 → ${'$'}4.99", ChatAnswerFormatter.single(mayo))
    }

    @Test
    fun `several products render numbered`() {
        val oils = listOf(
            PriceAnswer(1, "Red & White Vegetable Oil", "48 oz", Money.of("4.36"), Money.of("7.99")),
            PriceAnswer(2, "Red & White Corn Oil", "48 oz", Money.of("4.64"), Money.of("8.99")),
            PriceAnswer(3, "Red & White Corn Oil", "32 oz", Money.of("3.35"), Money.of("6.99")),
        )
        assertEquals(
            "1. Red & White Vegetable Oil 48 oz\n${'$'}4.36 → ${'$'}7.99\n\n" +
                "2. Red & White Corn Oil 48 oz\n${'$'}4.64 → ${'$'}8.99\n\n" +
                "3. Red & White Corn Oil 32 oz\n${'$'}3.35 → ${'$'}6.99",
            ChatAnswerFormatter.numbered(oils),
        )
    }

    @Test
    fun `a single-item list is not numbered`() {
        assertEquals(ChatAnswerFormatter.single(mayo), ChatAnswerFormatter.numbered(listOf(mayo)))
    }

    @Test
    fun `case quantity renders with the right noun and plural`() {
        assertEquals("Carnation Evaporated Milk 12 oz\n8 cans per case.", ChatAnswerFormatter.caseQuantity(milk))
        assertEquals(
            "Carnation Evaporated Milk 12 oz\n1 can per case.",
            ChatAnswerFormatter.caseQuantity(milk.copy(unitsPerCase = 1)),
        )
        assertEquals(
            "Carnation Evaporated Milk 12 oz\n8 units per case.",
            ChatAnswerFormatter.caseQuantity(milk.copy(unitNoun = null)),
        )
    }

    @Test
    fun `profit renders cost, sell and gross profit`() {
        assertEquals(
            "Carnation Evaporated Milk 12 oz\nCost: ${'$'}4.20\nSell: ${'$'}7.99\nGross profit: ${'$'}3.79 each",
            ChatAnswerFormatter.profitAt(milk, Money.of("7.99")),
        )
    }

    @Test
    fun `a saved correction says what was saved`() {
        assertEquals(
            "Saved. Hellmann's Mayonnaise 8 oz → ${'$'}6.99",
            ChatAnswerFormatter.savedPrice(mayo, Money.of("6.99")),
        )
    }

    @Test
    fun `what the user set outranks what was suggested`() {
        val corrected = mayo.copy(approvedRetail = Money.of("6.99"))
        assertTrue(ChatAnswerFormatter.single(corrected).endsWith("${'$'}6.99"))
    }

    @Test
    fun `an unreadable cost says so instead of inventing a number`() {
        val unknown = mayo.copy(unitCost = null, suggestedRetail = null)
        assertTrue(ChatAnswerFormatter.single(unknown).contains("could not read the cost"))
        assertTrue(ChatAnswerFormatter.profitAt(unknown, Money.of("7.99")).contains("cannot work out"))
    }

    @Test
    fun `a cost change is reported from Money arithmetic, both directions`() {
        val risen = mayo.copy(unitCost = Money.of("2.39"), previousUnitCost = Money.of("2.17"))
        assertEquals("The cost went up ${'$'}0.22 from ${'$'}2.17.", ChatAnswerFormatter.costChange(risen))
        val fallen = mayo.copy(unitCost = Money.of("2.00"), previousUnitCost = Money.of("2.17"))
        assertEquals("The cost went down ${'$'}0.17 from ${'$'}2.17.", ChatAnswerFormatter.costChange(fallen))
        assertNull(ChatAnswerFormatter.costChange(mayo.copy(previousUnitCost = Money.of("2.17"))))
    }
}

/**
 * The load-bearing guarantee of the whole V2 architecture: a model can pick a product, and that
 * is all it can do. Every number the shopkeeper reads comes from the local database.
 */
class ModelCannotSetPricesTest {

    @Test
    fun `a model insisting on a price has no field to put it in`() {
        // The reply names the right product but also states a cost, confidently and wrongly.
        val raw = """
            {"kind":"PRODUCT_MATCHES","itemIds":[7],
             "reply":"The Carnation milk costs ${'$'}1.00 and you should charge ${'$'}1.50",
             "unitCost":"1.00","suggestedRetail":"1.50","price":"1.00"}
        """
        val resolution =
            (AiResponseParser.parseQuestionResolution(raw, setOf(7L)) as AiResult.Success).value
        val matches = resolution as OrderQuestionResolution.ProductMatches
        assertEquals(listOf(7L), matches.itemIds)

        // The resolution carries an id and nothing else spendable. The answer is then built from
        // the database row, and that is what renders.
        val fromDatabase = PriceAnswer(
            itemId = 7,
            displayName = "Carnation Evaporated Milk",
            size = "12 oz",
            unitCost = Money.of("4.20"),
            suggestedRetail = Money.of("7.99"),
        )
        val rendered = ChatAnswerFormatter.single(fromDatabase)
        assertEquals("Carnation Evaporated Milk 12 oz\n${'$'}4.20 → ${'$'}7.99", rendered)
        assertTrue("the model's number must not appear", !rendered.contains("1.00"))
        assertTrue(!rendered.contains("1.50"))
    }

    @Test
    fun `a price correction still goes through Money, never through model text`() {
        val raw = """{"kind":"PRICE_CORRECTION","updates":[{"itemId":3,"retailPrice":"not a price"}]}"""
        val resolution =
            (AiResponseParser.parseQuestionResolution(raw, setOf(3L)) as AiResult.Success).value
        val correction = resolution as OrderQuestionResolution.PriceCorrection
        // The string survives parsing, but Money is the only thing that can turn it into money -
        // and it refuses.
        assertNull(Money.parseOrNull(correction.updates.single().retailPrice))
    }
}
