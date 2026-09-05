package com.grocerypricer.app.ui.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Backup
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.ReceiptLong
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.grocerypricer.app.data.model.AppSettings
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.components.BigActionButton
import com.grocerypricer.app.ui.components.InfoBanner
import com.grocerypricer.app.ui.components.SecondaryActionButton
import com.grocerypricer.app.ui.components.StatCard
import com.grocerypricer.core.pricing.ProfitCalculator

@Composable
fun HomeScreen(
    container: AppContainer,
    settings: AppSettings,
    onNewOrder: () -> Unit,
    onOpenCurrentOrder: (Long) -> Unit,
    onScanProduct: (Long) -> Unit,
    onCatalog: () -> Unit,
    onPriceHistory: () -> Unit,
    onPricingRules: () -> Unit,
    onBackup: () -> Unit,
    onSettings: () -> Unit,
    onOrders: () -> Unit,
) {
    val viewModel: HomeViewModel = viewModel(factory = HomeViewModel.factory(container))
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Grocery Pricer", style = MaterialTheme.typography.titleLarge)
                        if (settings.storeName.isNotBlank()) {
                            Text(
                                settings.storeName,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Spacer(Modifier.height(4.dp)) }

            val order = state.currentOrder
            if (order == null) {
                item {
                    InfoBanner(
                        "No orders yet. Start with NEW ORDER and photograph your wholesale receipt.",
                    )
                }
            } else {
                item {
                    Text(
                        order.name.ifBlank { order.supplier },
                        style = MaterialTheme.typography.titleMedium,
                    )
                }
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        StatCard(
                            label = "Products in this order",
                            value = state.summary.productCount.toString(),
                            modifier = Modifier.weight(1f),
                        )
                        StatCard(
                            label = "Still need prices",
                            value = state.summary.unpricedCount.toString(),
                            modifier = Modifier.weight(1f),
                            highlight = state.summary.unpricedCount > 0,
                        )
                    }
                }
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        StatCard(
                            label = "Already priced",
                            value = state.summary.pricedCount.toString(),
                            modifier = Modifier.weight(1f),
                        )
                        StatCard(
                            label = "Wholesale cost",
                            value = state.summary.wholesaleTotal.format(),
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        StatCard(
                            label = "Estimated retail",
                            value = state.summary.estimatedRetailTotal.format(),
                            modifier = Modifier.weight(1f),
                        )
                        StatCard(
                            label = "Estimated gross profit",
                            value = state.summary.estimatedGrossProfit.format() +
                                "  " + ProfitCalculator.formatPercent(state.summary.averageGrossMarginPercent),
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }

            item { Spacer(Modifier.height(8.dp)) }

            item {
                BigActionButton("NEW ORDER", onNewOrder, icon = Icons.Default.ReceiptLong)
            }
            item {
                BigActionButton(
                    "CURRENT ORDER",
                    onClick = { order?.let { onOpenCurrentOrder(it.id) } },
                    icon = Icons.Default.Inventory2,
                    enabled = order != null,
                )
            }
            item {
                BigActionButton(
                    "SCAN PRODUCT",
                    onClick = { onScanProduct(order?.id ?: 0L) },
                    icon = Icons.Default.QrCodeScanner,
                )
            }
            item { SecondaryActionButton("PRODUCT CATALOG (${state.productCount})", onCatalog, icon = Icons.Default.Inventory2) }
            item { SecondaryActionButton("PRICE HISTORY", onPriceHistory, icon = Icons.Default.History) }
            item { SecondaryActionButton("PRICING RULES", onPricingRules, icon = Icons.Default.Tune) }
            item { SecondaryActionButton("BACKUP / RESTORE", onBackup, icon = Icons.Default.Backup) }
            item { SecondaryActionButton("ALL ORDERS", onOrders, icon = Icons.Default.PhotoCamera) }
            item { SecondaryActionButton("SETTINGS", onSettings, icon = Icons.Default.Settings) }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}
