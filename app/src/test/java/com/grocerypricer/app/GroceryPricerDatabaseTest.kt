package com.grocerypricer.app

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.grocerypricer.app.data.db.GroceryPricerDatabase
import com.grocerypricer.app.data.db.entity.PriceHistoryEntity
import com.grocerypricer.app.data.db.toDomain
import com.grocerypricer.app.data.db.toEntity
import com.grocerypricer.app.data.repository.OrderRepository
import com.grocerypricer.app.data.repository.ProductRepository
import com.grocerypricer.core.model.DiscountScope
import com.grocerypricer.core.model.PricingRules
import com.grocerypricer.core.money.Money
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
// The stock Application: GroceryPricerApplication.onCreate opens the real database
// and seeds pricing rules, which a unit test must not do.
@Config(sdk = [34], application = android.app.Application::class)
class GroceryPricerDatabaseTest {

    private lateinit var database: GroceryPricerDatabase
    private lateinit var productRepository: ProductRepository
    private lateinit var orderRepository: OrderRepository

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            GroceryPricerDatabase::class.java,
        ).allowMainThreadQueries().build()

        productRepository = ProductRepository(
            productDao = database.productDao(),
            priceHistoryDao = database.priceHistoryDao(),
            scanHistoryDao = database.scanHistoryDao(),
        )
        orderRepository = OrderRepository(database, productRepository)
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun `an order item survives a save and load with its money intact`() = runBlocking {
        val orderId = orderRepository.createOrder("Jetro / Restaurant Depot", "Test order", 1_756_944_000_000L)
        val item = TestFactories.mayonnaise(id = 0L, orderId = orderId)
        val itemId = database.orderItemDao().insert(item.toEntity(0L, 0L))

        val loaded = database.orderItemDao().getById(itemId)?.toDomain()

        assertNotNull(loaded)
        assertEquals(Money.of("33.99"), loaded!!.casePrice)
        assertEquals(12, loaded.unitsPerCase)
        assertEquals(Money.of("8.00"), loaded.discount?.amount)
        assertEquals(DiscountScope.WHOLE_CASE, loaded.discount?.scope)
        // The figure that matters: recomputed from the stored inputs, not read back from a total.
        assertEquals("$2.17", loaded.displayUnitCost.format())
        assertEquals(Money.of("25.99"), loaded.cost.netCaseCost)
    }

    @Test
    fun `saving an order creates products and price history`() = runBlocking {
        val orderId = orderRepository.createOrder("Jetro / Restaurant Depot", "Test order", 1_756_944_000_000L)
        database.orderItemDao().insert(TestFactories.mayonnaise(id = 0L, orderId = orderId).toEntity(0L, 0L))
        database.orderItemDao().insert(TestFactories.frootLoops(id = 0L, orderId = orderId).toEntity(0L, 0L))

        val saved = orderRepository.commitOrder(orderId)

        assertEquals(2, saved)
        val products = productRepository.getAll()
        assertEquals(2, products.size)

        val mayo = products.first { it.name.contains("MAYONNAISE") }
        assertEquals("$2.17", mayo.lastUnitCost!!.roundedToCents().format())
        assertEquals(Money.of("4.99"), mayo.lastRetailPrice)
        assertEquals(12, mayo.quantityReceived)

        val history = database.priceHistoryDao().getAll()
        assertEquals(2, history.size)
    }

    @Test
    fun `a barcode finds the product it was saved with`() = runBlocking {
        val orderId = orderRepository.createOrder("Jetro / Restaurant Depot", "Test order", 1_756_944_000_000L)
        database.orderItemDao().insert(TestFactories.mayonnaise(id = 0L, orderId = orderId).toEntity(0L, 0L))
        orderRepository.commitOrder(orderId)

        // The same product scans as a 13-digit EAN on some phones.
        val outcome = productRepository.findByBarcode("0048001215252")
        assertTrue(outcome is com.grocerypricer.core.matching.MatchOutcome.Confident)
    }

    @Test
    fun `approving a price updates the item, the product and the history entry`() = runBlocking {
        val orderId = orderRepository.createOrder("Jetro / Restaurant Depot", "Test order", 1_756_944_000_000L)
        val itemId = database.orderItemDao().insert(
            TestFactories.mayonnaise(id = 0L, orderId = orderId, retail = null).toEntity(0L, 0L)
        )
        orderRepository.commitOrder(orderId)

        orderRepository.approvePrice(itemId, Money.of("5.99"))

        val item = orderRepository.getItem(itemId)!!
        assertEquals(Money.of("5.99"), item.approvedPrice)
        assertTrue(item.priceApproved)

        val product = productRepository.getById(item.productId!!)!!
        assertEquals(Money.of("5.99"), product.lastRetailPrice)

        val history = database.priceHistoryDao().getAll().single()
        assertEquals(Money.of("5.99").toStorageLong(), history.retailPriceRaw)
    }

    @Test
    fun `deleting an order takes its items with it but leaves the catalog alone`() = runBlocking {
        val orderId = orderRepository.createOrder("Jetro / Restaurant Depot", "Test order", 1_756_944_000_000L)
        database.orderItemDao().insert(TestFactories.mayonnaise(id = 0L, orderId = orderId).toEntity(0L, 0L))
        orderRepository.commitOrder(orderId)

        orderRepository.deleteOrder(orderId)

        assertTrue(database.orderItemDao().getByOrder(orderId).isEmpty())
        assertNull(orderRepository.getOrder(orderId))
        assertEquals(1, productRepository.getAll().size)
        assertEquals(1, database.priceHistoryDao().getAll().size)
    }

    @Test
    fun `only approved rows are written to the catalog`() = runBlocking {
        val orderId = orderRepository.createOrder("Jetro / Restaurant Depot", "Test order", 1_756_944_000_000L)
        database.orderItemDao().insert(
            TestFactories.mayonnaise(id = 0L, orderId = orderId).copy(reviewApproved = false).toEntity(0L, 0L)
        )
        database.orderItemDao().insert(TestFactories.frootLoops(id = 0L, orderId = orderId).toEntity(0L, 0L))

        val saved = orderRepository.commitOrder(orderId)

        assertEquals(1, saved)
        assertEquals(1, productRepository.getAll().size)
    }

    @Test
    fun `bulk approval only touches high-confidence rows`() = runBlocking {
        val orderId = orderRepository.createOrder("Jetro / Restaurant Depot", "Test order", 1_756_944_000_000L)
        database.orderItemDao().insert(
            TestFactories.mayonnaise(id = 0L, orderId = orderId).copy(reviewApproved = false).toEntity(0L, 0L)
        )
        database.orderItemDao().insert(
            TestFactories.frootLoops(id = 0L, orderId = orderId)
                .copy(
                    reviewApproved = false,
                    confidence = com.grocerypricer.core.model.ItemConfidence.NEEDS_REVIEW,
                )
                .toEntity(0L, 0L)
        )

        val approved = orderRepository.approveAllHighConfidence(orderId)

        assertEquals(1, approved)
        assertEquals(1, orderRepository.getItems(orderId).count { it.reviewApproved })
    }

    @Test
    fun `price history is append-only across repeat purchases`() = runBlocking {
        val productId = productRepository.insert(TestFactories.product(id = 0L))
        productRepository.recordPriceHistory(
            com.grocerypricer.app.data.model.PriceHistoryEntry(
                productId = productId,
                unitCost = Money.of("2.17"),
                retailPrice = Money.of("4.99"),
                recordedAt = 1_000L,
            )
        )
        productRepository.recordPriceHistory(
            com.grocerypricer.app.data.model.PriceHistoryEntry(
                productId = productId,
                unitCost = Money.of("2.39"),
                retailPrice = Money.of("4.99"),
                recordedAt = 2_000L,
            )
        )

        val history = productRepository.observePriceHistory(productId).first()
        assertEquals(2, history.size)
        assertEquals(Money.of("2.39"), history.first().unitCost)
        assertEquals(Money.of("2.17"), productRepository.previousCost(productId, before = 1_500L))
    }

    @Test
    fun `the order summary adds up cost, retail and margin`() = runBlocking {
        val orderId = orderRepository.createOrder("Jetro / Restaurant Depot", "Test order", 1_756_944_000_000L)
        database.orderItemDao().insert(TestFactories.mayonnaise(id = 0L, orderId = orderId).toEntity(0L, 0L))
        database.orderItemDao().insert(TestFactories.frootLoops(id = 0L, orderId = orderId).toEntity(0L, 0L))

        val summary = orderRepository.summarise(orderRepository.getItems(orderId), PricingRules())

        assertEquals(2, summary.productCount)
        assertEquals(22, summary.totalUnits)
        // 25.99 + 45.59
        assertEquals(Money.of("71.58"), summary.wholesaleTotal)
        // (12 x 4.99) + (10 x 7.99)
        assertEquals(Money.of("139.78"), summary.estimatedRetailTotal)
        assertEquals(Money.of("68.20"), summary.estimatedGrossProfit)
    }

    @Test
    fun `an unknown barcode does not match anything`() = runBlocking {
        val outcome = productRepository.findByBarcode("999999999999")
        assertEquals(com.grocerypricer.core.matching.MatchOutcome.NoMatch, outcome)
    }

    @Test
    fun `pricing rule rows round trip through the database`() = runBlocking {
        database.pricingRuleDao().insertAll(
            listOf(
                com.grocerypricer.app.data.db.entity.PricingRuleEntity(
                    kind = "TIER",
                    minCostRaw = Money.of("0.00").toStorageLong(),
                    maxCostRaw = Money.of("1.24").toStorageLong(),
                    suggestedPriceRaw = Money.of("2.99").toStorageLong(),
                    sortOrder = 0,
                )
            )
        )
        val rows = database.pricingRuleDao().getAll()
        assertEquals(1, rows.size)
        assertEquals(Money.of("2.99"), Money.fromStorageLong(rows.single().suggestedPriceRaw!!))
    }

    @Test
    fun `deleting a product removes its price history`() = runBlocking {
        val productId = productRepository.insert(TestFactories.product(id = 0L))
        database.priceHistoryDao().insert(
            PriceHistoryEntity(
                productId = productId,
                unitCostRaw = Money.of("2.17").toStorageLong(),
                recordedAt = 1_000L,
            )
        )

        productRepository.delete(productRepository.getById(productId)!!)

        assertTrue(database.priceHistoryDao().getAll().isEmpty())
    }
}
