package com.grocerypricer.app.ui.catalog

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
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
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.components.BigActionButton
import com.grocerypricer.app.ui.components.ConfirmDialog
import com.grocerypricer.app.ui.components.EmptyState
import com.grocerypricer.app.ui.components.LabelledValue
import com.grocerypricer.app.ui.components.MoneyField
import com.grocerypricer.app.ui.components.SecondaryActionButton
import com.grocerypricer.app.ui.components.SectionCard
import com.grocerypricer.app.ui.components.WholeNumberField
import com.grocerypricer.app.ui.components.formatDate
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.pricing.ProfitCalculator

/** One product: what it costs, what it sells for, and everything it has ever cost. */
@Composable
fun ProductDetailScreen(
    container: AppContainer,
    productId: Long,
    onBack: () -> Unit,
) {
    val viewModel: CatalogViewModel = viewModel(factory = CatalogViewModel.factory(container))
    val product by viewModel.observeProduct(productId).collectAsStateWithLifecycle(initialValue = null)
    val history by viewModel.observeHistory(productId).collectAsStateWithLifecycle(initialValue = emptyList())

    var overrideText by remember { mutableStateOf("") }
    var adjustmentText by remember { mutableStateOf("") }
    var confirmDelete by remember { mutableStateOf(false) }
    var loadedFor by remember { mutableStateOf(0L) }

    LaunchedEffect(product?.id) {
        val current = product
        if (current != null && loadedFor != current.id) {
            overrideText = current.overridePrice?.toPlainString().orEmpty()
            adjustmentText = current.quantityAdjustment.toString()
            loadedFor = current.id
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(product?.name ?: "Product") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        val current = product
        if (current == null) {
            EmptyState(
                title = "Product not found",
                message = "It may have been deleted.",
                modifier = Modifier.padding(padding),
            )
            return@Scaffold
        }

        LazyColumn(
            Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Spacer(Modifier.height(4.dp)) }

            item {
                SectionCard("Details") {
                    Column {
                        LabelledValue("Size", current.size ?: "-")
                        LabelledValue("Category", current.category.displayName)
                        LabelledValue("UPC", current.upc ?: "-")
                        LabelledValue("Supplier item number", current.supplierSku ?: "-")
                        LabelledValue("Last supplier", current.lastSupplier ?: "-")
                        LabelledValue("Last purchased", formatDate(current.lastPurchasedAt))
                        LabelledValue("Received", current.quantityReceived.toString())
                        LabelledValue("On hand (after adjustment)", current.quantityOnHand.toString())
                    }
                }
            }

            item {
                SectionCard("Pricing") {
                    Column {
                        LabelledValue("Last wholesale cost", current.lastUnitCost?.roundedToCents()?.format() ?: "-")
                        LabelledValue("Store price", current.lastRetailPrice?.format() ?: "-", emphasise = true)
                        val cost = current.lastUnitCost
                        val price = current.lastRetailPrice
                        if (cost != null && price != null) {
                            LabelledValue("Gross profit", (price - cost).format())
                            LabelledValue("Gross margin", ProfitCalculator.formatPercent(ProfitCalculator.grossMarginPercent(cost, price)))
                            LabelledValue("Markup", ProfitCalculator.formatPercent(ProfitCalculator.markupPercent(cost, price)))
                        }
                    }
                }
            }

            item {
                SectionCard("Fixed price for this product") {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        MoneyField(
                            "Fixed price",
                            overrideText,
                            { overrideText = it },
                            supportingText = "Overrides every pricing rule. Leave blank to use the rules.",
                        )
                        SecondaryActionButton("SAVE FIXED PRICE", onClick = {
                            viewModel.setOverridePrice(current.id, Money.parseOrNull(overrideText))
                        })
                    }
                }
            }

            item {
                SectionCard("Inventory adjustment") {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        WholeNumberField("Adjustment", adjustmentText, { adjustmentText = it })
                        SecondaryActionButton("SAVE ADJUSTMENT", onClick = {
                            viewModel.setQuantityAdjustment(current.id, adjustmentText.toIntOrNull() ?: 0)
                        })
                    }
                }
            }

            item { Text("Price history", style = MaterialTheme.typography.titleLarge) }

            if (history.isEmpty()) {
                item {
                    Text(
                        "No history yet. It builds up as you buy this product again.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            items(history, key = { it.id }) { entry ->
                Column {
                    LabelledValue(
                        formatDate(entry.recordedAt),
                        "Cost ${entry.unitCost.roundedToCents().format()}   Retail ${entry.retailPrice?.format() ?: "-"}",
                    )
                    entry.note?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    HorizontalDivider()
                }
            }

            item { Spacer(Modifier.height(8.dp)) }
            item {
                BigActionButton("DELETE PRODUCT", { confirmDelete = true })
            }
            item { Spacer(Modifier.height(32.dp)) }
        }
    }

    if (confirmDelete) {
        val current = product
        ConfirmDialog(
            title = "Delete this product?",
            message = "The product and its price history will be removed. Past orders keep the figures they were saved with.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = { current?.let { viewModel.deleteProduct(it, onBack) } },
            onDismiss = { confirmDelete = false },
        )
    }
}
