package com.grocerypricer.app

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.grocerypricer.app.ai.FakeAiProvider
import com.grocerypricer.app.chat.ConversationEngine
import com.grocerypricer.app.data.db.GroceryPricerDatabase
import com.grocerypricer.app.data.model.OrderItem
import com.grocerypricer.app.data.repository.OrderRepository
import com.grocerypricer.app.data.repository.ProductRepository
import com.grocerypricer.core.ai.AiError
import com.grocerypricer.core.ai.AiResult
import com.grocerypricer.core.ai.AiVisualProduct
import com.grocerypricer.core.ai.OrderQuestionResolution
import com.grocerypricer.core.ai.ProductIdentification
import com.grocerypricer.core.model.Category
import com.grocerypricer.core.model.PricingRules
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.pricing.CostCalculator
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The conversations the brief says a shopkeeper must be able to have.
 *
 * Every one of these is a sentence from the V2 specification, pinned as a test so it stays
 * working. The fixtures are fixtures - none of these products or prices ships in the app.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = android.app.Application::class)
class ConversationEngineTest {

    private lateinit var database: GroceryPricerDatabase
    private lateinit var orderRepository: OrderRepository
    private lateinit var engine: ConversationEngine
    private var orderId: Long = 0

    private val rules = PricingRules()

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        database = Room.inMemoryDatabaseBuilder(context, GroceryPricerDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        val productRepository = ProductRepository(
            productDao = database.productDao(),
            priceHistoryDao = database.priceHistoryDao(),
            scanHistoryDao = database.scanHistoryDao(),
        )
        orderRepository = OrderRepository(database, productRepository)
        engine = ConversationEngine(orderRepository, productRepository)

        runBlocking {
            orderId = orderRepository.createOrder("Jetro / Restaurant Depot", "Sep 12 Order", 0L)
            addItem("Hellmann's Mayonnaise", "8 oz", casePrice = "26.04", units = 12, Category.OTHER)
            addItem("Hellmann's Mayonnaise", "15 oz", casePrice = "44.00", units = 12, Category.OTHER)
            addItem("Ocean Spray Cranberry Juice", "64 oz", casePrice = "26.56", units = 8, Category.BEVERAGES)
            addItem("Mott's Apple Juice", "64 oz", casePrice = "31.44", units = 8, Category.BEVERAGES)
            addItem("Carnation Evaporated Milk", "12 oz", casePrice = "33.60", units = 8, Category.OTHER)
        }
    }

    @After
    fun tearDown() = database.close()

    private suspend fun addItem(
        name: String,
        size: String,
        casePrice: String,
        units: Int,
        category: Category,
    ) {
        val price = Money.of(casePrice)
        orderRepository.addManualItem(
            orderId,
            OrderItem(
                orderId = orderId,
                description = name,
                size = size,
                category = category,
                casePrice = price,
                unitsPerCase = units,
                casesPurchased = 1,
                cost = CostCalculator.calculate(price, units, 1, 0, null),
            ),
            rules,
        )
    }

    private fun ask(
        message: String,
        provider: FakeAiProvider? = null,
        lastListed: List<Long> = emptyList(),
    ) = runBlocking {
        engine.reply(
            orderId = orderId,
            message = message,
            attachment = null,
            history = emptyList(),
            lastListedItemIds = lastListed,
            provider = provider,
        )
    }

    private fun itemId(name: String, size: String): Long = runBlocking {
        orderRepository.getItems(orderId).first { it.description == name && it.size == size }.id
    }

    // ---------------------------------------------------------------- the acceptance flow

    @Test
    fun `how much is the Carnation milk answers with cost and shelf price`() {
        val reply = ask("How much is the Carnation milk?")
        assertTrue(reply.text, reply.text.startsWith("Carnation Evaporated Milk 12 oz"))
        assertTrue(reply.text, reply.text.contains("→"))
        // $33.60 over 8 cans is $4.20 - computed by Kotlin, not quoted by anyone.
        assertTrue(reply.text, reply.text.contains("${'$'}4.20"))
    }

