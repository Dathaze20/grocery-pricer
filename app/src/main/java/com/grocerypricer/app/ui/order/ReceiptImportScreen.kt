package com.grocerypricer.app.ui.order

import android.os.Build
import android.provider.MediaStore
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.grocerypricer.app.data.model.ImageProcessingStatus
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.ui.components.BigActionButton
import com.grocerypricer.app.ui.components.InfoBanner
import com.grocerypricer.app.ui.components.SecondaryActionButton
import com.grocerypricer.app.ui.components.WarningBanner
import java.io.File

/**
 * Adding receipt photos to an order.
 *
 * Photos can come from the camera or from the gallery, several at a time - a long Jetro receipt
 * often needs a dozen. Each one is read as it arrives, and the order is rebuilt from all of them
 * together so overlapping photos can be spotted.
 */
@Composable
fun ReceiptImportScreen(
    container: AppContainer,
    orderId: Long,
    onReview: (Long) -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val viewModel: ReceiptImportViewModel =
        viewModel(factory = ReceiptImportViewModel.factory(container, orderId))
    val images by viewModel.images.collectAsStateWithLifecycle()
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val order by viewModel.order.collectAsStateWithLifecycle()

    var pendingCapture by remember { mutableStateOf<File?>(null) }

    val maxPickable = remember {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            MediaStore.getPickImagesMaxLimit().coerceIn(2, 50)
        } else {
            30
        }
    }

    val pickImages = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(maxPickable),
    ) { uris -> viewModel.addPickedImages(uris) }

    val takePhoto = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture(),
    ) { success ->
        val file = pendingCapture
        pendingCapture = null
        if (success && file != null) {
            viewModel.addCapturedPhoto(file)
        } else {
            file?.delete()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(order?.name ?: "Receipt photos") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Spacer(Modifier.height(4.dp)) }

            item {
                BigActionButton(
                    "TAKE RECEIPT PHOTO",
                    icon = Icons.Default.PhotoCamera,
                    enabled = !state.busy,
                    onClick = {
                        val file = container.imageStore.newReceiptFile(orderId)
                        pendingCapture = file
                        runCatching { takePhoto.launch(container.imageStore.shareUriFor(file)) }
                            .onFailure { pendingCapture = null }
                    },
                )
            }
            item {
                SecondaryActionButton(
                    "ADD FROM GALLERY",
                    icon = Icons.Default.PhotoLibrary,
                    enabled = !state.busy,
                    onClick = {
                        pickImages.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                        )
                    },
                )
            }

            state.statusMessage?.let { message ->
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.height(24.dp))
                        Spacer(Modifier.height(0.dp))
                        Text("  $message", style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }

            state.errorMessage?.let { message ->
                item { WarningBanner(message) }
            }

            if (images.isEmpty()) {
                item {
                    InfoBanner(
                        "Add every page of the receipt. Photos can overlap - Grocery Pricer will flag anything it sees twice.",
                    )
                }
            } else {
                item {
                    Text(
                        "${images.size} photo(s), ${images.count { it.status == ImageProcessingStatus.DONE }} read",
                        style = MaterialTheme.typography.titleMedium,
                    )
                }
            }

            items(images, key = { it.id }) { image ->
                Card(Modifier.fillMaxWidth()) {
                    Row(
                        Modifier.padding(16.dp).fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                "Photo ${image.position + 1}",
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Text(
                                when (image.status) {
                                    ImageProcessingStatus.DONE -> "${image.lineCount} lines read"
                                    ImageProcessingStatus.FAILED -> image.errorMessage ?: "Could not read this photo."
                                    else -> image.status.displayName
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = if (image.status == ImageProcessingStatus.FAILED) {
                                    MaterialTheme.colorScheme.error
                                } else {
                                    MaterialTheme.colorScheme.onSurfaceVariant
                                },
                            )
                            if (image.status == ImageProcessingStatus.FAILED) {
                                TextButton(onClick = { viewModel.retry(image) }) { Text("Try again") }
                            }
                        }
                        IconButton(onClick = { viewModel.deleteImage(image) }) {
                            Icon(Icons.Default.Delete, contentDescription = "Remove photo")
                        }
                    }
                }
            }

            item { Spacer(Modifier.height(8.dp)) }

            item {
                BigActionButton(
                    "REVIEW ORDER",
                    enabled = !state.busy && images.any { it.status == ImageProcessingStatus.DONE },
                    onClick = { viewModel.buildOrder { onReview(orderId) } },
                )
            }
            item {
                Text(
                    "Rebuilding replaces the rows read from these photos. Items you added by hand are replaced too.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}
