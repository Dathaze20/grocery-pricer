package com.grocerypricer.app.ui.order

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.grocerypricer.app.data.model.AppSettings
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.components.EmptyState
import com.grocerypricer.app.ui.components.formatDate
import kotlinx.coroutines.launch

@Composable
fun OrdersScreen(
    container: AppContainer,
    settings: AppSettings,
    onOpenOrder: (Long) -> Unit,
    onBack: () -> Unit,
) {
    val orders by container.orderRepository.observeOrders()
        .collectAsStateWithLifecycle(initialValue = emptyList())
    val scope = rememberCoroutineScope()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("All orders") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        if (orders.isEmpty()) {
            EmptyState(
                title = "No orders yet",
                message = "Start one from the home screen and photograph your wholesale receipt.",
                modifier = Modifier.padding(padding),
            )
            return@Scaffold
        }

        LazyColumn(Modifier.fillMaxSize().padding(padding)) {
            items(orders, key = { it.id }) { order ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onOpenOrder(order.id) }
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(order.name.ifBlank { order.supplier }, style = MaterialTheme.typography.titleMedium)
                        Text(
                            "${formatDate(order.orderDate)}  -  ${order.status.displayName}" +
                                if (order.id == settings.currentOrderId) "  -  current" else "",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (order.id != settings.currentOrderId) {
                        TextButton(onClick = {
                            scope.launch { container.settingsRepository.setCurrentOrder(order.id) }
                        }) { Text("MAKE CURRENT") }
                    }
                }
                HorizontalDivider()
            }
        }
    }
}
