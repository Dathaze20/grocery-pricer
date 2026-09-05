package com.grocerypricer.app.ui.order

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.components.BigActionButton
import com.grocerypricer.app.ui.components.ConfirmDialog
import com.grocerypricer.app.ui.components.InfoBanner
import com.grocerypricer.app.ui.components.LabelledValue
import com.grocerypricer.app.ui.components.SecondaryActionButton
import com.grocerypricer.app.ui.components.SectionCard
import com.grocerypricer.app.ui.components.StatCard
import com.grocerypricer.app.ui.components.formatDate
import com.grocerypricer.core.model.ItemConfidence
import com.grocerypricer.core.pricing.ProfitCalculator
import kotlinx.coroutines.launch

@Composable
fun OrderSummaryScreen(
    container: AppContainer,
    orderId: Long,
    onPriceProducts: (Long) -> Unit,
    onPriceList: (Long) -> Unit,
    onReview: (Long) -> Unit,
    onReceipts: (Long) -> Unit,
    onDeleted: () -> Unit,
    onBack: () -> Unit,
) {
    val viewModel: OrderViewModel = viewModel(factory = OrderViewModel.factory(container, orderId))
    val state by viewModel.state.collectAsStateWithLifecycle()
    val movements by viewModel.costMovements.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var pendingCsv by remember { mutableStateOf<String?>(null) }
    var exportMessage by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }

    val createCsv = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("text/csv"),
    ) { uri ->
        val content = pendingCsv
        pendingCsv = null
        if (uri != null && content != null) {
            exportMessage = runCatching {
                context.contentResolver.openOutputStream(uri)?.use { it.write(content.toByteArray()) }
                "Order exported."
            }.getOrElse { "Could not write the file: ${it.message}" }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.order?.name ?: "Order") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
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

            state.order?.let { order ->
                item {
                    Text(
                        "${order.supplier} - ${formatDate(order.orderDate)} - ${order.status.displayName}",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            item {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    StatCard("Products", state.summary.productCount.toString(), Modifier.weight(1f))
                    StatCard("Cases", state.summary.casesPurchased.toString(), Modifier.weight(1f))
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    StatCard("Wholesale total", state.summary.wholesaleTotal.format(), Modifier.weight(1f))
                    StatCard("Retail value", state.summary.estimatedRetailTotal.format(), Modifier.weight(1f))
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    StatCard("Gross profit", state.summary.estimatedGrossProfit.format(), Modifier.weight(1f))
                    StatCard(
                        "Average margin",
                        ProfitCalculator.formatPercent(state.summary.averageGrossMarginPercent),
                        Modifier.weight(1f),
                    )
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    StatCard(
                        "Still unpriced",
                        state.summary.unpricedCount.toString(),
                        Modifier.weight(1f),
                        highlight = state.summary.unpricedCount > 0,
                    )
                    StatCard(
                        "Low margin",
                        state.summary.lowMarginCount.toString(),
                        Modifier.weight(1f),
                        highlight = state.summary.lowMarginCount > 0,
                    )
                }
            }

            exportMessage?.let { item { InfoBanner(it) } }

            item {
                BigActionButton(
                    "PRICE PRODUCTS",
                    icon = Icons.Default.QrCodeScanner,
                    onClick = { onPriceProducts(orderId) },
                )
            }
            item { SecondaryActionButton("TODAY'S PRICE LIST", { onPriceList(orderId) }) }
            item { SecondaryActionButton("BACK TO REVIEW", { onReview(orderId) }) }
            item { SecondaryActionButton("RECEIPT PHOTOS", { onReceipts(orderId) }) }
            item {
                SecondaryActionButton(
                    "EXPORT ORDER AS CSV",
                    icon = Icons.Default.Download,
                    onClick = {
                        scope.launch {
                            val result = viewModel.buildCsv()
                            if (result == null) {
                                exportMessage = "There is nothing to export yet."
                            } else {
                                pendingCsv = result.second
                                createCsv.launch(result.first)
                            }
                        }
                    },
                )
            }

            if (movements.isNotEmpty()) {
                item {
                    SectionCard("Biggest wholesale cost changes") {
                        Column {
                            movements.take(10).forEach { movement ->
                                LabelledValue(
                                    movement.item.description,
                                    "${movement.previousCost.format()} -> ${movement.item.displayUnitCost.format()}  " +
                                        ProfitCalculator.formatSignedPercent(movement.changePercent),
                                )
                            }
                        }
                    }
                }
            }

            val uncertain = state.items.filter { it.confidence != ItemConfidence.HIGH }
            if (uncertain.isNotEmpty()) {
                item {
                    SectionCard("Products with uncertain OCR (${uncertain.size})") {
                        Column {
                            uncertain.take(20).forEach { item ->
                                LabelledValue(item.description, item.confidence.displayName)
                            }
                        }
                    }
                }
            }

            item { Spacer(Modifier.height(8.dp)) }
            item {
                Card(Modifier) {
                    Column(Modifier.padding(16.dp)) {
                        Text("Danger zone", style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(8.dp))
                        SecondaryActionButton("DELETE THIS ORDER", { confirmDelete = true })
                    }
                }
            }
            item { Spacer(Modifier.height(32.dp)) }
        }
    }

    if (confirmDelete) {
        ConfirmDialog(
            title = "Delete this order?",
            message = "The order, its items and its receipt photos will be removed. " +
                "Products already saved to the catalog and their price history are kept.",
            confirmLabel = "Delete order",
            destructive = true,
            onConfirm = { viewModel.deleteOrder(onDeleted) },
            onDismiss = { confirmDelete = false },
        )
    }
}
