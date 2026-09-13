package com.grocerypricer.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.grocerypricer.app.data.model.AppSettings
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.processing.OrderProcessingWorker
import com.grocerypricer.app.ui.navigation.GroceryPricerNavHost
import com.grocerypricer.app.ui.theme.GroceryPricerTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A notification saying an order is ready should land on that order, not on the
        // home screen with the shopkeeper having to find it again.
        val openOrderId = intent?.getLongExtra(OrderProcessingWorker.EXTRA_ORDER_ID, 0L)
            ?.takeIf { it > 0L }

        setContent {
            val container = rememberAppContainer()
            val settings by container.settingsRepository.settings
                .collectAsStateWithLifecycle(initialValue = AppSettings())

            GroceryPricerTheme(themeMode = settings.themeMode) {
                Surface(
                    modifier = Modifier,
                    color = MaterialTheme.colorScheme.background,
                ) {
                    GroceryPricerNavHost(
                        container = container,
                        settings = settings,
                        openOrderId = openOrderId,
                    )
                }
            }
        }
    }
}

@Composable
fun rememberAppContainer(): AppContainer {
    val context = LocalContext.current
    return (context.applicationContext as GroceryPricerApplication).container
}
