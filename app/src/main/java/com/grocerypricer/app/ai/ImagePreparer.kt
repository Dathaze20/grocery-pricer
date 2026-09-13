package com.grocerypricer.app.ai

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface
import com.grocerypricer.core.ai.AiConfig
import com.grocerypricer.core.ai.AiImage
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Gets a photograph ready to send.
 *
 * Two jobs, both of which cost the shopkeeper money if skipped. A modern phone photograph is
 * around 12 megapixels; sending it whole spends their API budget on pixels no model needs, and
 * thirty of them would blow the request-size ceiling. And a photograph taken in portrait carries
 * its orientation in EXIF rather than in the pixels, so a receipt can arrive sideways and be
 * read as gibberish.
 *
 * The size ceiling is deliberately generous. Receipt text is small and the whole feature depends
 * on it staying legible - this is not the place to save the last few kilobytes.
 */
object ImagePreparer {

    /** Null when the file is missing or is not a decodable image. */
    fun prepare(
        file: File,
        photoId: Long,
        maxEdge: Int = AiConfig.MAX_IMAGE_EDGE_PX,
        quality: Int = AiConfig.IMAGE_JPEG_QUALITY,
    ): AiImage? {
        if (!file.exists() || file.length() == 0L) return null

        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.absolutePath, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

            // Decode at a reduced sample size rather than full size then shrink: a 12MP bitmap
            // is ~48MB in memory and several of those at once is an OutOfMemoryError.
            val decodeOptions = BitmapFactory.Options().apply {
                inSampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight, maxEdge)
            }
            val decoded = BitmapFactory.decodeFile(file.absolutePath, decodeOptions) ?: return null

            val upright = applyExifRotation(decoded, file)
            val scaled = scaleToFit(upright, maxEdge)

            val bytes = ByteArrayOutputStream().use { stream ->
                scaled.compress(Bitmap.CompressFormat.JPEG, quality, stream)
                stream.toByteArray()
            }

            if (scaled !== decoded) scaled.recycle()
            if (upright !== decoded && upright !== scaled) upright.recycle()
            decoded.recycle()

            bytes.takeIf { it.isNotEmpty() }?.let { AiImage(photoId, it, "image/jpeg") }
        } catch (e: OutOfMemoryError) {
            null
        } catch (e: Exception) {
            null
        }
    }

    /** Largest power of two that still leaves the longest edge at or above [maxEdge]. */
    internal fun sampleSizeFor(width: Int, height: Int, maxEdge: Int): Int {
        var sample = 1
        var longest = maxOf(width, height)
        while (longest / 2 >= maxEdge) {
            longest /= 2
            sample *= 2
        }
        return sample
    }

    private fun scaleToFit(bitmap: Bitmap, maxEdge: Int): Bitmap {
        val longest = maxOf(bitmap.width, bitmap.height)
        if (longest <= maxEdge) return bitmap
        val ratio = maxEdge.toFloat() / longest
        val width = (bitmap.width * ratio).toInt().coerceAtLeast(1)
        val height = (bitmap.height * ratio).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(bitmap, width, height, true)
    }

    private fun applyExifRotation(bitmap: Bitmap, file: File): Bitmap {
        val degrees = try {
            when (
                ExifInterface(file.absolutePath)
                    .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            ) {
                ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                else -> 0f
            }
        } catch (e: Exception) {
            0f
        }
        if (degrees == 0f) return bitmap
        val matrix = Matrix().apply { postRotate(degrees) }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }
}
