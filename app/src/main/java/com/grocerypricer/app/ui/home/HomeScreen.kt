package com.grocerypricer.app.ui.home

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.grocerypricer.app.data.model.AppSettings
import com.grocerypricer.app.data.model.Order
import com.grocerypricer.app.data.model.OrderStatus
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.components.InfoBanner
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The V2 home screen.
 *
 * Two buttons and a list of orders. What is absent is the point: V1 led with six stat cards -
 * wholesale value, estimated retail, gross profit, average margin - which were shown before any
 * of it was true, wrapped badly on a phone, and were not what anybody opened the app to do. Those
 * figures still exist, in Order Details, where they mean something.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    container: AppContainer,
    settings: AppSettings,
    onNewOrder: () -> Unit,
    onAskCurrentOrder: (Long) -> Unit,
    onOpenOrder: (Long) -> Unit,
    onAllOrders: () -> Unit,
    onPriceHistory: () -> Unit,
    onSettings: () -> Unit,
    onAiSetup: () -> Unit,
) {
    val viewModel: HomeViewModel = viewModel(factory = HomeViewModel.factory(container))
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Grocery Pricer") },
                actions = {
                    IconButton(onClick = onPriceHistory) {
                        Icon(Icons.Default.History, contentDescription = "Price history")
                    }
                    IconButton(onClick = onSettings) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
        ) {
            if (!state.aiConfigured) {
                InfoBanner(
                    "One-time setup: add your AI key so Grocery Pricer can read receipt photos.",
                    modifier = Modifier.padding(top = 16.dp).clickable { onAiSetup() },
                )
            }

            Button(
                onClick = onNewOrder,
                modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(top = 24.dp),
            ) {
                Text("NEW ORDER", style = MaterialTheme.typography.titleMedium)
            }

            val current = state.currentOrder
            OutlinedButton(
                onClick = { current?.let { onAskCurrentOrder(it.id) } },
                enabled = current != null && current.status.isAskable,
                modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(top = 12.dp),
            ) {
                Text("ASK CURRENT ORDER", style = MaterialTheme.typography.titleMedium)
            }

            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 32.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "Recent orders",
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f),
                )
                if (state.recentOrders.size >= RECENT_LIMIT) {
                    Text(
                        "See all",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.clickable { onAllOrders() },
                    )
                }
            }

            if (state.recentOrders.isEmpty()) {
                Text(
                    "No orders yet. Tap NEW ORDER and add your receipt photos.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 16.dp),
                )
            } else {
                LazyColumn(modifier = Modifier.fillMaxWidth()) {
                    items(state.recentOrders.size) { index ->
                        val order = state.recentOrders[index]
                        RecentOrderRow(order = order, onClick = { onOpenOrder(order.id) })
                        if (index < state.recentOrders.lastIndex) HorizontalDivider()
                    }
                }
            }

            Spacer(modifier = Modifier.weight(1f))
        }
    }
}

/**
 * One order, as a row.
 *
 * A date and a supplier. The money is not here on purpose - a figure on the home screen invites
 * being read as fact before anybody has confirmed a price.
 */
@Composable
private fun RecentOrderRow(order: Order, onClick: () -> Unit) {
    val formatter = remember { SimpleDateFormat("MMM d, yyyy", Locale.getDefault()) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            formatter.format(Date(order.orderDate)) + " — " + order.supplier,
            style = MaterialTheme.typography.bodyLarge,
        )
        val status = order.status
        if (!status.isAskable) {
            Text(
                status.displayName,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private const val RECENT_LIMIT = 5
