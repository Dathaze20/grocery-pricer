package com.grocerypricer.app.ui.catalog

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Download
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.components.EmptyState
import com.grocerypricer.app.ui.components.InfoBanner
import com.grocerypricer.app.ui.components.PlainTextField
import kotlinx.coroutines.launch

@Composable
fun CatalogScreen(
    container: AppContainer,
    onOpenProduct: (Long) -> Unit,
    onBack: () -> Unit,
) {
    val viewModel: CatalogViewModel = viewModel(factory = CatalogViewModel.factory(container))
    val products by viewModel.products.collectAsStateWithLifecycle()
    val term by viewModel.searchTerm.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var pendingCsv by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }

    val createCsv = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("text/csv"),
    ) { uri ->
        val content = pendingCsv
        pendingCsv = null
        if (uri != null && content != null) {
            message = runCatching {
                context.contentResolver.openOutputStream(uri)?.use { it.write(content.toByteArray()) }
                "Catalog exported."
            }.getOrElse { "Could not write the file: ${it.message}" }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Product catalog") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = {
                        scope.launch {
                            val result = viewModel.buildCatalogCsv()
                            pendingCsv = result.second
                            createCsv.launch(result.first)
                        }
                    }) {
                        Icon(Icons.Default.Download, contentDescription = "Export catalog as CSV")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            Column(Modifier.padding(horizontal = 16.dp)) {
                Spacer(Modifier.height(8.dp))
                PlainTextField("Search", term, { viewModel.setSearchTerm(it) })
                message?.let {
                    Spacer(Modifier.height(8.dp))
                    InfoBanner(it)
                }
                Spacer(Modifier.height(8.dp))
            }

            if (products.isEmpty()) {
                EmptyState(
                    title = if (term.isBlank()) "No products yet" else "Nothing matched \"$term\"",
                    message = if (term.isBlank()) {
                        "Products appear here once you import a receipt and save the order."
                    } else {
                        "Try a shorter search - a brand name, or part of a size."
                    },
                )
                return@Column
            }

            LazyColumn(Modifier.fillMaxSize()) {
                items(products, key = { it.id }) { product ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable { onOpenProduct(product.id) }
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(product.displayName, style = MaterialTheme.typography.titleMedium)
                            Text(
                                "${product.category.displayName}  -  cost ${product.lastUnitCost?.roundedToCents()?.format() ?: "-"}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Text(
                            product.lastRetailPrice?.format() ?: "-",
                            style = MaterialTheme.typography.titleLarge,
                        )
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}
