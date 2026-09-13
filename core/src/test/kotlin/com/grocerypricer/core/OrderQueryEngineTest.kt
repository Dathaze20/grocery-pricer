package com.grocerypricer.core

import com.grocerypricer.core.money.Money
import com.grocerypricer.core.query.OrderQueryEngine
import com.grocerypricer.core.query.QueryOutcome
import com.grocerypricer.core.query.QueryRequest
import com.grocerypricer.core.query.QueryableOrderItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private data class TestItem(
    override val productId: Long,
    override val name: String,
    override val size: String?,
    override val brand: String? = null,
    override val category: String? = "Grocery",
    override val upc: String? = null,
    override val supplierSku: String? = null,
    override val unitsPerCase: Int? = 12,
    override val unitCost: Money? = Money.of("2.00"),
    override val suggestedRetail: Money? = Money.of("4.99"),
    override val approvedRetail: Money? = null,
) : QueryableOrderItem

/**
 * These are the literal examples from the V2 brief. Every one of them is a sentence the
 * shopkeeper is expected to be able to type, so each is pinned as a test rather than left to
 * whether the scoring happens to work out.
 *
 * The fixtures are fixtures. None of these products or prices is preloaded anywhere in the app.
 */
class OrderQueryEngineTest {

    private val order = listOf(
        TestItem(1, "Hellmann's Mayonnaise", "8 oz", brand = "Hellmann's", category = "Condiments"),
        TestItem(2, "Hellmann's Mayonnaise", "15 oz", brand = "Hellmann's", category = "Condiments"),
        TestItem(3, "Tide Original", "40 fl oz", brand = "Tide", category = "Cleaning"),
        TestItem(4, "Tide Original", "25 fl oz", brand = "Tide", category = "Cleaning"),
        TestItem(5, "Red & White Corn Oil", "48 oz", category = "Oils"),
        TestItem(6, "Red & White Corn Oil", "32 oz", category = "Oils"),
        TestItem(7, "Red & White Vegetable Oil", "48 oz", category = "Oils"),
        TestItem(8, "Ocean Spray Cranberry Juice", "64 oz", category = "Juice"),
        TestItem(9, "Mott's Apple Juice", "64 oz", category = "Juice"),
        TestItem(10, "Carnation Evaporated Milk", "12 oz", brand = "Carnation", upc = "050000000123"),
        TestItem(11, "Downy Soft April Fresh", "10 fl oz", brand = "Downy"),
    )

    private val engine = OrderQueryEngine(order)

    private fun exactId(phrase: String): Long {
        val outcome = engine.resolve(QueryRequest(phrase))
        assertTrue("expected one answer for \"$phrase\", got $outcome", outcome is QueryOutcome.Exact)
        return (outcome as QueryOutcome.Exact).item.productId
    }

    @Test
    fun `mayo 8 finds the eight ounce mayonnaise`() {
        assertEquals(1L, exactId("mayo 8"))
    }

    @Test
    fun `Tide 40 finds the forty ounce Tide`() {
        assertEquals(3L, exactId("Tide 40"))
    }

    @Test
    fun `corn oil 48 finds the corn oil, not the vegetable oil and not the 32`() {
        assertEquals(5L, exactId("corn oil 48"))
    }

    @Test
    fun `a full sentence works as well as a bare phrase`() {
        assertEquals(10L, exactId("How much is the Carnation milk?"))
        assertEquals(1L, exactId("What did we pay for the Hellmann's mayonnaise 8 oz?"))
    }

    @Test
    fun `the mayonnaise with two sizes on the receipt asks rather than guesses`() {
        val outcome = engine.resolve(QueryRequest("the mayonnaise"))
        assertTrue(outcome is QueryOutcome.Ambiguous)
        val ids = (outcome as QueryOutcome.Ambiguous).candidates.map { it.productId }.toSet()
        assertEquals(setOf(1L, 2L), ids)
    }

    @Test
    fun `answering that question with a bare size resolves it`() {
        assertEquals(1L, exactId("Hellmann's Mayonnaise 8 oz"))
    }

    @Test
    fun `the two juices returns both juices`() {
        val outcome = engine.resolve(
            QueryRequest("the two juices", expectMultiple = true, expectedCount = 2),
        )
        assertTrue("got $outcome", outcome is QueryOutcome.Several)
        val ids = (outcome as QueryOutcome.Several).items.map { it.productId }.toSet()
        assertEquals(setOf(8L, 9L), ids)
    }

    @Test
    fun `the oils returns the three oils`() {
        val outcome = engine.resolve(QueryRequest("the oils", expectMultiple = true))
        assertTrue("got $outcome", outcome is QueryOutcome.Several)
        assertEquals(3, (outcome as QueryOutcome.Several).items.size)
    }

    @Test
    fun `a size the user named is a hard filter, never a preference`() {
        // There is no 64 oz Tide. Silently answering with the 40 would be a wrong shelf price.
        val outcome = engine.resolve(QueryRequest("Tide 64 oz"))
        assertEquals(QueryOutcome.None, outcome)
    }

    @Test
    fun `a product that is simply not in this order returns nothing`() {
        assertEquals(QueryOutcome.None, engine.resolve(QueryRequest("Heinz ketchup")))
        assertEquals(QueryOutcome.None, engine.resolve(QueryRequest("")))
    }

    @Test
    fun `a barcode resolves exactly or not at all`() {
        assertEquals(10L, engine.byBarcode("050000000123")?.productId)
        assertEquals(null, engine.byBarcode("999999999999"))
        assertEquals(null, engine.byBarcode(null))
        // A barcode inside a typed sentence still resolves.
        assertEquals(10L, exactId("050000000123"))
    }

    @Test
    fun `category lookup is case insensitive`() {
        assertEquals(3, engine.inCategory("oils").size)
        assertEquals(3, engine.inCategory("Oils").size)
        assertEquals(0, engine.inCategory("Pet Food").size)
        assertEquals(0, engine.inCategory(null).size)
    }

    @Test
    fun `cost filters use Money comparison, not string or double comparison`() {
        val cheap = OrderQueryEngine(
            listOf(
                TestItem(1, "Cheap", "8 oz", unitCost = Money.of("2.99")),
                TestItem(2, "Exactly three", "8 oz", unitCost = Money.of("3.00")),
                TestItem(3, "Dear", "8 oz", unitCost = Money.of("10.00")),
                TestItem(4, "Unknown cost", "8 oz", unitCost = null),
            ),
        )
        // Strictly under: $3.00 itself is not under $3.00, and an unknown cost is not under it.
        assertEquals(listOf(1L), cheap.costingUnder(Money.of("3.00")).map { it.productId })
        assertEquals(listOf(3L), cheap.costingOver(Money.of("3.00")).map { it.productId })
    }

    @Test
    fun `the shortlist for the model is short and relevant`() {
        val candidates = engine.candidatesFor("mayonnaise")
        assertTrue(candidates.size <= OrderQueryEngine.MAX_CANDIDATES)
        assertEquals(setOf(1L, 2L), candidates.map { it.productId }.toSet())
    }

    @Test
    fun `an unmatchable phrase still offers something for the model to work with`() {
        val candidates = engine.candidatesFor("zzzz nothing like this")
        assertTrue(candidates.isNotEmpty())
    }

    @Test
    fun `item ids resolve back in the order they were asked for`() {
        assertEquals(listOf(9L, 8L), engine.byItemIds(listOf(9L, 8L)).map { it.productId })
        // An id from another order is dropped rather than throwing.
        assertEquals(listOf(8L), engine.byItemIds(listOf(8L, 4242L)).map { it.productId })
    }
}
