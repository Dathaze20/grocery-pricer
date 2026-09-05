package com.grocerypricer.app.ui.order

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.grocerypricer.app.data.model.OrderItem
import com.grocerypricer.app.ui.components.BigActionButton
import com.grocerypricer.app.ui.components.LabelledValue
import com.grocerypricer.app.ui.components.MoneyField
import com.grocerypricer.app.ui.components.PlainTextField
import com.grocerypricer.app.ui.components.SectionCard
import com.grocerypricer.app.ui.components.WarningBanner
import com.grocerypricer.app.ui.components.WholeNumberField
import com.grocerypricer.core.model.Category
import com.grocerypricer.core.model.DiscountScope
import com.grocerypricer.core.model.ReceiptDiscount
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.pricing.CostCalculator

/** The scopes a person can choose from. `UNKNOWN` is the parser's state, never a user's answer. */
private val SELECTABLE_SCOPES = listOf(
    DiscountScope.WHOLE_CASE,
    DiscountScope.PER_UNIT,
    DiscountScope.UNITS_SUBSET,
    DiscountScope.CUSTOM,
    DiscountScope.IGNORED,
)

/**
 * Full-screen editor for one receipt row.
 *
 * Every figure recomputes as it is typed, so the true cost per unit is visible before the change
 * is saved - the point of the review step is that the user sees the number they are agreeing to.
 */
