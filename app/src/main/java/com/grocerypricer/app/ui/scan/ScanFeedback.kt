package com.grocerypricer.app.ui.scan

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * The short buzz and beep that tell the employee a scan landed, without them having to look.
 * Both are opt-in from Settings.
 */
class ScanFeedback(private val context: Context) {

    private val vibrator: Vibrator? by lazy {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val manager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                manager?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
        } catch (e: Exception) {
            null
        }
    }

    fun success(vibrate: Boolean, sound: Boolean) {
        if (vibrate) buzz(40)
        if (sound) beep(ToneGenerator.TONE_PROP_BEEP, 120)
    }

    fun approved(vibrate: Boolean, sound: Boolean) {
        if (vibrate) buzz(80)
        if (sound) beep(ToneGenerator.TONE_PROP_ACK, 150)
    }

    private fun buzz(millis: Long) {
        val device = vibrator ?: return
        if (!device.hasVibrator()) return
        runCatching {
            device.vibrate(VibrationEffect.createOneShot(millis, VibrationEffect.DEFAULT_AMPLITUDE))
        }
    }

    private fun beep(tone: Int, durationMillis: Int) {
        runCatching {
            val generator = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80)
            generator.startTone(tone, durationMillis)
            android.os.Handler(android.os.Looper.getMainLooper())
                .postDelayed({ runCatching { generator.release() } }, (durationMillis + 100).toLong())
        }
    }
}
