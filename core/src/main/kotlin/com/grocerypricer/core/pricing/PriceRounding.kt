package com.grocerypricer.core.pricing

import com.grocerypricer.core.model.PriceEnding
import com.grocerypricer.core.money.Money
import java.math.BigDecimal
import java.math.RoundingMode

/**
 * Applies a configured price ending to a target price.
 *
 * This is not "round to the nearest .99". The pricing rules decide the target first; this then
 * moves the target up to the next price that ends the way the store wants. $5.16 becomes $5.99,
 * $7.12 becomes $7.99, and a price that already ends correctly is left alone.
 */
object PriceRounding {

    fun applyEnding(target: Money, ending: PriceEnding): Money {
        if (!target.isPositive) return Money.ZERO
        val dollars = target.amount.setScale(0, RoundingMode.FLOOR)
        val endingPart = BigDecimal(ending.cents).movePointLeft(2)
        var candidate = Money.of(dollars.add(endingPart))
        if (candidate < target) {
            candidate = Money.of(dollars.add(BigDecimal.ONE).add(endingPart))
        }
        return candidate.roundedToCents()
    }

    /** Moves a price up or down by whole dollars, keeping its ending. Used by category rules. */
    fun step(price: Money, steps: Int, ending: PriceEnding): Money {
        if (steps == 0) return price
        val moved = price + Money.of(BigDecimal(steps))
        return if (moved.isPositive) applyEnding(moved, ending) else Money.ZERO
    }
}