    @Test
    fun `the mayonnaise with two sizes asks which one, without calling the model`() {
        val provider = FakeAiProvider()
        val reply = ask("How much is the mayonnaise?", provider)
        assertTrue(reply.text, reply.text.contains("8 oz") && reply.text.contains("15 oz"))
        assertTrue(reply.text, reply.text.contains("Which one"))
        // A question the app can answer itself must not cost the shopkeeper an API call.
        assertEquals(0, provider.questionRequests.size)
    }

    @Test
    fun `answering that question with a bare size resolves to the right product`() {
        val reply = ask("8 oz")
        assertTrue(reply.text, reply.text.startsWith("Hellmann's Mayonnaise 8 oz"))
        assertEquals(listOf(itemId("Hellmann's Mayonnaise", "8 oz")), reply.listedItemIds)
    }

    @Test
    fun `how much are the two juices returns both, numbered`() {
        val reply = ask("How much are the two juices?")
        assertTrue(reply.text, reply.text.contains("1. "))
        assertTrue(reply.text, reply.text.contains("2. "))
        assertTrue(reply.text, reply.text.contains("Ocean Spray"))
        assertTrue(reply.text, reply.text.contains("Mott's"))
        assertEquals(2, reply.listedItemIds.size)
    }

    @Test
    fun `how many in the case answers the case count`() {
        val reply = ask("How many are in the case?", lastListed = listOf(itemId("Carnation Evaporated Milk", "12 oz")))
        assertTrue(reply.text, reply.text.contains("8"))
        assertTrue(reply.text, reply.text.contains("per case"))
    }

    @Test
    fun `profit at a proposed price is worked out from the stored cost`() {
        val milk = itemId("Carnation Evaporated Milk", "12 oz")
        val reply = ask("What's my profit if I sell it for 7.99?", lastListed = listOf(milk))
        assertTrue(reply.text, reply.text.contains("Cost: ${'$'}4.20"))
        assertTrue(reply.text, reply.text.contains("Sell: ${'$'}7.99"))
        assertTrue(reply.text, reply.text.contains("Gross profit: ${'$'}3.79 each"))
    }

    // ---------------------------------------------------------------- corrections

    @Test
    fun `number two should be seven ninety nine saves against the second item listed`() {
        val listed = ask("How much are the two juices?").listedItemIds
        assertEquals(2, listed.size)

        val reply = ask("Number two should be 7.99", lastListed = listed)
        assertTrue(reply.text, reply.text.startsWith("Saved."))
        assertEquals(listOf(listed[1] to Money.of("7.99")), reply.savedPrices)

        // And it is actually in the database afterwards, not just in the sentence.
        val saved = runBlocking { orderRepository.getItem(listed[1]) }
        assertEquals(Money.of("7.99"), saved?.approvedPrice)
        // The first one is untouched.
        assertEquals(null, runBlocking { orderRepository.getItem(listed[0]) }?.approvedPrice)
    }

    @Test
    fun `I put outranks the suggestion from then on`() {
        val mayo = itemId("Hellmann's Mayonnaise", "8 oz")
        ask("I put 6.99", lastListed = listOf(mayo))
        val reply = ask("How much is the mayonnaise 8 oz?")
        assertTrue(reply.text, reply.text.endsWith("${'$'}6.99"))
    }

    @Test
    fun `a correction naming no resolvable product saves nothing`() {
        val reply = ask("I put 7.99")
        assertTrue(reply.text, reply.text.contains("not sure which product"))
        assertTrue(reply.savedPrices.isEmpty())
    }

    @Test
    fun `a question mentioning a price never saves it`() {
        val milk = itemId("Carnation Evaporated Milk", "12 oz")
        ask("What's my profit if I sell it for 7.99?", lastListed = listOf(milk))
        assertEquals(null, runBlocking { orderRepository.getItem(milk) }?.approvedPrice)
    }

    // ---------------------------------------------------------------- the model's limits

    @Test
    fun `the model picks the product but never the price`() {
        val milk = itemId("Carnation Evaporated Milk", "12 oz")
        // The reply names the right row while insisting, in prose and in invented fields, that
        // the cost is a dollar.
        val provider = FakeAiProvider().respondWithRawQuestion(
            """{"kind":"PRODUCT_MATCHES","itemIds":[$milk],
                "reply":"It costs ${'$'}1.00, sell it for ${'$'}1.50",
                "unitCost":"1.00","suggestedRetail":"1.50"}""",
            setOf(milk),
        )
        val reply = ask("what's the deal with that milk thing", provider)
        assertTrue(reply.text, reply.text.contains("${'$'}4.20"))
        assertTrue(reply.text, !reply.text.contains("1.00"))
        assertTrue(reply.text, !reply.text.contains("1.50"))
    }

