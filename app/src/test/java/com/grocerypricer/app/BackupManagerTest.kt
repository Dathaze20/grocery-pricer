package com.grocerypricer.app

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.grocerypricer.app.backup.BackupManager
import com.grocerypricer.app.backup.RestoreResult
import com.grocerypricer.app.data.db.GroceryPricerDatabase
import com.grocerypricer.app.data.db.entity.PriceHistoryEntity
import com.grocerypricer.app.data.db.toDomain
import com.grocerypricer.app.data.db.toEntity
import com.grocerypricer.app.data.files.ImageStore
import com.grocerypricer.app.data.settings.SettingsRepository
import com.grocerypricer.core.model.DiscountScope
import com.grocerypricer.core.money.Money
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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
class BackupManagerTest {

    private lateinit var database: GroceryPricerDatabase
    private lateinit var backupManager: BackupManager

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        database = Room.inMemoryDatabaseBuilder(context, GroceryPricerDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        backupManager = BackupManager(
            database = database,
            settingsRepository = SettingsRepository(context),
            imageStore = ImageStore(context),
        )
    }

    @After
    fun tearDown() {
        database.close()
    }

    private suspend fun seed(): Long {
        val orderId = database.orderDao().insert(TestFactories.order(id = 0L).toEntity())
        val productId = database.productDao().insert(TestFactories.product(id = 0L).toEntity(1L, 1L))
        database.orderItemDao().insert(
            TestFactories.mayonnaise(id = 0L, orderId = orderId).copy(productId = productId).toEntity(1L, 1L)
        )
        database.priceHistoryDao().insert(
            PriceHistoryEntity(
                productId = productId,
                orderId = orderId,
                unitCostRaw = Money.of("2.1658").toStorageLong(),
                retailPriceRaw = Money.of("4.99").toStorageLong(),
                recordedAt = 1_756_944_000_000L,
            )
        )
        return orderId
    }

    @Test
    fun `a backup carries its format and version`() = runBlocking {
        seed()
        val json = JSONObject(backupManager.createBackup(includeImages = false))

        assertEquals(BackupManager.FORMAT, json.getString("format"))
        assertEquals(BackupManager.VERSION, json.getInt("version"))
        assertEquals(1, json.getJSONArray("products").length())
        assertEquals(1, json.getJSONArray("orders").length())
        assertEquals(1, json.getJSONArray("orderItems").length())
        assertEquals(1, json.getJSONArray("priceHistory").length())
    }

    @Test
    fun `a backup restores every table and its money`() = runBlocking {
        seed()
        val backup = backupManager.createBackup(includeImages = false)

        database.orderItemDao().deleteAll()
        database.priceHistoryDao().deleteAll()
        database.orderDao().deleteAll()
        database.productDao().deleteAll()
        assertTrue(database.productDao().getAll().isEmpty())

        val result = backupManager.restore(backup)

        assertTrue(result is RestoreResult.Success)
        result as RestoreResult.Success
        assertEquals(1, result.products)
        assertEquals(1, result.orders)
        assertEquals(1, result.orderItems)
        assertEquals(1, result.priceHistory)

        val product = database.productDao().getAll().single().toDomain()
        assertEquals(Money.of("2.1658"), product.lastUnitCost)
        assertEquals(Money.of("4.99"), product.lastRetailPrice)

        val item = database.orderItemDao().getAll().single().toDomain()
        assertEquals(Money.of("33.99"), item.casePrice)
        assertEquals(12, item.unitsPerCase)
        assertEquals(DiscountScope.WHOLE_CASE, item.discount?.scope)
        assertEquals("$2.17", item.displayUnitCost.format())
    }

    @Test
    fun `a file that is not a backup is refused instead of wiping the database`() = runBlocking {
        seed()
        val result = backupManager.restore("""{"hello":"world"}""")

        assertTrue(result is RestoreResult.Failure)
        assertEquals(1, database.productDao().getAll().size)
    }

    @Test
    fun `unreadable text is refused`() = runBlocking {
        val result = backupManager.restore("not json at all")
        assertTrue(result is RestoreResult.Failure)
    }

    @Test
    fun `a backup from a newer format version is refused with an explanation`() = runBlocking {
        val future = JSONObject()
            .put("format", BackupManager.FORMAT)
            .put("version", BackupManager.VERSION + 5)
            .toString()

        val result = backupManager.restore(future)

        assertTrue(result is RestoreResult.Failure)
        assertTrue((result as RestoreResult.Failure).message.contains("newer version"))
    }

    @Test
    fun `a backup of an empty database restores cleanly instead of failing`() = runBlocking {
        val backup = backupManager.createBackup(includeImages = false)

        val result = backupManager.restore(backup)

        assertTrue(result is RestoreResult.Success)
        result as RestoreResult.Success
        assertEquals(0, result.products)
        assertEquals(0, result.orders)
        assertTrue(database.productDao().getAll().isEmpty())
    }

    @Test
    fun `restoring over an existing catalogue replaces it rather than merging duplicates`() = runBlocking {
        seed()
        val backup = backupManager.createBackup(includeImages = false)

        // The same backup restored twice must not leave two copies of every product.
        backupManager.restore(backup)
        backupManager.restore(backup)

        assertEquals(1, database.productDao().getAll().size)
        assertEquals(1, database.orderDao().getAll().size)
        assertEquals(1, database.orderItemDao().getAll().size)
        assertEquals(1, database.priceHistoryDao().getAll().size)
    }

    @Test
    fun `restoring an empty backup over real data is still a deliberate, complete replacement`() = runBlocking {
        val emptyBackup = backupManager.createBackup(includeImages = false)
        seed()
        assertEquals(1, database.productDao().getAll().size)

        val result = backupManager.restore(emptyBackup)

        // Destructive by design - the screen warns first - but it must be all or nothing,
        // never a half-applied mixture of the backup and what was there before.
        assertTrue(result is RestoreResult.Success)
        assertTrue(database.productDao().getAll().isEmpty())
        assertTrue(database.orderItemDao().getAll().isEmpty())
    }

    @Test
    fun `a backup with no format version is refused rather than guessed at`() = runBlocking {
        seed()
        val noVersion = JSONObject().put("format", BackupManager.FORMAT).toString()

        val result = backupManager.restore(noVersion)

        assertTrue(result is RestoreResult.Failure)
        assertTrue((result as RestoreResult.Failure).message.contains("version"))
        assertEquals(1, database.productDao().getAll().size)
    }

    @Test
    fun `a truncated backup does not wipe the database on the way to failing`() = runBlocking {
        seed()
        val truncated = backupManager.createBackup(includeImages = false).take(200)

        val result = backupManager.restore(truncated)

        assertTrue(result is RestoreResult.Failure)
        assertEquals(1, database.productDao().getAll().size)
        assertEquals(1, database.orderItemDao().getAll().size)
    }

    @Test
    fun `settings are carried in the backup`() = runBlocking {
        val json = JSONObject(backupManager.createBackup(includeImages = false))
        val settings = json.getJSONObject("settings")
        assertNotNull(settings)
        assertTrue(settings.has("priceEndingCents"))
        assertTrue(settings.has("themeMode"))
    }
}
