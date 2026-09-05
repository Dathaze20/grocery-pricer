package com.grocerypricer.core.money

import java.math.BigDecimal
import java.math.RoundingMode

/**
 * Money-safe amount backed by [BigDecimal].
 *
 * Every instance is normalised to [INTERNAL_SCALE] decimal places so that equality and hashing
 * behave the way callers expect (`$2.50 == $2.5`), while still keeping enough precision to divide
 * a case cost across its retail units without losing fractions of a cent.
 *
 * Nothing in the pricing pipeline is allowed to use `Double`/`Float` for currency.
 */
@JvmInline
value class Money private constructor(val amount: BigDecimal) : Comparable<Money> {

    operator fun plus(other: Money): Money = of(amount.add(other.amount))

    operator fun minus(other: Money): Money = of(amount.subtract(other.amount))

    operator fun unaryMinus(): Money = of(amount.negate())

    operator fun times(quantity: Int): Money = of(amount.multiply(BigDecimal(quantity)))

    operator fun times(factor: BigDecimal): Money = of(amount.multiply(factor))

    /** Divides across [parts], keeping [INTERNAL_SCALE] precision (e.g. $45.59 / 10 = $4.5590). */
    fun divideBy(parts: Int): Money {
        require(parts > 0) { "Cannot divide money into $parts parts" }
        return of(amount.divide(BigDecimal(parts), INTERNAL_SCALE, RoundingMode.HALF_UP))
    }

    fun divideBy(divisor: BigDecimal): Money {
        require(divisor.signum() != 0) { "Cannot divide money by zero" }
        return of(amount.divide(divisor, INTERNAL_SCALE, RoundingMode.HALF_UP))
    }

    /** Ratio of this amount to [other], as a plain [BigDecimal] (not money). */
    fun ratioTo(other: Money): BigDecimal? {
        if (other.isZero) return null
        return amount.divide(other.amount, RATIO_SCALE, RoundingMode.HALF_UP)
    }

    /** The amount a customer actually sees: two decimal places, half-up. */
    fun roundedToCents(): Money = of(amount.setScale(DISPLAY_SCALE, RoundingMode.HALF_UP))

    val isZero: Boolean get() = amount.signum() == 0
    val isNegative: Boolean get() = amount.signum() < 0
    val isPositive: Boolean get() = amount.signum() > 0

    fun abs(): Money = if (isNegative) -this else this

    fun coerceAtLeastZero(): Money = if (isNegative) ZERO else this

    /** Whole cents, rounded half-up. Used for storage in Room and for backups. */
    fun toCents(): Long = amount.setScale(DISPLAY_SCALE, RoundingMode.HALF_UP).movePointRight(2).toLong()

    /** Exact stored value in tenths of a cent, so no precision is lost across a save/load cycle. */
    fun toStorageLong(): Long = amount.movePointRight(INTERNAL_SCALE).toLong()

    /** `4.56` — no currency symbol, always two decimals. Use for CSV export. */
    fun toPlainString(): String = amount.setScale(DISPLAY_SCALE, RoundingMode.HALF_UP).toPlainString()

    /** `$4.56` — what the user reads on screen. */
    fun format(): String {
        val rounded = amount.setScale(DISPLAY_SCALE, RoundingMode.HALF_UP)
        return if (rounded.signum() < 0) "-$" + rounded.negate().toPlainString() else "$" + rounded.toPlainString()
    }

    /** `$4.5590` — for the few places where the extra precision matters to the user. */
    fun formatPrecise(): String = "$" + amount.toPlainString()

    override fun compareTo(other: Money): Int = amount.compareTo(other.amount)

    override fun toString(): String = format()

    companion object {
        /** Tenths of a cent. Enough to divide a case across up to a few hundred units. */
        const val INTERNAL_SCALE = 4
        const val DISPLAY_SCALE = 2
        const val RATIO_SCALE = 6

        val ZERO: Money = of(BigDecimal.ZERO)

        fun of(value: BigDecimal): Money = Money(value.setScale(INTERNAL_SCALE, RoundingMode.HALF_UP))

        fun of(value: Int): Money = of(BigDecimal(value))

        fun of(value: String): Money = of(BigDecimal(value.trim()))

        fun ofCents(cents: Long): Money = of(BigDecimal.valueOf(cents, 2))

        fun fromStorageLong(raw: Long): Money = of(BigDecimal.valueOf(raw, INTERNAL_SCALE))

        /**
         * Best-effort parse of a value lifted out of OCR text. Tolerates `$`, thousands separators,
         * trailing/leading junk and parenthesised negatives. Returns null rather than guessing.
         */
        fun parseOrNull(raw: String?): Money? {
            if (raw.isNullOrBlank()) return null
            var text = raw.trim()
            var negative = false
            if (text.startsWith("(") && text.endsWith(")")) {
                negative = true
                text = text.substring(1, text.length - 1)
            }
            if (text.startsWith("-")) {
                negative = true
                text = text.substring(1)
            }
            text = text.replace("$", "").replace(",", "").replace(" ", "").trim()
            if (text.isEmpty()) return null
            if (!text.matches(Regex("^\\d*(\\.\\d+)?$"))) return null
            if (text.startsWith(".")) text = "0$text"
            if (text.endsWith(".")) text = text.dropLast(1)
            if (text.isEmpty()) return null
            return try {
                val value = of(BigDecimal(text))
                if (negative) -value else value
            } catch (e: NumberFormatException) {
                null
            }
        }

        fun sum(values: Iterable<Money>): Money =
            values.fold(ZERO) { acc, money -> acc + money }
    }
}
