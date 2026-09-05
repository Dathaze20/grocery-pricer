package com.grocerypricer.core

import com.grocerypricer.core.money.Money
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigDecimal

class MoneyTest {

    @Test
    fun `amounts with different trailing zeros are equal`() {
        assertEquals(Money.of("2.5"), Money.of("2.50"))
        assertEquals(Money.of("2.5").hashCode(), Money.of("2.50").hashCode())
    }

    @Test
    fun `addition and subtraction stay exact`() {
        var total = Money.ZERO
        repeat(10) { total += Money.of("0.10") }
        assertEquals(Money.of("1.00"), total)
        assertEquals(Money.of("0.00"), Money.of("0.30") - Money.of("0.10") - Money.of("0.20"))
    }

    @Test
    fun `division keeps four decimal places of precision`() {
        // The Froot Loops case: $45.59 across 10 units is $4.559 each, not $4.56 internally.
        val unit = Money.of("45.59").divideBy(10)
        assertEquals("4.5590", unit.amount.toPlainString())
        assertEquals("$4.56", unit.format())
    }

    @Test
    fun `display rounding is half up at two decimals`() {
        assertEquals("$2.17", Money.of("2.1658").format())
        assertEquals("$4.56", Money.of("4.5590").format())
        assertEquals("$2.83", Money.of("2.8325").format())
    }

    @Test
    fun `negative amounts format with the sign before the symbol`() {
        assertEquals("-$8.00", (-Money.of("8.00")).format())
        assertTrue((-Money.of("8.00")).isNegative)
        assertFalse(Money.ZERO.isNegative)
    }

    @Test
    fun `parseOrNull tolerates receipt noise but never guesses`() {
        assertEquals(Money.of("33.99"), Money.parseOrNull("${'$'}33.99"))
        assertEquals(Money.of("1234.50"), Money.parseOrNull("${'$'}1,234.50"))
        assertEquals(Money.of("8.00"), Money.parseOrNull(" 8.00 "))
        assertEquals(-Money.of("8.00"), Money.parseOrNull("-${'$'}8.00"))
        assertEquals(-Money.of("8.00"), Money.parseOrNull("(8.00)"))
        assertEquals(Money.of("0.50"), Money.parseOrNull(".50"))

        assertNull(Money.parseOrNull(null))
        assertNull(Money.parseOrNull(""))
        assertNull(Money.parseOrNull("CASE"))
        assertNull(Money.parseOrNull("12.34.56"))
    }

    @Test
    fun `storage round trip loses nothing`() {
        val original = Money.of("4.5590")
        assertEquals(original, Money.fromStorageLong(original.toStorageLong()))
        assertEquals(456L, Money.of("4.5590").toCents())
    }

    @Test
    fun `multiplication by a case count is exact`() {
        assertEquals(Money.of("101.97"), Money.of("33.99") * 3)
        assertEquals(Money.of("13.6740"), Money.of("4.5580") * BigDecimal("3"))
    }

    @Test
    fun `coerceAtLeastZero clamps an over-large discount`() {
        assertEquals(Money.ZERO, (Money.of("5.00") - Money.of("9.00")).coerceAtLeastZero())
    }

    @Test
    fun `sum folds a list`() {
        assertEquals(Money.of("6.00"), Money.sum(listOf(Money.of("1.00"), Money.of("2.00"), Money.of("3.00"))))
        assertEquals(Money.ZERO, Money.sum(emptyList()))
    }
}
