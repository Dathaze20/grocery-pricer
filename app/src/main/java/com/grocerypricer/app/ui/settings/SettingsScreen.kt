package com.grocerypricer.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
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
import androidx.compose.ui.unit.dp
import com.grocerypricer.app.data.model.AppSettings
import com.grocerypricer.app.data.model.ThemeMode
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.components.InfoBanner
import com.grocerypricer.app.ui.components.PlainTextField
import com.grocerypricer.app.ui.components.SecondaryActionButton
import com.grocerypricer.app.ui.components.SectionCard
import com.grocerypricer.core.model.PriceEnding
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(
    container: AppContainer,
    settings: AppSettings,
    onPricingRules: () -> Unit,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var storeName by remember(settings.storeName) { mutableStateOf(settings.storeName) }
    var defaultSupplier by remember(settings.defaultSupplier) { mutableStateOf(settings.defaultSupplier) }
    var marginThreshold by remember(settings.minimumGrossMarginPercent) { mutableStateOf(settings.minimumGrossMarginPercent) }
    var costThreshold by remember(settings.costChangeAlertPercent) { mutableStateOf(settings.costChangeAlertPercent) }
    var message by remember { mutableStateOf<String?>(null) }

    fun update(transform: (AppSettings) -> AppSettings) {
        scope.launch { container.settingsRepository.update(transform) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
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
            message?.let { InfoBanner(it) }

            SectionCard("Store") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    PlainTextField("Store name", storeName, { storeName = it })
                    PlainTextField("Default supplier", defaultSupplier, { defaultSupplier = it })
                    SecondaryActionButton("SAVE STORE DETAILS", onClick = {
                        update { it.copy(storeName = storeName, defaultSupplier = defaultSupplier) }
                        message = "Store details saved."
                    })
                }
            }

            SectionCard("Pricing") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Default price ending", style = MaterialTheme.typography.titleMedium)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PriceEnding.PRESETS.forEach { ending ->
                            FilterChip(
                                selected = settings.priceEndingCents == ending.cents,
                                onClick = { update { it.copy(priceEndingCents = ending.cents) } },
                                label = { Text(ending.label) },
                            )
                        }
                    }
                    PlainTextField("Margin warning below (%)", marginThreshold, { marginThreshold = it })
                    PlainTextField("Wholesale cost change alert (%)", costThreshold, { costThreshold = it })
                    SecondaryActionButton("SAVE THRESHOLDS", onClick = {
                        update {
                            it.copy(
                                minimumGrossMarginPercent = marginThreshold.ifBlank { it.minimumGrossMarginPercent },
                                costChangeAlertPercent = costThreshold.ifBlank { it.costChangeAlertPercent },
                            )
                        }
                        message = "Thresholds saved."
                    })
                    SecondaryActionButton("EDIT PRICING RULES", onPricingRules)
                }
            }

            SectionCard("Scanning") {
                Column {
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Vibrate on scan", style = MaterialTheme.typography.bodyLarge)
                        Switch(
                            checked = settings.cameraVibration,
                            onCheckedChange = { value -> update { it.copy(cameraVibration = value) } },
                        )
                    }
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Beep on scan", style = MaterialTheme.typography.bodyLarge)
                        Switch(
                            checked = settings.cameraSound,
                            onCheckedChange = { value -> update { it.copy(cameraSound = value) } },
                        )
                    }
                }
            }

            SectionCard("Backup") {
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("Include receipt photos", style = MaterialTheme.typography.bodyLarge)
                        Text(
                            "Makes backup files much larger.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        checked = settings.includeImagesInBackup,
                        onCheckedChange = { value -> update { it.copy(includeImagesInBackup = value) } },
                    )
                }
            }

            SectionCard("Appearance") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ThemeMode.entries.forEach { mode ->
                        FilterChip(
                            selected = settings.themeMode == mode,
                            onClick = { update { it.copy(themeMode = mode) } },
                            label = { Text(mode.displayName) },
                        )
                    }
                }
            }

            SectionCard("Getting started") {
                SecondaryActionButton("SHOW THE INTRO AGAIN", onClick = {
                    update { it.copy(tutorialCompleted = false) }
                    message = "The intro will show next time you open the app."
                })
            }

            SectionCard("Privacy") {
                Text(
                    "Receipt and product information stays on this device unless you explicitly export it. " +
                        "Grocery Pricer does not upload receipt photos, product photos or prices, does not " +
                        "collect analytics, and does not need an account or an internet connection. Text " +
                        "recognition and barcode scanning run on the phone itself.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }

            SectionCard("About") {
                Column {
                    Text("Grocery Pricer 1.0.0", style = MaterialTheme.typography.bodyLarge)
                    Text(
                        "Local-first wholesale receipt pricing.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Spacer(Modifier.height(32.dp))
        }
    }
}
