package com.grocerypricer.app.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.grocerypricer.app.data.model.AppSettings
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.catalog.CatalogScreen
import com.grocerypricer.app.ui.chat.OrderChatScreen
import com.grocerypricer.app.ui.chat.ProcessingScreen
import com.grocerypricer.app.ui.chat.ProcessingViewModel
import com.grocerypricer.app.ui.settings.AiSetupScreen
import com.grocerypricer.app.ui.catalog.PriceHistoryScreen
import com.grocerypricer.app.ui.catalog.ProductDetailScreen
import com.grocerypricer.app.ui.home.HomeScreen
import com.grocerypricer.app.ui.onboarding.TutorialScreen
import com.grocerypricer.app.ui.order.ManualItemScreen
import com.grocerypricer.app.ui.order.NewOrderScreen
import com.grocerypricer.app.ui.order.OrderSummaryScreen
import com.grocerypricer.app.ui.order.OrdersScreen
import com.grocerypricer.app.ui.order.PriceListScreen
import com.grocerypricer.app.ui.order.ReceiptImportScreen
import com.grocerypricer.app.ui.order.ReviewScreen
import com.grocerypricer.app.ui.rules.PricingRulesScreen
import com.grocerypricer.app.ui.scan.ScanScreen
import com.grocerypricer.app.ui.settings.BackupScreen
import com.grocerypricer.app.ui.settings.SettingsScreen
import kotlinx.coroutines.launch

