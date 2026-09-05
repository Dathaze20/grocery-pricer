package com.grocerypricer.app.ui.scan

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.grocerypricer.app.data.model.AppSettings
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.scanner.BarcodeAnalyzer
import com.grocerypricer.app.scanner.ScanDebouncer
import com.grocerypricer.app.ui.components.BigActionButton
import com.grocerypricer.app.ui.components.BigPrice
import com.grocerypricer.app.ui.components.InfoBanner
import com.grocerypricer.app.ui.components.LabelledValue
import com.grocerypricer.app.ui.components.MoneyField
import com.grocerypricer.app.ui.components.PlainTextField
import com.grocerypricer.app.ui.components.QuickPriceRow
import com.grocerypricer.app.ui.components.SecondaryActionButton
import com.grocerypricer.app.ui.components.WarningBanner
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.pricing.ProfitCalculator
import java.io.File

/**
 * Scan a product, see what it cost, approve a shelf price, move on.
 *
 * The camera stays bound the whole time and the pricing card is drawn over it, so approving a
 * price puts the employee straight back on the scanner without a navigation step.
 */
@Composable
fun ScanScreen(
    container: AppContainer,
    settings: AppSettings,
    orderId: Long,
    startInCameraMode: Boolean,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val viewModel: ScanViewModel = viewModel(factory = ScanViewModel.factory(container, orderId))
    val state by viewModel.state.collectAsStateWithLifecycle()

    var cameraMode by remember { mutableStateOf(startInCameraMode) }
    var searchTerm by remember { mutableStateOf("") }
    var showPriceDialog by remember { mutableStateOf(false) }
    var pendingCapture by remember { mutableStateOf<File?>(null) }
    var cameraError by remember { mutableStateOf<String?>(null) }

    var hasCameraPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED
        )
    }
    val requestPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> hasCameraPermission = granted }

    LaunchedEffect(Unit) {
        if (!hasCameraPermission) requestPermission.launch(Manifest.permission.CAMERA)
    }

    val feedback = remember { ScanFeedback(context) }
    val debouncer = remember { ScanDebouncer() }
    val settingsRef = rememberUpdatedState(settings)
    val scanningRef = rememberUpdatedState(state.mode == ScanMode.SCANNING)

    val analyzer = remember {
        BarcodeAnalyzer(debouncer) { value ->
            if (scanningRef.value) {
                feedback.success(settingsRef.value.cameraVibration, settingsRef.value.cameraSound)
                viewModel.onBarcodeScanned(value)
            }
        }
    }

    val takePhoto = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture(),
    ) { success ->
        val file = pendingCapture
        pendingCapture = null
        if (success && file != null) viewModel.identifyFromPhoto(file) else file?.delete()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (cameraMode) "Camera mode" else "Scan product") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    Text("Camera mode", style = MaterialTheme.typography.bodySmall)
                    Switch(checked = cameraMode, onCheckedChange = { cameraMode = it })
                    IconButton(onClick = { viewModel.openSearch() }) {
                        Icon(Icons.Default.Search, contentDescription = "Search")
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (hasCameraPermission) {
                BarcodeCamera(
                    analyzer = analyzer,
                    modifier = Modifier.fillMaxSize(),
                    onError = { cameraError = it },
                )
            }

            when (state.mode) {
                ScanMode.SCANNING -> ScanningOverlay(
                    hasCameraPermission = hasCameraPermission,
                    cameraError = cameraError,
                    approvedCount = state.approvedCount,
                    message = state.message,
                    onRequestPermission = { requestPermission.launch(Manifest.permission.CAMERA) },
                    onIdentifyFromPhoto = {
                        val file = container.imageStore.newReceiptFile(orderId)
                        pendingCapture = file
                        runCatching { takePhoto.launch(container.imageStore.shareUriFor(file)) }
                            .onFailure { pendingCapture = null }
                    },
                    onSearch = { viewModel.openSearch() },
                )

                ScanMode.RESULT -> state.target?.let { target ->
                    PricingCard(
                        target = target,
                        onApprove = { price ->
                            feedback.approved(settings.cameraVibration, settings.cameraSound)
                            debouncer.reset()
                            viewModel.approvePrice(price, resumeScanning = cameraMode)
                        },
                        onChangePrice = { showPriceDialog = true },
                        onNext = {
                            debouncer.reset()
                            viewModel.nextProduct()
                        },
                        modifier = Modifier.align(Alignment.BottomCenter),
                    )
                }

                ScanMode.NOT_FOUND -> NotFoundOverlay(
                    barcode = state.lastBarcode,
                    message = state.message,
                    onSearch = { viewModel.openSearch() },
                    onNext = {
                        debouncer.reset()
                        viewModel.nextProduct()
                    },
                    modifier = Modifier.align(Alignment.BottomCenter),
                )

                ScanMode.CANDIDATES -> CandidateList(
                    title = "Which product is this?",
                    targets = state.candidates,
                    onPick = { viewModel.choose(it) },
                    onCancel = { viewModel.nextProduct() },
                    modifier = Modifier.align(Alignment.BottomCenter),
                )

                ScanMode.SEARCH -> Surface(Modifier.fillMaxSize()) {
                    Column(Modifier.padding(16.dp)) {
                        PlainTextField(
                            "Search products",
                            searchTerm,
                            {
                                searchTerm = it
                                viewModel.search(it)
                            },
                        )
                        Spacer(Modifier.height(12.dp))
                        if (state.searchResults.isEmpty()) {
                            Text(
                                if (searchTerm.isBlank()) {
                                    "Type part of a name, a size, a UPC or a supplier item number."
                                } else {
                                    "Nothing matched \"$searchTerm\"."
                                },
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        LazyColumn(Modifier.weight(1f)) {
                            items(state.searchResults) { target ->
                                Column(
                                    Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 12.dp),
                                ) {
                                    TextButton(onClick = { viewModel.choose(target) }) {
                                        Column(Modifier.fillMaxWidth()) {
                                            Text(
                                                listOfNotNull(target.title, target.size).joinToString(" "),
                                                style = MaterialTheme.typography.titleMedium,
                                            )
                                            Text(
                                                "Cost ${target.unitCost?.roundedToCents()?.format() ?: "-"}" +
                                                    (target.previousPrice?.let { "  -  last price ${it.format()}" } ?: ""),
                                                style = MaterialTheme.typography.bodySmall,
                                            )
                                        }
                                    }
                                    HorizontalDivider()
                                }
                            }
                        }
                        SecondaryActionButton("BACK TO SCANNER", { viewModel.nextProduct() })
                    }
                }
            }
        }
    }

    if (showPriceDialog) {
        var customPrice by remember { mutableStateOf(state.target?.suggestion?.suggestedPrice?.toPlainString().orEmpty()) }
        AlertDialog(
            onDismissRequest = { showPriceDialog = false },
            title = { Text("Set the store price") },
            text = { MoneyField("Store price", customPrice, { customPrice = it }) },
            confirmButton = {
                TextButton(
                    enabled = Money.parseOrNull(customPrice)?.isPositive == true,
                    onClick = {
                        Money.parseOrNull(customPrice)?.let { price ->
                            feedback.approved(settings.cameraVibration, settings.cameraSound)
                            debouncer.reset()
                            viewModel.approvePrice(price, resumeScanning = cameraMode)
                        }
                        showPriceDialog = false
                    },
                ) { Text("Use this price") }
            },
            dismissButton = { TextButton(onClick = { showPriceDialog = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun ScanningOverlay(
    hasCameraPermission: Boolean,
    cameraError: String?,
    approvedCount: Int,
    message: String?,
    onRequestPermission: () -> Unit,
    onIdentifyFromPhoto: () -> Unit,
    onSearch: () -> Unit,
) {
    Column(
        Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Column {
            if (!hasCameraPermission) {
                WarningBanner(
                    "Grocery Pricer needs the camera to scan barcodes. You can still search by name without it.",
                )
                Spacer(Modifier.height(8.dp))
                SecondaryActionButton("ALLOW CAMERA", onRequestPermission)
            } else if (cameraError != null) {
                WarningBanner("The camera could not be started: $cameraError")
            } else {
                Surface(color = Color.Black.copy(alpha = 0.55f), shape = MaterialTheme.shapes.medium) {
                    Text(
                        "Point at a barcode",
                        style = MaterialTheme.typography.titleMedium,
                        color = Color.White,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }
            message?.let {
                Spacer(Modifier.height(8.dp))
                InfoBanner(it)
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (approvedCount > 0) {
                Surface(color = Color.Black.copy(alpha = 0.55f), shape = MaterialTheme.shapes.medium) {
                    Text(
                        "$approvedCount priced this session",
                        color = Color.White,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(10.dp),
                    )
                }
            }
            SecondaryActionButton("IDENTIFY FROM PHOTO", onIdentifyFromPhoto, icon = Icons.Default.PhotoCamera)
            SecondaryActionButton("SEARCH BY NAME", onSearch, icon = Icons.Default.Search)
        }
    }
}

@Composable
private fun PricingCard(
    target: PricingTarget,
    onApprove: (Money) -> Unit,
    onChangePrice: () -> Unit,
    onNext: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val suggested = target.suggestion?.suggestedPrice
    val profit = if (target.unitCost != null && suggested != null) {
        ProfitCalculator.summarise(target.unitCost, suggested)
    } else {
        null
    }

    Card(modifier = modifier.fillMaxWidth().heightIn(max = 640.dp)) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Text(target.title, style = MaterialTheme.typography.headlineSmall)
            target.size?.let {
                Text(it, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (target.inCurrentOrder) {
                Text(
                    "From the order you are pricing",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }

            Spacer(Modifier.height(12.dp))
            BigPrice("Cost each", target.unitCost?.roundedToCents()?.format() ?: "Unknown")

            target.costChange?.let { change ->
                Spacer(Modifier.height(8.dp))
                WarningBanner(
                    "Wholesale cost moved: ${change.previousCost.format()} -> ${change.newCost.format()} " +
                        "(${ProfitCalculator.formatSignedPercent(change.changePercent)})"
                )
            }

            Spacer(Modifier.height(12.dp))
            LabelledValue("Previous store price", target.previousPrice?.format() ?: "-")
            LabelledValue("Suggested price", suggested?.format() ?: "-", emphasise = true)
            target.suggestion?.let { suggestion ->
                Text(
                    suggestion.rationale,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (suggestion.priceReviewRecommended) {
                    Spacer(Modifier.height(8.dp))
                    WarningBanner("PRICE REVIEW RECOMMENDED - the old price no longer holds your margin.")
                }
                if (suggestion.belowMinimumMargin) {
                    Spacer(Modifier.height(8.dp))
                    WarningBanner("This price is below your minimum gross margin.")
                }
            }

            profit?.let {
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                LabelledValue("Gross profit", it.grossProfit.format())
                LabelledValue("Gross margin", ProfitCalculator.formatPercent(it.grossMarginPercent))
                LabelledValue("Markup", ProfitCalculator.formatPercent(it.markupPercent))
            }

            Spacer(Modifier.height(16.dp))
            if (suggested != null) {
                BigActionButton("USE ${suggested.format()}", { onApprove(suggested) })
                Spacer(Modifier.height(8.dp))
            }
            target.suggestion?.alternatives?.takeIf { it.isNotEmpty() }?.let { alternatives ->
                QuickPriceRow(alternatives, onPick = onApprove)
                Spacer(Modifier.height(8.dp))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryActionButton("CHANGE PRICE", onChangePrice, modifier = Modifier.weight(1f))
                SecondaryActionButton("NEXT PRODUCT", onNext, modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun NotFoundOverlay(
    barcode: String?,
    message: String?,
    onSearch: () -> Unit,
    onNext: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text("No product matched this barcode", style = MaterialTheme.typography.titleLarge)
            barcode?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            message?.let {
                Spacer(Modifier.height(8.dp))
                Text(it, style = MaterialTheme.typography.bodyMedium)
            }
            Spacer(Modifier.height(16.dp))
            SecondaryActionButton("SEARCH BY NAME", onSearch)
            Spacer(Modifier.height(8.dp))
            SecondaryActionButton("KEEP SCANNING", onNext)
        }
    }
}

@Composable
private fun CandidateList(
    title: String,
    targets: List<PricingTarget>,
    onPick: (PricingTarget) -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(modifier = modifier.fillMaxWidth().heightIn(max = 520.dp)) {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleLarge)
            Text(
                "Grocery Pricer is not certain, so pick the right one.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(8.dp))
            LazyColumn(Modifier.weight(1f, fill = false)) {
                items(targets) { target ->
                    TextButton(onClick = { onPick(target) }, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.fillMaxWidth()) {
                            Text(
                                listOfNotNull(target.title, target.size).joinToString(" "),
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Text(
                                "Cost ${target.unitCost?.roundedToCents()?.format() ?: "-"}",
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                    HorizontalDivider()
                }
            }
            Spacer(Modifier.height(8.dp))
            SecondaryActionButton("CANCEL", onCancel)
        }
    }
}
