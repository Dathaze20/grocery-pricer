package com.grocerypricer.app.ui.order

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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.grocerypricer.app.data.model.OrderItem
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.components.BigActionButton
import com.grocerypricer.app.ui.components.ConfidenceChip
import com.grocerypricer.app.ui.components.ConfirmDialog
import com.grocerypricer.app.ui.components.EmptyState
import com.grocerypricer.app.ui.components.InfoBanner
import com.grocerypricer.app.ui.components.LabelledValue
import com.grocerypricer.app.ui.components.SecondaryActionButton
import com.grocerypricer.core.model.ItemConfidence

/**
 * The gate between OCR and the database.
 *
 * One card per product with every figure the receipt gave and the true cost derived from them.
 * Rows with warnings cannot be bulk-approved: they have to be opened and looked at.
 */
@Composable
fun ReviewScreen(
    container: AppContainer,
    orderId: Long,
    onSaved: (Long) -> Unit,
    onAddManualItem: (Long) -> Unit,
    onBack: () -> Unit,
) {
    val viewModel: ReviewViewModel = viewModel(factory = ReviewViewModel.factory(container, orderId))
    val state by viewModel.state.collectAsStateWithLifecycle()
    val order by viewModel.order.collectAsStateWithLifecycle()

    var editing by remember { mutableStateOf<OrderItem?>(null) }
    var deleting by remember { mutableStateOf<OrderItem?>(null) }

    val approvedCount = state.items.count { it.reviewApproved }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Review order") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = { onAddManualItem(orderId) }) {
                        Icon(Icons.Default.Add, contentDescription = "Add product manually")
                    }
                },
            )
        },
    ) { padding ->
        if (state.items.isEmpty()) {
            EmptyState(
                title = "Nothing to review yet",
                message = "No products were read from the receipt photos. Add another photo, or enter the items by hand.",
                actionLabel = "ADD PRODUCT MANUALLY",
                onAction = { onAddManualItem(orderId) },
                modifier = Modifier.padding(padding),
            )
            return@Scaffold
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Spacer(Modifier.height(4.dp)) }

            item {
                Text(
                    order?.name.orEmpty(),
                    style = MaterialTheme.typography.titleMedium,
                )
            }

            item {
                InfoBanner(
                    "$approvedCount of ${state.items.size} approved. " +
                        "${state.summary.uncertainCount} row(s) need a look before they can be saved.",
                )
            }

            state.message?.let { message ->
                item { InfoBanner(message) }
            }

            item {
                SecondaryActionButton(
                    "APPROVE ALL HIGH-CONFIDENCE ITEMS",
                    onClick = { viewModel.approveAllHighConfidence() },
                )
            }

            items(state.items, key = { it.id }) { item ->
                ReviewItemCard(
                    item = item,
                    onEdit = { editing = item },
                    onToggleApprove = { viewModel.setApproved(item, !item.reviewApproved) },
                    onDelete = { deleting = item },
                )
            }

            item { Spacer(Modifier.height(8.dp)) }

            item {
                BigActionButton(
                    "SAVE ORDER ($approvedCount item(s))",
                    enabled = approvedCount > 0 && !state.busy,
                    onClick = { viewModel.saveOrder { onSaved(orderId) } },
                )
            }
            item {
                Text(
                    "Only approved rows are saved. Anything still flagged stays here until you resolve it.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item { Spacer(Modifier.height(32.dp)) }
        }
    }

    editing?.let { item ->
        EditItemDialog(
            item = item,
            onSave = { updated -> viewModel.saveItem(updated) },
            onDismiss = { editing = null },
        )
    }

    deleting?.let { item ->
        ConfirmDialog(
            title = "Remove this item?",
            message = "\"${item.description}\" will be removed from this order. This cannot be undone.",
            confirmLabel = "Remove",
            destructive = true,
            onConfirm = { viewModel.deleteItem(item) },
            onDismiss = { deleting = null },
        )
    }
}

@Composable
private fun ReviewItemCard(
    item: OrderItem,
    onEdit: () -> Unit,
    onToggleApprove: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (item.reviewApproved) {
                MaterialTheme.colorScheme.primaryContainer
            } else {
                MaterialTheme.colorScheme.surface
            },
        ),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(
                item.description.ifBlank { "Unnamed product" },
                style = MaterialTheme.typography.titleLarge,
            )
            item.size?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.height(8.dp))
            ConfidenceChip(item.confidence)

            if (item.issues.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                item.issues.forEach { issue ->
                    Text(
                        "- ${issue.message}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }

            Spacer(Modifier.height(12.dp))
            LabelledValue("Case Price", item.casePrice.format())
            LabelledValue("Units", item.unitsPerCase.toString())
            item.printedUnitCost?.let { LabelledValue("Printed Cost", it.format()) }
            item.discount?.let { discount ->
                LabelledValue("Discount", "-" + discount.amount.format())
                LabelledValue("Applies as", discount.scope.displayName)
            }
            if (item.casesPurchased != 1) {
                LabelledValue("Cases purchased", item.casesPurchased.toString())
            }
            if (item.looseUnits > 0) {
                LabelledValue("Loose units", item.looseUnits.toString())
            }
            LabelledValue("Net Case Cost", item.cost.netCaseCost.format())
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            LabelledValue("TRUE COST EACH", item.displayUnitCost.format(), emphasise = true)
            item.suggestedPrice?.let { LabelledValue("Suggested retail", it.format()) }

            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                OutlinedButton(onClick = onEdit, modifier = Modifier.weight(1f)) { Text("EDIT") }
                Button(
                    onClick = onToggleApprove,
                    enabled = item.confidence != ItemConfidence.PROBLEM || item.reviewApproved,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(if (item.reviewApproved) "APPROVED" else "APPROVE")
                }
            }
            if (item.confidence == ItemConfidence.PROBLEM && !item.reviewApproved) {
                Text(
                    "Fix the flagged values with EDIT before this row can be approved.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            TextButton(onClick = onDelete) { Text("Remove from order") }
        }
    }
}
