package com.grocerypricer.app.ui.camera

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.grocerypricer.app.data.files.ImageStore
import java.io.File

/**
 * Decides what a finished capture actually produced.
 *
 * Split out from the Compose code on purpose: this is the part that can be wrong in a way that
 * matters - attaching a path to a file the camera never wrote - and it is the part a unit test
 * can reach without a device.
 */
object PhotoCaptureOutcome {

    /**
     * The file to attach, or null if nothing usable came back.
     *
     * A cancelled capture reports `success = false`, but a camera app can also report success and
     * leave a zero-byte file behind, so the size is checked too. Either way the empty file is
     * deleted rather than left in the app's storage.
     */
    fun resolve(success: Boolean, file: File?): File? {
        if (file == null) return null
        if (!success || !file.exists() || file.length() == 0L) {
            file.delete()
            return null
        }
        return file
    }
}

/**
 * A camera capture the user can start from anywhere.
 *
 * Wraps three things that are easy to get individually right and collectively wrong: the
 * permission, the file the camera writes into, and the cleanup when the user backs out.
 *
 * The permission matters more than it looks. Handing the camera a `content://` URI it can write
 * to needs no permission by itself - but because Grocery Pricer *declares* `CAMERA` for the
 * barcode scanner, Android requires that permission to be granted before it will honour an image
 * capture at all. An app that declares it and never asks gets a silent failure, which is exactly
 * what a shopkeeper tapping a camera button that does nothing would experience.
 *
 * @return a function to call from `onClick`.
 */
@Composable
fun rememberPhotoCapture(
    imageStore: ImageStore,
    orderId: Long,
    onCaptured: (File) -> Unit,
): () -> Unit {
    val context = LocalContext.current
    val capturedCallback by rememberUpdatedState(onCaptured)

    // The file handed to the camera, held until it reports back. Nothing else may touch it.
    var pendingCapture by remember { mutableStateOf<File?>(null) }

    val takePicture = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture(),
    ) { success ->
        val file = pendingCapture
        pendingCapture = null
        PhotoCaptureOutcome.resolve(success, file)?.let(capturedCallback)
    }

    val start = remember(imageStore, orderId) {
        {
            val file = imageStore.newReceiptFile(orderId)
            pendingCapture = file
            runCatching { takePicture.launch(imageStore.shareUriFor(file)) }
                .onFailure {
                    // No camera app, or the provider refused. Leave nothing behind.
                    pendingCapture = null
                    file.delete()
                }
            Unit
        }
    }

    val requestCamera = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> if (granted) start() }

    return {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) start() else requestCamera.launch(Manifest.permission.CAMERA)
    }
}
