package com.grocerypricer.app.ui.order

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.grocerypricer.app.data.model.OrderItem
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.components.BigActionButton
import com.grocerypricer.app.ui.components.LabelledValue
import com.grocerypricer.app.ui.components.MoneyField
import com.grocerypricer.app.ui.components.PlainTextField
import com.grocerypricer.app.ui.components.SectionCard
import com.grocerypricer.app.ui.components.WarningBanner
import com.grocerypricer.app.ui.components.WholeNumberField
import com.grocerypricer.core.model.Category
import com.grocerypricer.core.model.DiscountScope
import com.grocerypricer.core.model.ItemConfidence
import com.grocerypricer.core.model.PricingRules
import com.grocerypricer.core.model.ReceiptDiscount
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.pricing.CostCalculator
import com.grocerypricer.core.pricing.PricingEngine
import kotlinx.coroutines.launch

/**
 * Entering a product by hand.
 *
 * The app has to stay usable when OCR fails completely, or when something was bought that never
 * made it onto the receipt.
 */
@Composable
fun ManualItemScreen(
    container: AppContainer,
    orderId: Long,
    onSaved: () -> Unit,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var rules by remember { mutableStateOf(PricingRules()) }
    LaunchedEffect(Unit) { rules = container.pricingRulesRepository.current() }

    var description by remember { mutableStateOf("") }
    var upc by remember { mutableStateOf("") }
    var size by remember { mutableStateOf("") }
    var casePrice by remember { mutableStateOf("") }
    var unitsPerCase by remember { mutableStateOf("1") }
    var casesPurchased by remember { mutableStateOf("1") }
    var discountAmount by remember { mutableStateOf("") }
    var retailPrice by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }

    val parsedCasePrice = Money.parseOrNull(casePrice)
    val parsedUnits = unitsPerCase.toIntOrNull()
    val parsedCases = casesPurchased.toIntOrNull() ?: 1
    val parsedDiscount = Money.parseOrNull(discountAmount)?.takeIf { it.isPositive }

    val discount = parsedDiscount?.let {
        ReceiptDiscount("Manual discount", it, DiscountScope.WHOLE_CASE)
    }

    val cost = if (parsedCasePrice != null && parsedUnits != null && parsedUnits > 0) {
        runCatching {
            CostCalculator.calculate(parsedCasePrice, parsedUnits, parsedCases, 0, discount)
        }.getOrNull()
    } else {
        null
    }

    val category = remember(description) { Category.guessFrom(description) }
    val suggestion = cost?.let {
        PricingEngine(rules).suggest(it.trueUnitCost.takeIf { c -> c.isPositive }, category)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Add product manually") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
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
                    PlainTextField("UPC", upc, { upc = it })
                    PlainTextField("Size", size, { size = it })
                    Text(
                        "Category: ${category.displayName}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            SectionCard("Cost") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    MoneyField("Case price", casePrice, { casePrice = it }, isError = casePrice.isNotBlank() && parsedCasePrice == null)
                    WholeNumberField("Units per case", unitsPerCase, { unitsPerCase = it })
                    WholeNumberField("Cases purchased", casesPurchased, { casesPurchased = it })
                    MoneyField("Discount (off one case)", discountAmount, { discountAmount = it })
                }
            }

            if (cost == null) {
                WarningBanner("Enter a case price and how many units are in a case.")
            } else {
                SectionCard("Calculated") {
                    Column {
                        LabelledValue("Net case cost", cost.netCaseCost.format())
                        HorizontalDivider(Modifier.padding(vertical = 8.dp))
                        LabelledValue("UNIT COST", cost.displayUnitCost.format(), emphasise = true)
                        LabelledValue("Retail pieces", cost.totalUnits.toString())
                        suggestion?.let {
                            LabelledValue("Suggested retail", it.suggestedPrice.format())
                        }
                    }
                }
            }

            SectionCard("Retail price") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    MoneyField("Store price", retailPrice, { retailPrice = it })
                    suggestion?.let {
                        Text(
                            "Leave blank to use the suggested ${it.suggestedPrice.format()}.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            BigActionButton(
                "ADD TO ORDER",
                enabled = cost != null && description.isNotBlank() && !saving,
                onClick = {
                    val breakdown = cost ?: return@BigActionButton
                    saving = true
                    scope.launch {
                        val approved = Money.parseOrNull(retailPrice) ?: suggestion?.suggestedPrice
                        container.orderRepository.addManualItem(
                            orderId = orderId,
                            item = OrderItem(
                                orderId = orderId,
                                description = description.trim(),
                                upc = upc.trim().takeIf { it.isNotEmpty() },
                                size = size.trim().takeIf { it.isNotEmpty() },
                                category = category,
                                casePrice = breakdown.casePrice,
                                unitsPerCase = breakdown.unitsPerCase,
                                casesPurchased = breakdown.casesPurchased,
                                looseUnits = 0,
                                discount = discount,
                                cost = breakdown,
                                suggestedPrice = suggestion?.suggestedPrice,
                                approvedPrice = approved,
                                priceApproved = approved != null,
                                confidence = ItemConfidence.HIGH,
                                reviewApproved = true,
                                rawText = "Entered manually",
                            ),
                            rules = rules,
                        )
                        onSaved()
                    }
                },
            )
            Spacer(Modifier.height(32.dp))
        }
    }
}
