package com.grocerypricer.app.scanner

import androidx.annotation.OptIn
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage

/**
 * Reads retail barcodes off the camera preview with ML Kit, on device.
 *
 * Only the formats a grocery shelf actually carries are enabled, which keeps recognition fast,
 * and repeated reads of the same code are suppressed by [ScanDebouncer].
 */
class BarcodeAnalyzer(
    private val debouncer: ScanDebouncer = ScanDebouncer(),
    private val onBarcode: (String) -> Unit,
) : ImageAnalysis.Analyzer {

    private val scanner by lazy {
        BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder()
                .setBarcodeFormats(
                    Barcode.FORMAT_UPC_A,
                    Barcode.FORMAT_UPC_E,
                    Barcode.FORMAT_EAN_8,
                    Barcode.FORMAT_EAN_13,
                    Barcode.FORMAT_CODE_128,
                )
                .build()
        )
    }

    @OptIn(ExperimentalGetImage::class)
    override fun analyze(imageProxy: ImageProxy) {
        val mediaImage = imageProxy.image
        if (mediaImage == null) {
            imageProxy.close()
            return
        }
        val input = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
        scanner.process(input)
            .addOnSuccessListener { barcodes ->
                barcodes.firstNotNullOfOrNull { it.rawValue?.takeIf { value -> value.isNotBlank() } }
                    ?.let { value -> if (debouncer.accept(value)) onBarcode(value) }
            }
            .addOnCompleteListener { imageProxy.close() }
    }

    /** Lets the same product be scanned again once the user has moved on from it. */
    fun allowRescan() = debouncer.reset()
}
