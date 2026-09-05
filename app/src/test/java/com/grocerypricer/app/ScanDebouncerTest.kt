package com.grocerypricer.app

import com.grocerypricer.app.scanner.ScanDebouncer
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScanDebouncerTest {

    private var now = 0L
    private val debouncer = ScanDebouncer(repeatWindowMillis = 2_000L, clock = { now })

    @Test
    fun `the first read of a barcode is accepted`() {
        assertTrue(debouncer.accept("048001215252"))
    }

    @Test
    fun `holding the phone on the same barcode does not fire again`() {
        assertTrue(debouncer.accept("048001215252"))
        now += 200
        assertFalse(debouncer.accept("048001215252"))
        now += 500
        assertFalse(debouncer.accept("048001215252"))
    }

    @Test
    fun `a different product is accepted immediately`() {
        assertTrue(debouncer.accept("048001215252"))
        now += 100
        assertTrue(debouncer.accept("038000199172"))
    }

    @Test
    fun `the same barcode is accepted again once the window has passed`() {
        assertTrue(debouncer.accept("048001215252"))
        now += 2_500
        assertTrue(debouncer.accept("048001215252"))
    }

    @Test
    fun `resetting lets the employee rescan the item they just priced`() {
        assertTrue(debouncer.accept("048001215252"))
        now += 100
        assertFalse(debouncer.accept("048001215252"))
        debouncer.reset()
        assertTrue(debouncer.accept("048001215252"))
    }
}
