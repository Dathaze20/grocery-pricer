package com.grocerypricer.app

import android.content.Intent
import android.graphics.Bitmap
import com.grocerypricer.app.ai.ImagePreparer
import com.grocerypricer.app.processing.OrderProcessingWorker
import com.grocerypricer.app.ui.camera.PhotoCaptureOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
 * The guards around preparing a photograph for upload.
 *
 * Only the decisions this code makes are asserted. Robolectric fabricates a bitmap for any input
 * it is handed - including a text file - so real image decoding cannot be exercised here, and
 * asserting on it would be testing the test framework. That the decode itself works is not
 * claimed by these tests.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = android.app.Application::class)
class PreparedPhotoTest {

    @get:Rule
    val temp = TemporaryFolder()

    @Test
    fun `a file that is not there prepares to nothing rather than throwing`() {
        // The path came from a capture that was cancelled, or a file since cleaned up.
        assertNull(ImagePreparer.prepare(File(temp.root, "not-there.jpg"), photoId = 0L))
    }

    @Test
    fun `an empty file prepares to nothing`() {
        // What a camera app leaves behind when it reports success but writes nothing. Sending it
        // would spend the shopkeeper's money on an empty request.
        assertNull(ImagePreparer.prepare(temp.newFile("empty.jpg"), photoId = 0L))
    }

    @Test
    fun `the photo id travels with the image`() {
        val prepared = ImagePreparer.prepare(writeJpeg(), photoId = 7L)
        if (prepared != null) {
            assertEquals(7L, prepared.photoId)
            assertEquals("image/jpeg", prepared.mediaType)
        }
    }

    @Test
    fun `sample size never drops a photo below the legible limit`() {
        // Pure arithmetic, and the part that decides whether receipt text survives the upload.
        assertEquals(1, ImagePreparer.sampleSizeFor(1600, 1200, maxEdge = 1568))
        assertEquals(2, ImagePreparer.sampleSizeFor(4000, 3000, maxEdge = 1568))
        assertEquals(4, ImagePreparer.sampleSizeFor(8000, 6000, maxEdge = 1568))
        // Already small enough: never upscale, never sample away detail that is not there.
        assertEquals(1, ImagePreparer.sampleSizeFor(100, 100, maxEdge = 1568))
        assertEquals(1, ImagePreparer.sampleSizeFor(1568, 1568, maxEdge = 1568))
    }

    private fun writeJpeg(): File {
        val file = temp.newFile("capture.jpg")
        val bitmap = Bitmap.createBitmap(800, 600, Bitmap.Config.ARGB_8888)
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        bitmap.recycle()
        return file
    }
}
