package com.grocerypricer.app.ui.order

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.grocerypricer.app.data.model.AppSettings
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.components.BigActionButton
import com.grocerypricer.app.ui.components.PlainTextField
import com.grocerypricer.app.ui.components.SectionCard
import com.grocerypricer.app.ui.components.formatDate
import kotlinx.coroutines.launch

private val SUPPLIERS = listOf("Jetro / Restaurant Depot", "Other")

@Composable
fun NewOrderScreen(
    container: AppContainer,
    settings: AppSettings,
    onCreated: (Long) -> Unit,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var supplier by remember { mutableStateOf(settings.defaultSupplier.takeIf { it in SUPPLIERS } ?: SUPPLIERS.first()) }
    var customSupplier by remember { mutableStateOf("") }
    var orderName by remember { mutableStateOf("") }
    var orderDate by remember { mutableStateOf(System.currentTimeMillis()) }
    var showDatePicker by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }

    val resolvedSupplier = if (supplier == "Other" && customSupplier.isNotBlank()) customSupplier else supplier
    val suggestedName = "$resolvedSupplier - ${formatDate(orderDate)}"

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("New order") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            SectionCard("Supplier") {
                Column {
                    SUPPLIERS.forEach { option ->
                        androidx.compose.foundation.layout.Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .selectable(selected = supplier == option, onClick = { supplier = option })
                                .padding(vertical = 8.dp),
                        ) {
                            RadioButton(selected = supplier == option, onClick = { supplier = option })
                            Spacer(Modifier.height(0.dp))
                            Text(option, style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                    if (supplier == "Other") {
                        PlainTextField("Supplier name", customSupplier, { customSupplier = it })
                    }
                }
            }

            SectionCard("Order date") {
                Column {
                    Text(formatDate(orderDate), style = MaterialTheme.typography.headlineSmall)
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = { showDatePicker = true }) { Text("Change date") }
                }
            }

            SectionCard("Order name (optional)") {
                Column {
                    PlainTextField("Order name", orderName, { orderName = it })
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Leave blank to use \"$suggestedName\".",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            BigActionButton(
                text = "ADD RECEIPT PHOTOS",
                enabled = !creating,
                onClick = {
                    if (creating) return@BigActionButton
                    creating = true
                    scope.launch {
                        val id = container.orderRepository.createOrder(
                            supplier = resolvedSupplier,
                            name = orderName.ifBlank { suggestedName },
                            orderDate = orderDate,
                        )
                        container.settingsRepository.setCurrentOrder(id)
                        onCreated(id)
                    }
                },
            )
            Spacer(Modifier.height(24.dp))
        }
    }

    if (showDatePicker) {
        val pickerState = rememberDatePickerState(initialSelectedDateMillis = orderDate)
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    pickerState.selectedDateMillis?.let { orderDate = it }
                    showDatePicker = false
                }) { Text("OK") }
            },
            dismissButton = {
                TextButton(onClick = { showDatePicker = false }) { Text("Cancel") }
            },
        ) {
            DatePicker(state = pickerState)
        }
    }
}