@Composable
fun EditItemDialog(
    item: OrderItem,
    onSave: (OrderItem) -> Unit,
    onDismiss: () -> Unit,
) {
    var description by remember { mutableStateOf(item.description) }
    var upc by remember { mutableStateOf(item.upc.orEmpty()) }
    var size by remember { mutableStateOf(item.size.orEmpty()) }
    var casePrice by remember { mutableStateOf(item.casePrice.toPlainString()) }
    var unitsPerCase by remember { mutableStateOf(item.unitsPerCase.toString()) }
    var casesPurchased by remember { mutableStateOf(item.casesPurchased.toString()) }
    var looseUnits by remember { mutableStateOf(item.looseUnits.toString()) }
    var printedUnitCost by remember { mutableStateOf(item.printedUnitCost?.toPlainString().orEmpty()) }
    var discountAmount by remember { mutableStateOf(item.discount?.amount?.toPlainString().orEmpty()) }
    var discountDescription by remember { mutableStateOf(item.discount?.description.orEmpty()) }
    var discountScope by remember {
        mutableStateOf(
            item.discount?.scope?.takeIf { it != DiscountScope.UNKNOWN } ?: DiscountScope.WHOLE_CASE
        )
    }
    var discountUnits by remember { mutableStateOf(item.discount?.appliesToUnits?.toString().orEmpty()) }
    var category by remember { mutableStateOf(item.category) }
    var categoryMenuOpen by remember { mutableStateOf(false) }

    val parsedCasePrice = Money.parseOrNull(casePrice)
    val parsedUnits = unitsPerCase.toIntOrNull()
    val parsedCases = casesPurchased.toIntOrNull() ?: 0
    val parsedLoose = looseUnits.toIntOrNull() ?: 0
    val parsedDiscount = Money.parseOrNull(discountAmount)

    val discount = parsedDiscount?.takeIf { it.isPositive }?.let {
        ReceiptDiscount(
            description = discountDescription.ifBlank { "Discount" },
            amount = it,
            scope = discountScope,
            appliesToUnits = discountUnits.toIntOrNull(),
        )
    }

    val preview = if (parsedCasePrice != null && parsedUnits != null && parsedUnits > 0) {
        runCatching {
            CostCalculator.calculate(
                casePrice = parsedCasePrice,
                unitsPerCase = parsedUnits,
                casesPurchased = parsedCases,
                looseUnits = parsedLoose,
                discount = discount,
            )
        }.getOrNull()
    } else {
        null
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Scaffold(
                topBar = {
                    TopAppBar(
                        title = { Text("Edit item") },
                        navigationIcon = {
                            IconButton(onClick = onDismiss) {
                                Icon(Icons.Default.Close, contentDescription = "Close")
                            }
                        },
                    )
                },
            ) { padding ->
                Column(
                    Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .padding(16.dp)
                        .verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    SectionCard("Product") {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            PlainTextField("Product name", description, { description = it })
                            PlainTextField("UPC / item number", upc, { upc = it })
                            PlainTextField("Size", size, { size = it })
                            Box {
                                OutlinedButton(
                                    onClick = { categoryMenuOpen = true },
                                    modifier = Modifier.fillMaxWidth(),
                                ) { Text("Category: ${category.displayName}") }
                                DropdownMenu(
                                    expanded = categoryMenuOpen,
                                    onDismissRequest = { categoryMenuOpen = false },
                                ) {
                                    Category.entries.forEach { option ->
                                        DropdownMenuItem(
                                            text = { Text(option.displayName) },
                                            onClick = {
                                                category = option
                                                categoryMenuOpen = false
                                            },
                                        )
                                    }
                                }
                            }
                        }
                    }

                    SectionCard("Case") {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            MoneyField("Case price", casePrice, { casePrice = it }, isError = parsedCasePrice == null)
                            WholeNumberField(
                                "Units per case",
                                unitsPerCase,
                                { unitsPerCase = it },
                                isError = parsedUnits == null || parsedUnits <= 0,
                            )
                            WholeNumberField("Cases purchased", casesPurchased, { casesPurchased = it })
                            WholeNumberField("Loose units purchased", looseUnits, { looseUnits = it })
                            MoneyField(
                                "Printed unit cost (from the receipt)",
                                printedUnitCost,
                                { printedUnitCost = it },
                                supportingText = "Optional. Used only to cross-check the case price.",
                            )
                        }
                    }

                    SectionCard("Discount") {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            MoneyField("Discount amount", discountAmount, { discountAmount = it })
                            PlainTextField("Discount description", discountDescription, { discountDescription = it })
                            if (parsedDiscount != null && parsedDiscount.isPositive) {
                                Text("How does this discount apply?", style = MaterialTheme.typography.titleMedium)
                                SELECTABLE_SCOPES.forEach { scope ->
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .selectable(
                                                selected = discountScope == scope,
                                                onClick = { discountScope = scope },
                                            )
                                            .padding(vertical = 4.dp),
                                    ) {
                                        RadioButton(
                                            selected = discountScope == scope,
                                            onClick = { discountScope = scope },
                                        )
                                        Column {
                                            Text(scope.displayName, style = MaterialTheme.typography.bodyLarge)
                                            Text(
                                                scope.explanation,
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                    }
                                }
                                if (discountScope == DiscountScope.UNITS_SUBSET) {
                                    WholeNumberField(
                                        "Number of units the discount applies to",
                                        discountUnits,
                                        { discountUnits = it },
                                    )
                                }
                            }
                        }
                    }

                    if (preview == null) {
                        WarningBanner("Enter a case price and a units-per-case count to see the true unit cost.")
                    } else {
                        SectionCard("What this comes to") {
                            Column {
                                LabelledValue("Case price", preview.casePrice.format())
                                LabelledValue("Units per case", preview.unitsPerCase.toString())
                                LabelledValue("Discount off one case", preview.discountPerCase.format())
                                LabelledValue("Net case cost", preview.netCaseCost.format())
                                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                                LabelledValue(
                                    "TRUE COST EACH",
                                    preview.displayUnitCost.format(),
                                    emphasise = true,
                                )
                                LabelledValue("Retail pieces on the shelf", preview.totalUnits.toString())
                                LabelledValue("Total wholesale cost", preview.totalWholesaleCost.format())
                            }
                        }
                    }

                    BigActionButton(
                        "SAVE ITEM",
                        enabled = preview != null && description.isNotBlank(),
                        onClick = {
                            val cost = preview ?: return@BigActionButton
                            onSave(
                                item.copy(
                                    description = description.trim(),
                                    upc = upc.trim().takeIf { it.isNotEmpty() },
                                    size = size.trim().takeIf { it.isNotEmpty() },
                                    category = category,
                                    casePrice = cost.casePrice,
                                    unitsPerCase = cost.unitsPerCase,
                                    casesPurchased = cost.casesPurchased,
                                    looseUnits = cost.looseUnits,
                                    printedUnitCost = Money.parseOrNull(printedUnitCost),
                                    discount = discount,
                                    cost = cost,
                                    // The user has now looked at every number on this row.
                                    issues = emptyList(),
                                    confidence = com.grocerypricer.core.model.ItemConfidence.HIGH,
                                    reviewApproved = true,
                                )
                            )
                            onDismiss()
                        },
                    )
                    Spacer(Modifier.height(32.dp))
                }
            }
        }
    }
}
