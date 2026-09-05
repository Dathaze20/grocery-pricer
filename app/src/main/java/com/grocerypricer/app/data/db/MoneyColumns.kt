package com.grocerypricer.app.data.db

import com.grocerypricer.core.money.Money

/**
 * Money is stored as a whole number of ten-thousandths of a dollar in a `Long` column.
 *
 * Keeping it integral means a save/load round trip is exact, and it side-steps Room type
 * converters for a Kotlin value class. All conversion happens here so no other layer has to
 * think about it.
 */
fun Money?.toColumn(): Long? = this?.toStorageLong()

fun Money.toColumnRequired(): Long = toStorageLong()

fun Long?.toMoneyOrNull(): Money? = this?.let { Money.fromStorageLong(it) }

fun Long.toMoney(): Money = Money.fromStorageLong(this)
