package com.grocerypricer.app.data.files

import android.content.Context
import android.net.Uri
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

/**
 * Keeps receipt photographs inside the app's own storage.
 *
 * Images picked from the gallery are copied in, because the URI the picker hands back is only
 * readable for as long as the app is running - and the user needs to be able to reopen the
 * original photo months later.
 */
class ImageStore(private val context: Context) {

    private val receiptsDir: File
        get() = File(context.filesDir, "receipts").apply { if (!exists()) mkdirs() }

    fun newReceiptFile(orderId: Long): File =
        File(receiptsDir, "order-${orderId}-${System.currentTimeMillis()}-${(0..9999).random()}.jpg")

    /** A content URI the system camera can write into. */
    fun shareUriFor(file: File): Uri =
        FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)

    suspend fun copyIn(source: Uri, orderId: Long): File? = withContext(Dispatchers.IO) {
        val target = newReceiptFile(orderId)
        try {
            context.contentResolver.openInputStream(source)?.use { input ->
                target.outputStream().use { output -> input.copyTo(output) }
            } ?: return@withContext null
            target
        } catch (e: IOException) {
            target.delete()
            null
        } catch (e: SecurityException) {
            target.delete()
            null
        }
    }

    fun delete(path: String) {
        runCatching { File(path).delete() }
    }

    fun exists(path: String): Boolean = runCatching { File(path).exists() }.getOrDefault(false)

    fun readBytes(path: String): ByteArray? = runCatching { File(path).readBytes() }.getOrNull()
}
