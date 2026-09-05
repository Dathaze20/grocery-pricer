package com.grocerypricer.app.ui.rules

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.components.ConfirmDialog
import com.grocerypricer.app.ui.components.InfoBanner
import com.grocerypricer.app.ui.components.LabelledValue
import com.grocerypricer.app.ui.components.MoneyField
import com.grocerypricer.app.ui.components.PlainTextField
import com.grocerypricer.app.ui.components.SecondaryActionButton
import com.grocerypricer.app.ui.components.SectionCard
import com.grocerypricer.app.ui.components.WholeNumberField
import com.grocerypricer.core.model.Category
import com.grocerypricer.core.model.CategoryPricingRule
import com.grocerypricer.core.model.CostTier
import com.grocerypricer.core.model.PriceEnding
import com.grocerypricer.core.money.Money

/**
 * The store's own pricing rules. Every default the app ships with can be changed here.
 */
@Composable
fun PricingRulesScreen(
    container: AppContainer,
    onBack: () -> Unit,
) {
    val viewModel: PricingRulesViewModel = viewModel(factory = PricingRulesViewModel.factory(container))
    val rules by viewModel.rules.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val message by viewModel.message.collectAsStateWithLifecycle()

    var editingTier by remember { mutableStateOf<Pair<Int, CostTier>?>(null) }
    var editingCategory by remember { mutableStateOf<Category?>(null) }
    var confirmReset by remember { mutableStateOf(false) }

    var highCostMarkup by remember(settings.highCostMarkupPercent) { mutableStateOf(settings.highCostMarkupPercent) }
    var minimumMargin by remember(settings.minimumGrossMarginPercent) { mutableStateOf(settings.minimumGrossMarginPercent) }
    var costChangeAlert by remember(settings.costChangeAlertPercent) { mutableStateOf(settings.costChangeAlertPercent) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Pricing rules") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = {
                        editingTier = rules.tiers.size to CostTier(Money.ZERO, Money.ZERO, Money.ZERO)
                    }) {
                        Icon(Icons.Default.Add, contentDescription = "Add cost tier")
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Spacer(Modifier.height(4.dp)) }
            message?.let { item { InfoBanner(it) } }

            item {
                Text(
                    "A product's price comes from its own fixed price first, then its previous shelf price, " +
                        "then a category rule, then this cost ladder.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            item { Text("Cost tiers", style = MaterialTheme.typography.titleLarge) }

            itemsIndexed(rules.tiers) { index, tier ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Text(
                            "Cost ${tier.minCost.format()} - ${tier.maxCost.format()}",
                            style = MaterialTheme.typography.titleMedium,
                        )
                        LabelledValue("Suggested retail", tier.suggestedPrice.format(), emphasise = true)
                        tier.alternatePrice?.let { LabelledValue("Second choice", it.format()) }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = { editingTier = index to tier }) { Text("EDIT") }
                            TextButton(onClick = { viewModel.deleteTier(index) }) { Text("REMOVE") }
                        }
                    }
                }
            }

            item {
                SectionCard("Price ending") {
                    Column {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            PriceEnding.PRESETS.forEach { ending ->
                                FilterChip(
                                    selected = settings.priceEndingCents == ending.cents,
                                    onClick = { viewModel.setDefaultEnding(ending) },
                                    label = { Text(ending.label) },
                                )
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "The tier decides the target price first; the ending is applied afterwards. " +
                                "Currently ${PriceEnding.fromCents(settings.priceEndingCents).label}.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            item {
                SectionCard("Thresholds") {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        PlainTextField("Markup above the top tier (%)", highCostMarkup, { highCostMarkup = it })
                        PlainTextField("Minimum gross margin (%)", minimumMargin, { minimumMargin = it })
                        PlainTextField("Alert when wholesale cost moves by (%)", costChangeAlert, { costChangeAlert = it })
                        SecondaryActionButton("SAVE THRESHOLDS", onClick = {
                            viewModel.setScalars(highCostMarkup, minimumMargin, costChangeAlert)
                        })
                    }
                }
            }

            item { Text("Category rules", style = MaterialTheme.typography.titleLarge) }
            item {
                Text(
                    "Optional. A category rule replaces the ladder for that category, or nudges it up a step.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            items(Category.entries.size) { index ->
                val category = Category.entries[index]
                val rule = rules.categoryRules[category]
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(category.displayName, style = MaterialTheme.typography.titleMedium)
                        Text(
                            when {
                                rule == null -> "Uses the cost ladder"
                                rule.markupPercent != null -> "${rule.markupPercent?.toPlainString()}% markup"
                                rule.tierSteps != 0 -> "Ladder ${if (rule.tierSteps > 0) "+" else ""}${rule.tierSteps} step(s)"
                                else -> "Custom ending"
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    TextButton(onClick = { editingCategory = category }) { Text("EDIT") }
                }
            }

            item { Spacer(Modifier.height(8.dp)) }
            item { SecondaryActionButton("RESTORE THE STARTER LADDER", onClick = { confirmReset = true }) }
            item { Spacer(Modifier.height(32.dp)) }
        }
    }

    editingTier?.let { (index, tier) ->
        TierDialog(
            tier = tier,
            onSave = { viewModel.saveTier(index, it) },
            onDismiss = { editingTier = null },
        )
    }

    editingCategory?.let { category ->
        CategoryRuleDialog(
            category = category,
            existing = rules.categoryRules[category],
            onSave = { viewModel.saveCategoryRule(it) },
            onClear = { viewModel.clearCategoryRule(category) },
            onDismiss = { editingCategory = null },
        )
    }

    if (confirmReset) {
        ConfirmDialog(
            title = "Restore the starter ladder?",
            message = "Your cost tiers will be replaced by the defaults Grocery Pricer ships with. Category rules are kept.",
            confirmLabel = "Restore",
            destructive = true,
            onConfirm = { viewModel.resetToDefaults() },
            onDismiss = { confirmReset = false },
        )
    }
}

@Composable
private fun TierDialog(
    tier: CostTier,
    onSave: (CostTier) -> Unit,
    onDismiss: () -> Unit,
) {
    var minCost by remember { mutableStateOf(tier.minCost.toPlainString()) }
    var maxCost by remember { mutableStateOf(tier.maxCost.toPlainString()) }
    var suggested by remember { mutableStateOf(tier.suggestedPrice.toPlainString()) }
    var alternate by remember { mutableStateOf(tier.alternatePrice?.toPlainString().orEmpty()) }

    val parsedMin = Money.parseOrNull(minCost)
    val parsedMax = Money.parseOrNull(maxCost)
    val parsedSuggested = Money.parseOrNull(suggested)
    val valid = parsedMin != null && parsedMax != null && parsedSuggested != null && parsedMax >= parsedMin

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Cost tier") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                MoneyField("Cost from", minCost, { minCost = it })
                MoneyField("Cost up to", maxCost, { maxCost = it })
                MoneyField("Suggested retail", suggested, { suggested = it })
                MoneyField("Second choice (optional)", alternate, { alternate = it })
            }
        },
        confirmButton = {
            TextButton(
                enabled = valid,
                onClick = {
                    if (parsedMin != null && parsedMax != null && parsedSuggested != null) {
                        onSave(
                            CostTier(
                                minCost = parsedMin,
                                maxCost = parsedMax,
                                suggestedPrice = parsedSuggested,
                                alternatePrice = Money.parseOrNull(alternate),
                            )
                        )
                    }
                    onDismiss()
                },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun CategoryRuleDialog(
    category: Category,
    existing: CategoryPricingRule?,
    onSave: (CategoryPricingRule) -> Unit,
    onClear: () -> Unit,
    onDismiss: () -> Unit,
) {
    var enabled by remember { mutableStateOf(existing?.enabled ?: true) }
    var markup by remember { mutableStateOf(existing?.markupPercent?.toPlainString().orEmpty()) }
    var steps by remember { mutableStateOf((existing?.tierSteps ?: 0).toString()) }
    var endingCents by remember { mutableStateOf(existing?.priceEnding?.cents) }
    var endingMenuOpen by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(category.displayName) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = enabled, onCheckedChange = { enabled = it })
                    Text("  Rule active", style = MaterialTheme.typography.bodyLarge)
                }
                PlainTextField("Markup on cost (%) - leave blank to use the ladder", markup, { markup = it })
                PlainTextField("Ladder steps (whole dollars, may be negative)", steps, { steps = it })
                Box {
                    OutlinedButton(onClick = { endingMenuOpen = true }, modifier = Modifier.fillMaxWidth()) {
                        Text("Price ending: " + (endingCents?.let { PriceEnding.fromCents(it).label } ?: "Use default"))
                    }
                    DropdownMenu(expanded = endingMenuOpen, onDismissRequest = { endingMenuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("Use default") },
                            onClick = { endingCents = null; endingMenuOpen = false },
                        )
                        PriceEnding.PRESETS.forEach { ending ->
                            DropdownMenuItem(
                                text = { Text(ending.label) },
                                onClick = { endingCents = ending.cents; endingMenuOpen = false },
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                onSave(
                    CategoryPricingRule(
                        category = category,
                        markupPercent = markup.trim().takeIf { it.isNotEmpty() }?.let {
                            runCatching { java.math.BigDecimal(it) }.getOrNull()
                        },
                        priceEnding = endingCents?.let { PriceEnding.fromCents(it) },
                        tierSteps = steps.trim().toIntOrNull() ?: 0,
                        enabled = enabled,
                    )
                )
                onDismiss()
            }) { Text("Save") }
        },
        dismissButton = {
            Row {
                TextButton(onClick = { onClear(); onDismiss() }) { Text("Remove") }
                TextButton(onClick = onDismiss) { Text("Cancel") }
            }
        },
    )
}