    @Test
    fun `a model naming a product from another order is ignored`() {
        val provider = FakeAiProvider().respondWithQuestion(
            AiResult.Success(OrderQuestionResolution.ProductMatches(listOf(999_999L))),
        )
        val reply = ask("zzz something unmatchable", provider)
        assertTrue(reply.text, reply.text.contains("could not find"))
    }

    @Test
    fun `an API failure is reported in plain words, not as a crash`() {
        for (error in listOf(
            AiError.InvalidKey,
            AiError.Billing,
            AiError.RateLimited(30),
            AiError.Timeout,
            AiError.Network("x"),
            AiError.MalformedResponse("x"),
            AiError.RequestTooLarge,
        )) {
            val provider = FakeAiProvider().respondWithQuestion(AiResult.Failure(error))
            val reply = ask("zzz something unmatchable", provider)
            assertEquals(error.userMessage(), reply.text)
        }
    }

    @Test
    fun `with no provider at all the order is still searchable`() {
        // Offline: a named product still answers, because that never needed the network.
        val reply = ask("How much is the Carnation milk?", provider = null)
        assertTrue(reply.text, reply.text.contains("${'$'}4.20"))

        // And a question that genuinely needs the model says so rather than failing silently.
        val vague = ask("zzz something unmatchable", provider = null)
        assertTrue(vague.text, vague.text.contains("internet connection"))
    }

    // ---------------------------------------------------------------- photographs

    @Test
    fun `a photo of a product is matched against this order`() {
        val provider = FakeAiProvider().respondWithIdentification(
            AiResult.Success(
                ProductIdentification(
                    listOf(
                        AiVisualProduct(
                            brand = "Carnation",
                            productName = "Carnation Evaporated Milk",
                            size = "12 oz",
                            position = 0,
                            confidence = 0.9,
                        ),
                    ),
                ),
            ),
        )
        val reply = runBlocking {
            engine.reply(
                orderId = orderId,
                message = "How much is this?",
                attachment = com.grocerypricer.core.ai.AiImage(0L, ByteArray(4)),
                history = emptyList(),
                lastListedItemIds = emptyList(),
                provider = provider,
            )
        }
        assertTrue(reply.text, reply.text.startsWith("Carnation Evaporated Milk 12 oz"))
        assertTrue(reply.text, reply.text.contains("${'$'}4.20"))
    }

    @Test
    fun `a photo of two products returns two numbered answers`() {
        val provider = FakeAiProvider().respondWithIdentification(
            AiResult.Success(
                ProductIdentification(
                    listOf(
                        AiVisualProduct(productName = "Ocean Spray Cranberry Juice", size = "64 oz", position = 0),
                        AiVisualProduct(productName = "Mott's Apple Juice", size = "64 oz", position = 1),
                    ),
                ),
            ),
        )
        val reply = runBlocking {
            engine.reply(
                orderId = orderId,
                message = "How much are these two?",
                attachment = com.grocerypricer.core.ai.AiImage(0L, ByteArray(4)),
                history = emptyList(),
                lastListedItemIds = emptyList(),
                provider = provider,
            )
        }
        assertTrue(reply.text, reply.text.contains("1. Ocean Spray"))
        assertTrue(reply.text, reply.text.contains("2. Mott's"))
    }

    @Test
    fun `a photo of something not on this order says so instead of guessing`() {
        val provider = FakeAiProvider().respondWithIdentification(
            AiResult.Success(
                ProductIdentification(
                    listOf(AiVisualProduct(brand = "Downy", productName = "Downy April Fresh", size = "10 oz")),
                ),
            ),
        )
        val reply = runBlocking {
            engine.reply(
                orderId = orderId,
                message = "How much is this?",
                attachment = com.grocerypricer.core.ai.AiImage(0L, ByteArray(4)),
                history = emptyList(),
                lastListedItemIds = emptyList(),
                provider = provider,
            )
        }
        assertTrue(reply.text, reply.text.contains("none of those are on this order"))
    }
}
