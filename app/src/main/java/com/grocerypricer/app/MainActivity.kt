package com.grocerypricer.app

import android.content.Intent
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
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {

    /**
     * The order an "order ready" notification asked for, waiting to be navigated to.
     *
     * A flow rather than a value read once in [onCreate], because this Activity is `singleTop`:
     * when the app is already running, tapping a notification does not create a new Activity, it
     * delivers the Intent to [onNewIntent] on the existing one. Reading the Intent only at
     * creation time means the notification does nothing at all in the most common case - the
     * shopkeeper still has the app open, having just pressed PROCESS ORDER.
     */
    private val notificationOrderId = MutableStateFlow<Long?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        notificationOrderId.value = OrderProcessingWorker.orderIdFrom(intent)

        setContent {
            val container = rememberAppContainer()
            val settings by container.settingsRepository.settings
                .collectAsStateWithLifecycle(initialValue = AppSettings())
            val pendingOrderId by notificationOrderId.collectAsStateWithLifecycle()

            GroceryPricerTheme(themeMode = settings.themeMode) {
                Surface(
                    modifier = Modifier,
                    color = MaterialTheme.colorScheme.background,
                ) {
                    GroceryPricerNavHost(
                        container = container,
                        settings = settings,
                        notificationOrderId = pendingOrderId,
                        // Consumed once it has been navigated to, so a recomposition cannot
                        // send the user back to the same order over and over.
                        onNotificationHandled = { notificationOrderId.value = null },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Without this, getIntent() keeps returning the Intent that first created the Activity.
        setIntent(intent)
        OrderProcessingWorker.orderIdFrom(intent)?.let { notificationOrderId.value = it }
    }
}

@Composable
fun rememberAppContainer(): AppContainer {
    val context = LocalContext.current
    return (context.applicationContext as GroceryPricerApplication).container
}