@Composable
fun GroceryPricerNavHost(
    container: AppContainer,
    settings: AppSettings,
) {
    val navController = rememberNavController()
    val scope = rememberCoroutineScope()

    NavHost(
        navController = navController,
        startDestination = if (settings.tutorialCompleted) Routes.HOME else Routes.TUTORIAL,
    ) {
        composable(Routes.TUTORIAL) {
            TutorialScreen(
                onFinished = {
                    scope.launch { container.settingsRepository.markTutorialCompleted() }
                    navController.navigate(Routes.HOME) {
                        popUpTo(Routes.TUTORIAL) { inclusive = true }
                    }
                },
            )
        }

        composable(Routes.HOME) {
            HomeScreen(
                container = container,
                settings = settings,
                onNewOrder = { navController.navigate(Routes.NEW_ORDER) },
                onAskCurrentOrder = { navController.navigate(Routes.chat(it)) },
                onOpenOrder = { navController.navigate(Routes.chat(it)) },
                onAllOrders = { navController.navigate(Routes.ORDERS) },
                onPriceHistory = { navController.navigate(Routes.HISTORY) },
                onSettings = { navController.navigate(Routes.SETTINGS) },
                onAiSetup = { navController.navigate(Routes.AI_SETUP) },
            )
        }

        composable(Routes.NEW_ORDER) {
            NewOrderScreen(
                container = container,
                settings = settings,
                onCreated = { orderId ->
                    navController.navigate(Routes.receipts(orderId)) {
                        popUpTo(Routes.NEW_ORDER) { inclusive = true }
                    }
                },
                onBack = { navController.popBackStack() },
            )
        }

        composable(Routes.ORDERS) {
            OrdersScreen(
                container = container,
                settings = settings,
                onOpenOrder = { navController.navigate(Routes.chat(it)) },
                onBack = { navController.popBackStack() },
            )
        }

        composable(
            route = Routes.RECEIPTS,
            arguments = listOf(navArgument(Routes.ARG_ORDER_ID) { type = NavType.LongType }),
        ) { entry ->
            val orderId = entry.arguments?.getLong(Routes.ARG_ORDER_ID) ?: 0L
            ReceiptImportScreen(
                container = container,
                orderId = orderId,
                onProcess = { navController.navigate(Routes.processing(it)) },
                onBack = { navController.popBackStack() },
            )
        }

        composable(
            route = Routes.PROCESSING,
            arguments = listOf(navArgument(Routes.ARG_ORDER_ID) { type = NavType.LongType }),
        ) { entry ->
            val orderId = entry.arguments?.getLong(Routes.ARG_ORDER_ID) ?: 0L
            val processingViewModel: ProcessingViewModel =
                viewModel(factory = ProcessingViewModel.factory(container, orderId))
            val processingState by processingViewModel.state.collectAsStateWithLifecycle()

            // The user pressed one button; they should not have to press another to see the
            // result. As soon as the order is readable, the conversation replaces this screen.
            LaunchedEffect(processingState.finished) {
                if (processingState.finished) {
                    scope.launch { container.settingsRepository.setCurrentOrder(orderId) }
                    navController.navigate(Routes.chat(orderId)) {
                        popUpTo(Routes.PROCESSING) { inclusive = true }
                    }
                }
            }

            ProcessingScreen(
                stage = processingState.stage,
                failureMessage = processingState.failureMessage,
                onRetry = processingViewModel::start,
                onUseLocalReader = processingViewModel::useLocalReader,
                onCheckPhotos = { navController.navigate(Routes.receipts(orderId)) },
                onBack = { navController.popBackStack() },
            )
        }

        composable(
            route = Routes.CHAT,
            arguments = listOf(navArgument(Routes.ARG_ORDER_ID) { type = NavType.LongType }),
        ) { entry ->
            val orderId = entry.arguments?.getLong(Routes.ARG_ORDER_ID) ?: 0L
            OrderChatScreen(
                container = container,
                orderId = orderId,
                onBack = { navController.popBackStack() },
                onOrderDetails = { navController.navigate(Routes.orderSummary(it)) },
                onCheckReceiptData = { navController.navigate(Routes.review(it)) },
                onReceiptPhotos = { navController.navigate(Routes.receipts(it)) },
                onScan = { navController.navigate(Routes.scan(it, false)) },
                onAiSetup = { navController.navigate(Routes.AI_SETUP) },
            )
        }

        composable(Routes.AI_SETUP) {
            AiSetupScreen(
                container = container,
                onBack = { navController.popBackStack() },
            )
        }

        composable(
            route = Routes.REVIEW,
            arguments = listOf(navArgument(Routes.ARG_ORDER_ID) { type = NavType.LongType }),
        ) { entry ->
            val orderId = entry.arguments?.getLong(Routes.ARG_ORDER_ID) ?: 0L
            ReviewScreen(
                container = container,
                orderId = orderId,
                onSaved = { navController.navigate(Routes.orderSummary(it)) },
                onAddManualItem = { navController.navigate(Routes.manualItem(it)) },
                onBack = { navController.popBackStack() },
            )
        }

        composable(
            route = Routes.MANUAL_ITEM,
            arguments = listOf(navArgument(Routes.ARG_ORDER_ID) { type = NavType.LongType }),
        ) { entry ->
            val orderId = entry.arguments?.getLong(Routes.ARG_ORDER_ID) ?: 0L
            ManualItemScreen(
                container = container,
                orderId = orderId,
                onSaved = { navController.popBackStack() },
                onBack = { navController.popBackStack() },
            )
        }

        composable(
            route = Routes.ORDER_SUMMARY,
            arguments = listOf(navArgument(Routes.ARG_ORDER_ID) { type = NavType.LongType }),
        ) { entry ->
            val orderId = entry.arguments?.getLong(Routes.ARG_ORDER_ID) ?: 0L
            OrderSummaryScreen(
                container = container,
                orderId = orderId,
                onPriceProducts = { navController.navigate(Routes.scan(it, true)) },
                onPriceList = { navController.navigate(Routes.priceList(it)) },
                onReview = { navController.navigate(Routes.review(it)) },
                onReceipts = { navController.navigate(Routes.receipts(it)) },
                onDeleted = {
                    navController.navigate(Routes.HOME) { popUpTo(Routes.HOME) { inclusive = true } }
                },
                onBack = { navController.popBackStack() },
            )
        }

        composable(
            route = Routes.PRICE_LIST,
            arguments = listOf(navArgument(Routes.ARG_ORDER_ID) { type = NavType.LongType }),
        ) { entry ->
            val orderId = entry.arguments?.getLong(Routes.ARG_ORDER_ID) ?: 0L
            PriceListScreen(
                container = container,
                orderId = orderId,
                onBack = { navController.popBackStack() },
            )
        }

        composable(
            route = Routes.SCAN,
            arguments = listOf(
                navArgument(Routes.ARG_ORDER_ID) { type = NavType.LongType },
                navArgument(Routes.ARG_CAMERA_MODE) { type = NavType.BoolType },
            ),
        ) { entry ->
            val orderId = entry.arguments?.getLong(Routes.ARG_ORDER_ID) ?: 0L
            val cameraMode = entry.arguments?.getBoolean(Routes.ARG_CAMERA_MODE) ?: false
            ScanScreen(
                container = container,
                settings = settings,
                orderId = orderId,
                startInCameraMode = cameraMode,
                onBack = { navController.popBackStack() },
            )
        }

        composable(Routes.CATALOG) {
            CatalogScreen(
                container = container,
                onOpenProduct = { navController.navigate(Routes.product(it)) },
                onBack = { navController.popBackStack() },
            )
        }

        composable(
            route = Routes.PRODUCT,
            arguments = listOf(navArgument(Routes.ARG_PRODUCT_ID) { type = NavType.LongType }),
        ) { entry ->
            val productId = entry.arguments?.getLong(Routes.ARG_PRODUCT_ID) ?: 0L
            ProductDetailScreen(
                container = container,
                productId = productId,
                onBack = { navController.popBackStack() },
            )
        }

        composable(Routes.HISTORY) {
            PriceHistoryScreen(
                container = container,
                onOpenProduct = { navController.navigate(Routes.product(it)) },
                onBack = { navController.popBackStack() },
            )
        }

        composable(Routes.RULES) {
            PricingRulesScreen(
                container = container,
                onBack = { navController.popBackStack() },
            )
        }

        composable(Routes.SETTINGS) {
            SettingsScreen(
                container = container,
                settings = settings,
                onPricingRules = { navController.navigate(Routes.RULES) },
                onBack = { navController.popBackStack() },
            )
        }

        composable(Routes.BACKUP) {
            BackupScreen(
                container = container,
                settings = settings,
                onBack = { navController.popBackStack() },
            )
        }
    }
}
