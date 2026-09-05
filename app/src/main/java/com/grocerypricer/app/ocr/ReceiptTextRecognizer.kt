package com.grocerypricer.app.ocr

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.Rect
import androidx.exifinterface.media.ExifInterface
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.abs
import kotlin.math.max

/**
 * Reads text off a receipt photograph with ML Kit's on-device recognizer.
 *
 * Two things matter beyond calling the library:
 *  - photos come in sideways, so the EXIF rotation is applied before recognition;
 *  - ML Kit returns text in blocks, and a receipt row such as `CASE $33.99 SIZE 12 UNIT $2.83`
 *    is often split across several of them. Lines sitting at the same height are stitched back
 *    into one line, left to right, so the parser sees the row the way a person does.
 *
 * The model is bundled in the APK, so this works with no network connection.
 */
class ReceiptTextRecognizer(private val context: Context) {

    private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

    suspend fun recognize(file: File): Result<String> = withContext(Dispatchers.IO) {
        try {
            val bitmap = decodeOriented(file)
                ?: return@withContext Result.failure(
                    IllegalStateException("Could not read this receipt image. Retake the photo or enter the item manually.")
                )
            val text = runRecognition(InputImage.fromBitmap(bitmap, 0))
            bitmap.recycle()
            Result.success(stitchLines(text))
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    private suspend fun runRecognition(image: InputImage): Text =
        suspendCancellableCoroutine { continuation ->
            recognizer.process(image)
                .addOnSuccessListener { result -> if (continuation.isActive) continuation.resume(result) }
                .addOnFailureListener { error -> if (continuation.isActive) continuation.resumeWithException(error) }
        }

    /** Decodes at a workable size and turns the photo the right way up. */
    private fun decodeOriented(file: File): Bitmap? {
        if (!file.exists()) return null

        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

        var sampleSize = 1
        while (max(bounds.outWidth, bounds.outHeight) / sampleSize > MAX_DIMENSION) {
            sampleSize *= 2
        }

        val decoded = BitmapFactory.decodeFile(
            file.absolutePath,
            BitmapFactory.Options().apply { inSampleSize = sampleSize },
        ) ?: return null

        val degrees = rotationDegrees(file)
        if (degrees == 0) return decoded

        return try {
            val matrix = Matrix().apply { postRotate(degrees.toFloat()) }
            val rotated = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
            if (rotated != decoded) decoded.recycle()
            rotated
        } catch (e: OutOfMemoryError) {
            decoded
        }
    }

    private fun rotationDegrees(file: File): Int = try {
        when (ExifInterface(file.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90
            ExifInterface.ORIENTATION_ROTATE_180 -> 180
            ExifInterface.ORIENTATION_ROTATE_270 -> 270
            else -> 0
        }
    } catch (e: Exception) {
        0
    }

    companion object {
        private const val MAX_DIMENSION = 2600

        /**
         * Rebuilds visual rows out of ML Kit's blocks: lines whose vertical centres are close
         * enough to be the same row on the paper are joined, ordered left to right.
         */
        fun stitchLines(text: Text): String {
            val lines = text.textBlocks
                .flatMap { it.lines }
                .mapNotNull { line -> line.boundingBox?.let { PositionedLine(line.text, it) } }
            if (lines.isEmpty()) return text.text

            val ordered = lines.sortedWith(compareBy({ it.centreY }, { it.box.left }))
            val rows = mutableListOf<MutableList<PositionedLine>>()

            ordered.forEach { line ->
                val row = rows.lastOrNull()
                val anchor = row?.firstOrNull()
                val tolerance = ((anchor?.box?.height() ?: line.box.height()) * ROW_TOLERANCE).toInt()
                if (anchor != null && abs(line.centreY - anchor.centreY) <= tolerance) {
                    row.add(line)
                } else {
                    rows.add(mutableListOf(line))
                }
            }

            return rows.joinToString("\n") { row ->
                row.sortedBy { it.box.left }.joinToString(" ") { it.text.trim() }.trim()
            }
        }

        /** Lines within this fraction of a line height of each other belong to the same row. */
        private const val ROW_TOLERANCE = 0.6

        private data class PositionedLine(val text: String, val box: Rect) {
            val centreY: Int get() = box.centerY()
        }
    }
}
