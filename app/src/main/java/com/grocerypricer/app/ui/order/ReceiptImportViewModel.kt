package com.grocerypricer.app.ui.order

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.grocerypricer.app.data.model.ImageProcessingStatus
import com.grocerypricer.app.data.model.Order
import com.grocerypricer.app.data.model.ReceiptImage
import com.grocerypricer.app.di.AppContainer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File

data class ImportUiState(
    val busy: Boolean = false,
    val statusMessage: String? = null,
    val errorMessage: String? = null,
    val parsedCount: Int? = null,
)

/**
 * Drives receipt import: copy the photos in, run OCR on each one, then rebuild the order from
 * everything that was read.
 */
class ReceiptImportViewModel(
    private val container: AppContainer,
    private val orderId: Long,
) : ViewModel() {

    val order: StateFlow<Order?> = container.orderRepository.observeOrder(orderId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    val images: StateFlow<List<ReceiptImage>> = container.orderRepository.observeReceiptImages(orderId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _uiState = MutableStateFlow(ImportUiState())
    val uiState: StateFlow<ImportUiState> = _uiState.asStateFlow()

    fun addPickedImages(uris: List<Uri>) {
        if (uris.isEmpty()) return
        viewModelScope.launch {
            _uiState.update { it.copy(busy = true, errorMessage = null, parsedCount = null) }
            var failures = 0
            uris.forEachIndexed { index, uri ->
                _uiState.update { it.copy(statusMessage = "Reading photo ${index + 1} of ${uris.size}...") }
                val file = container.imageStore.copyIn(uri, orderId)
                if (file == null) {
                    failures++
                } else {
                    recognise(file, uri.toString())
                }
            }
            _uiState.update {
                it.copy(
                    busy = false,
                    statusMessage = null,
                    errorMessage = if (failures > 0) {
                        "$failures photo(s) could not be opened. Try adding them again."
                    } else {
                        null
                    },
                )
            }
        }
    }

    fun addCapturedPhoto(file: File) {
        viewModelScope.launch {
            _uiState.update { it.copy(busy = true, statusMessage = "Reading photo...", errorMessage = null, parsedCount = null) }
            recognise(file, null)
            _uiState.update { it.copy(busy = false, statusMessage = null) }
        }
    }

    private suspend fun recognise(file: File, sourceUri: String?) {
        val imageId = container.orderRepository.addReceiptImage(orderId, file.absolutePath, sourceUri)
        container.orderRepository.markImageProcessing(imageId)
        val result = container.textRecognizer.recognize(file)
        result.fold(
            onSuccess = { text ->
                if (text.isBlank()) {
                    container.orderRepository.saveImageFailure(
                        imageId,
                        "No text was found in this image. Retake the photo in better light, or enter the items manually.",
                    )
                } else {
                    container.orderRepository.saveImageText(imageId, text)
                }
            },
            onFailure = { error ->
                container.orderRepository.saveImageFailure(
                    imageId,
                    error.message ?: "Could not read this receipt image. Retake the photo or enter the item manually.",
                )
            },
        )
    }

    /** Re-runs OCR on a photo that failed the first time. */
    fun retry(image: ReceiptImage) {
        viewModelScope.launch {
            _uiState.update { it.copy(busy = true, statusMessage = "Reading photo again...") }
            container.orderRepository.markImageProcessing(image.id)
            val result = container.textRecognizer.recognize(File(image.localPath))
            result.fold(
                onSuccess = { text ->
                    if (text.isBlank()) {
                        container.orderRepository.saveImageFailure(image.id, "No text was found in this image.")
                    } else {
                        container.orderRepository.saveImageText(image.id, text)
                    }
                },
                onFailure = { error ->
                    container.orderRepository.saveImageFailure(
                        image.id,
                        error.message ?: "Could not read this receipt image.",
                    )
                },
            )
            _uiState.update { it.copy(busy = false, statusMessage = null) }
        }
    }

    fun deleteImage(image: ReceiptImage) {
        viewModelScope.launch {
            container.orderRepository.deleteReceiptImage(image.id)
            container.imageStore.delete(image.localPath)
        }
    }

    /** Rebuilds the order's rows from every photo that was read successfully. */
    fun buildOrder(onDone: (Int) -> Unit) {
        viewModelScope.launch {
            _uiState.update { it.copy(busy = true, statusMessage = "Rebuilding the order...", errorMessage = null) }
            val rules = container.pricingRulesRepository.current()
            val count = runCatching { container.orderRepository.reparseOrder(orderId, rules) }
            _uiState.update { state ->
                count.fold(
                    onSuccess = { parsed ->
                        state.copy(busy = false, statusMessage = null, parsedCount = parsed)
                    },
                    onFailure = { error ->
                        state.copy(
                            busy = false,
                            statusMessage = null,
                            errorMessage = "The receipt could not be rebuilt: ${error.message ?: "unknown error"}",
                        )
                    },
                )
            }
            count.getOrNull()?.let(onDone)
        }
    }

    fun readyToBuild(): Boolean = images.value.any { it.status == ImageProcessingStatus.DONE }

    companion object {
        fun factory(container: AppContainer, orderId: Long): ViewModelProvider.Factory = viewModelFactory {
            initializer { ReceiptImportViewModel(container, orderId) }
        }
    }
}
