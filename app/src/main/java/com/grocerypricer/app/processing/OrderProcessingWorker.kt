package com.grocerypricer.app.processing

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.grocerypricer.app.GroceryPricerApplication
import com.grocerypricer.app.MainActivity
import com.grocerypricer.app.R

/**
 * Reads an order in the background, so the shopkeeper can put the phone in their pocket.
 *
 * A whole Jetro order is a few minutes of work. Making somebody stand and watch a spinner for that
 * long is the software managing the user, which is the thing V2 is trying to stop doing.
 *
 * This is a plain worker rather than an expedited or foreground one. A foreground service would
 * need `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_DATA_SYNC`, a service declaration and a
 * persistent notification, and it fails in several device-specific ways that are hard to get right
 * without a device to test on. A normal worker gets a generous run window - far more than an order
 * needs - for none of that risk.
 */
class OrderProcessingWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val orderId = inputData.getLong(KEY_ORDER_ID, 0L)
        if (orderId <= 0L) return Result.failure()

        val container = (applicationContext as? GroceryPricerApplication)?.container
            ?: return Result.failure()

        val provider = container.aiProviderOrNull()
            ?: return Result.failure(workDataOf(KEY_ERROR to "no_key"))

        container.orderRepository.markProcessing(orderId)
        val settings = container.settingsRepository.current()

        val outcome = container.orderProcessor.process(
            orderId = orderId,
            provider = provider,
            supplierHint = settings.defaultSupplier,
            onStage = { stage ->
                // Reported as progress rather than a notification update: the screen shows it
                // when it is open, and a notification that changes every few seconds is noise.
                setProgressAsync(workDataOf(KEY_STAGE to stage.name))
            },
        )

        return when (outcome) {
            is ProcessingOutcome.Success -> {
                notify(
                    orderId = orderId,
                    title = "Order ready",
                    body = outcome.itemsFound.toString() + " products found. Tap to ask about them.",
                )
                Result.success(workDataOf(KEY_ITEMS_FOUND to outcome.itemsFound))
            }

            is ProcessingOutcome.Failed -> {
                notify(
                    orderId = orderId,
                    title = "Grocery Pricer could not finish",
                    body = outcome.error.userMessage(),
                )
                Result.failure(workDataOf(KEY_ERROR to outcome.error::class.java.simpleName))
            }

            ProcessingOutcome.NothingToRead ->
                Result.failure(workDataOf(KEY_ERROR to "nothing_readable"))
        }
    }

    /**
     * Best effort on purpose.
     *
     * From Android 13 notifications need a runtime permission the user may well have declined,
     * and being told about a finished order is a convenience, not the feature. If it cannot be
     * posted, the order is still ready and the app still shows it.
     */
    private fun notify(orderId: Long, title: String, body: String) {
        val context = applicationContext
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ActivityCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }

        val manager = NotificationManagerCompat.from(context)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Order processing",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply { description = "Tells you when a wholesale order has finished processing." },
            )
        }

        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_ORDER_ID, orderId)
        }
        val pending = PendingIntent.getActivity(
            context,
            orderId.toInt(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        try {
            manager.notify(
                orderId.toInt(),
                NotificationCompat.Builder(context, CHANNEL_ID)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                    .setContentIntent(pending)
                    .setAutoCancel(true)
                    .build(),
            )
        } catch (e: SecurityException) {
            // Permission revoked between the check and the post. Nothing to do about it.
        }
    }

    companion object {
        const val KEY_ORDER_ID = "orderId"
        const val KEY_STAGE = "stage"
        const val KEY_ITEMS_FOUND = "itemsFound"
        const val KEY_ERROR = "error"
        const val EXTRA_ORDER_ID = "com.grocerypricer.app.ORDER_ID"

        private const val CHANNEL_ID = "order_processing"

        fun uniqueNameFor(orderId: Long): String = "process_order_$orderId"

        /**
         * The order an "order ready" notification refers to, or null for any other launch.
         *
         * Lives here rather than in the Activity so the Activity has no bespoke parsing of its
         * own, and so the rule that zero is not an order id is written down exactly once.
         */
        fun orderIdFrom(intent: Intent?): Long? =
            intent?.getLongExtra(EXTRA_ORDER_ID, 0L)?.takeIf { it > 0L }

        /**
         * Queues one order. Pressing PROCESS ORDER twice keeps the run already going rather than
         * starting a second one, which would pay the provider twice for the same photographs.
         */
        fun enqueue(context: Context, orderId: Long) {
            val request = OneTimeWorkRequestBuilder<OrderProcessingWorker>()
                .setInputData(Data.Builder().putLong(KEY_ORDER_ID, orderId).build())
                .addTag(uniqueNameFor(orderId))
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                uniqueNameFor(orderId),
                ExistingWorkPolicy.KEEP,
                request,
            )
        }
    }
}
