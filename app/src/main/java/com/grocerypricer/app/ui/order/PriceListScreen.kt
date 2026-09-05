package com.grocerypricer.app.ui.order

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Sort
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.components.EmptyState

/** The compact "what am I putting on the shelf today" list. */
@Composable
fun PriceListScreen(
    container: AppContainer,
    orderId: Long,
    onBack: () -> Unit,
) {
    val viewModel: OrderViewModel = viewModel(factory = OrderViewModel.factory(container, orderId))
    val state by viewModel.state.collectAsStateWithLifecycle()
    val sort by viewModel.sort.collectAsStateWithLifecycle()
    var sortMenuOpen by remember { mutableStateOf(false) }

    val items = remember(state.items, sort) { viewModel.sortedItems(state.items, sort) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Today's price list") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    Box {
                        IconButton(onClick = { sortMenuOpen = true }) {
                            Icon(Icons.Default.Sort, contentDescription = "Sort")
                        }
                        DropdownMenu(expanded = sortMenuOpen, onDismissRequest = { sortMenuOpen = false }) {
                            PriceListSort.entries.forEach { option ->
                                DropdownMenuItem(
                                    text = { Text(option.displayName) },
                                    onClick = {
                                        viewModel.setSort(option)
                                        sortMenuOpen = false
                                    },
                                )
                            }
                        }
                    }
                },
            )
        },
    ) { padding ->
        if (items.isEmpty()) {
            EmptyState(
                title = "No products on this order",
                message = "Import a receipt or add products by hand first.",
                modifier = Modifier.padding(padding),
            )
            return@Scaffold
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            items(items, key = { it.id }) { item ->
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            item.displayName,
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            "${item.category.displayName}  -  cost ${item.displayUnitCost.format()}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Text(
                        item.effectivePrice?.format() ?: "NEEDS PRICE",
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                        color = if (item.priceApproved) {
                            MaterialTheme.colorScheme.onSurface
                        } else {
                            MaterialTheme.colorScheme.error
                        },
                    )
                }
                HorizontalDivider()
            }
        }
    }
}
