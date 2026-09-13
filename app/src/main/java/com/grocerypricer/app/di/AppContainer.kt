package com.grocerypricer.app.di

import android.content.Context
import com.grocerypricer.app.ai.AnthropicAiProvider
import com.grocerypricer.app.ai.SecureKeyStore
import com.grocerypricer.app.backup.BackupManager
import com.grocerypricer.app.chat.ChatRepository
import com.grocerypricer.app.chat.ConversationEngine
import com.grocerypricer.app.processing.OrderProcessor
import com.grocerypricer.core.ai.AiProvider
import com.grocerypricer.app.data.db.GroceryPricerDatabase
import com.grocerypricer.app.data.files.ImageStore
import com.grocerypricer.app.data.repository.OrderRepository
import com.grocerypricer.app.data.repository.PricingRulesRepository
import com.grocerypricer.app.data.repository.ProductRepository
import com.grocerypricer.app.data.settings.SettingsRepository
import com.grocerypricer.app.ocr.ReceiptTextRecognizer

/**
 * Hand-rolled service locator.
 *
 * The app has one process, one database and a handful of repositories, so a dependency-injection
 * framework would add build complexity without buying anything here. Everything is constructed
 * lazily and lives for the life of the process.
 */
class AppContainer(context: Context) {

    private val appContext = context.applicationContext

    val database: GroceryPricerDatabase by lazy { GroceryPricerDatabase.get(appContext) }

    val settingsRepository: SettingsRepository by lazy { SettingsRepository(appContext) }

    val imageStore: ImageStore by lazy { ImageStore(appContext) }

    val textRecognizer: ReceiptTextRecognizer by lazy { ReceiptTextRecognizer(appContext) }

    val productRepository: ProductRepository by lazy {
        ProductRepository(
            productDao = database.productDao(),
            priceHistoryDao = database.priceHistoryDao(),
            scanHistoryDao = database.scanHistoryDao(),
        )
    }

    val orderRepository: OrderRepository by lazy {
        OrderRepository(database = database, productRepository = productRepository)
    }

    val pricingRulesRepository: PricingRulesRepository by lazy {
        PricingRulesRepository(
            pricingRuleDao = database.pricingRuleDao(),
            settingsRepository = settingsRepository,
        )
    }

    val secureKeyStore: SecureKeyStore by lazy { SecureKeyStore(appContext) }

    val chatRepository: ChatRepository by lazy { ChatRepository(database) }

    val conversationEngine: ConversationEngine by lazy {
        ConversationEngine(
            orderRepository = orderRepository,
            productRepository = productRepository,
        )
    }

    val orderProcessor: OrderProcessor by lazy {
        OrderProcessor(
            orderRepository = orderRepository,
            pricingRulesRepository = pricingRulesRepository,
            imageStore = imageStore,
            textRecognizer = textRecognizer,
        )
    }

    /**
     * The configured AI provider, or null when no key has been entered yet.
     *
     * Built fresh each time rather than cached: the model is a setting the user can change, and a
     * cached provider would keep talking to the old one until the process restarted. Null is a
     * first-class answer here - every caller has an offline path, because a shop with no signal
     * still needs to look up what it paid.
     */
    suspend fun aiProviderOrNull(): AiProvider? {
        if (!secureKeyStore.hasApiKey()) return null
        val settings = settingsRepository.current()
        return AnthropicAiProvider(keyStore = secureKeyStore, modelId = settings.aiModel)
    }

    val backupManager: BackupManager by lazy {
        BackupManager(
            database = database,
            settingsRepository = settingsRepository,
            imageStore = imageStore,
        )
    }
}
