package com.grocerypricer.app.scanner

/**
 * Stops the same barcode firing over and over while the phone is still pointed at it.
 *
 * Pure logic with an injected clock so it can be tested without a camera.
 */
class ScanDebouncer(
    private val repeatWindowMillis: Long = DEFAULT_WINDOW_MILLIS,
    private val clock: () -> Long = System::currentTimeMillis,
) {

    private var lastValue: String? = null
    private var lastAcceptedAt: Long = 0L

    /** True when this read should be acted on. */
    fun accept(value: String): Boolean {
        val nowMillis = clock()
        val isRepeat = value == lastValue && nowMillis - lastAcceptedAt < repeatWindowMillis
        if (isRepeat) return false
        lastValue = value
        lastAcceptedAt = nowMillis
        return true
    }

    /** Called once the user finishes with a product, so the same item can be scanned again. */
    fun reset() {
        lastValue = null
        lastAcceptedAt = 0L
    }

    companion object {
        const val DEFAULT_WINDOW_MILLIS = 2500L
    }
}
