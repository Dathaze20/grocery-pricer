package com.grocerypricer.app

import android.content.Intent
import android.graphics.Bitmap
import androidx.test.core.app.ApplicationProvider
import com.grocerypricer.app.ai.ImagePreparer
import com.grocerypricer.app.processing.OrderProcessingWorker
import com.grocerypricer.app.ui.camera.PhotoCaptureOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/**
 * What happens after the camera closes.
 *
 * The camera itself needs a device and is not pretended to be tested here. What *is* tested is
 * every decision made around it: whether a result becomes an attachment, and whether the file it
 * produces can travel the same road a gallery photo does.
 */
class PhotoCaptureOutcomeTest {

    @get:Rule
    val temp = TemporaryFolder()

    private fun realFile(bytes: Int = 64): File =
        temp.newFile().apply { writeBytes(ByteArray(bytes) { 1 }) }

    @Test
    fun `a successful capture is attached`() {
        val file = realFile()
        assertEquals(file, PhotoCaptureOutcome.resolve(success = true, file = file))
        assertTrue(file.exists())
    }

    @Test
    fun `a cancelled capture attaches nothing and leaves nothing behind`() {
        // Backing out of the camera is the common case, and the empty file it leaves would
        // otherwise sit in the app's storage forever.
        val file = realFile()
        assertNull(PhotoCaptureOutcome.resolve(success = false, file = file))
        assertFalse("the abandoned file should be deleted", file.exists())
    }

    @Test
    fun `a camera that reports success but writes nothing is not attached`() {
        // Some camera apps do exactly this. Attaching the path would send a zero-byte image and
        // produce a confusing failure much further downstream.
        val empty = temp.newFile()
        assertEquals(0L, empty.length())
        assertNull(PhotoCaptureOutcome.resolve(success = true, file = empty))
        assertFalse(empty.exists())
    }

    @Test
    fun `a file that vanished is not attached`() {
        val file = realFile()
        file.delete()
        assertNull(PhotoCaptureOutcome.resolve(success = true, file = file))
    }

    @Test
    fun `no pending file at all is handled`() {
        assertNull(PhotoCaptureOutcome.resolve(success = true, file = null))
        assertNull(PhotoCaptureOutcome.resolve(success = false, file = null))
    }
}

/**
 * The notification's order id, which decides which conversation opens.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = android.app.Application::class)
class NotificationIntentTest {

    private fun intentWith(orderId: Long): Intent =
        Intent().putExtra(OrderProcessingWorker.EXTRA_ORDER_ID, orderId)

    @Test
    fun `an order-ready intent carries its order`() {
        assertEquals(42L, OrderProcessingWorker.orderIdFrom(intentWith(42L)))
    }

    @Test
    fun `an ordinary launch is not treated as a notification`() {
        // A plain launcher tap has no extra at all, and must not open some arbitrary order.
        assertNull(OrderProcessingWorker.orderIdFrom(Intent()))
        assertNull(OrderProcessingWorker.orderIdFrom(null))
    }

    @Test
    fun `zero is not an order id`() {
        // getLongExtra's default. Treating it as real would navigate to a chat for order 0.
        assertNull(OrderProcessingWorker.orderIdFrom(intentWith(0L)))
        assertNull(OrderProcessingWorker.orderIdFrom(intentWith(-1L)))
    }

    @Test
    fun `two orders keep their own ids`() {
        // Different orders notify separately; one must never open the other's conversation.
        assertEquals(7L, OrderProcessingWorker.orderIdFrom(intentWith(7L)))
        assertEquals(8L, OrderProcessingWorker.orderIdFrom(intentWith(8L)))
        assertEquals(
            OrderProcessingWorker.uniqueNameFor(7L) != OrderProcessingWorker.uniqueNameFor(8L),
            true,
        )
    }
}

/**
 * The leg between a captured file and the product-identification request.
 *
 * A camera photo and a gallery photo both end up as a path on disk, and from there they take
 * exactly the same road. This is the part of that road that can be walked without a device.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = android.app.Application::class)
class CapturedPhotoReachesTheModelTest {

    @get:Rule
    val temp = TemporaryFolder()

    private fun writeJpeg(width: Int, height: Int): File {
        val file = temp.newFile("capture.jpg")
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        bitmap.recycle()
        return file
    }

    @Test
    fun `a photo on disk becomes an image the provider can be given`() {
        val prepared = ImagePreparer.prepare(writeJpeg(800, 600), photoId = 0L)
        assertNotNull("a real photo should prepare", prepared)
        assertTrue(prepared!!.bytes.isNotEmpty())
        assertEquals("image/jpeg", prepared.mediaType)
    }

    @Test
    fun `a missing or unreadable file prepares to nothing rather than throwing`() {
        assertNull(ImagePreparer.prepare(File(temp.root, "not-there.jpg"), photoId = 0L))
        assertNull(ImagePreparer.prepare(temp.newFile("empty.jpg"), photoId = 0L))

        val notAnImage = temp.newFile("notes.txt").apply { writeText("this is not a photograph") }
        assertNull(ImagePreparer.prepare(notAnImage, photoId = 0L))
    }

    @Test
    fun `an oversized photo is scaled down before it is sent`() {
        // The shopkeeper pays for the pixels. A 12MP phone photo must not go out whole.
        val huge = writeJpeg(4000, 3000)
        val prepared = ImagePreparer.prepare(huge, photoId = 0L)
        assertNotNull(prepared)
        assertTrue(
            "prepared image (${prepared!!.bytes.size}) should be smaller than the original (${huge.length()})",
            prepared.bytes.size < huge.length(),
        )
    }

    @Test
    fun `sample size never drops a photo below the legible limit`() {
        // Receipt text has to stay readable; halving too far is how OCR-grade detail is lost.
        assertEquals(1, ImagePreparer.sampleSizeFor(1600, 1200, maxEdge = 1568))
        assertEquals(2, ImagePreparer.sampleSizeFor(4000, 3000, maxEdge = 1568))
        assertEquals(1, ImagePreparer.sampleSizeFor(100, 100, maxEdge = 1568))
    }
}
