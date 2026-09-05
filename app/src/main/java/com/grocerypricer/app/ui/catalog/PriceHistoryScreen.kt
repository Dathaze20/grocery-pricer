package com.grocerypricer.app.ui.catalog

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.components.EmptyState
import com.grocerypricer.app.ui.components.formatDate

/** Every cost and price movement across the whole catalogue, newest first. */
@Composable
fun PriceHistoryScreen(
    container: AppContainer,
    onOpenProduct: (Long) -> Unit,
    onBack: () -> Unit,
) {
    val viewModel: CatalogViewModel = viewModel(factory = CatalogViewModel.factory(container))
    val history by viewModel.recentHistory.collectAsStateWithLifecycle()
    val products by viewModel.products.collectAsStateWithLifecycle()
    val namesById = products.associate { it.id to it.displayName }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Price history") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        if (history.isEmpty()) {
            EmptyState(
                title = "No price history yet",
                message = "History is recorded each time you save an order and each time you approve a shelf price.",
                modifier = Modifier.padding(padding),
            )
            return@Scaffold
        }

        LazyColumn(Modifier.fillMaxSize().padding(padding)) {
            items(history, key = { it.id }) { entry ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onOpenProduct(entry.productId) }
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                ) {
                    Text(
                        namesById[entry.productId] ?: "Product #${entry.productId}",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        "${formatDate(entry.recordedAt)}   Cost ${entry.unitCost.roundedToCents().format()}   " +
                            "Retail ${entry.retailPrice?.format() ?: "-"}",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                HorizontalDivider()
            }
        }
    }
}
