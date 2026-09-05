package com.grocerypricer.core

/**
 * Realistic wholesale receipt text used across the parser tests. The numbers are the ones the
 * store owner supplied, so the expected costs in the tests are the real-world answers.
 */
object SampleReceipts {

    val JETRO_PAGE_ONE = """
        JETRO CASH & CARRY
        INVOICE 884213    09/04/26
        HELLM MAYONNAISE 8Z
        CASE ${'$'}33.99 SIZE 12 UNIT ${'$'}2.83
        Flyer 43 - HELLM MAYONNAISE
        -${'$'}8.00
        R&W OIL VEGETABLE 48Z
        CASE ${'$'}39.25 SIZE 9 UNIT ${'$'}4.36
        KELL FROOT LOOP FM 13.2Z
        CASE ${'$'}57.59 SIZE 10 UNIT ${'$'}5.76
        Flyer 43 - KELLOGGS FROOT LOOPS
        -${'$'}12.00
        SUB TOTAL   ${'$'}130.83
    """.trimIndent()

    /** Same shape, but with the character confusions ML Kit typically produces. */
    val JETRO_MESSY_OCR = """
        HELLM MAYONNAISE 8Z
        CASE S33.99 SIZE l2 UNIT S2.83
    """.trimIndent()

    /** Three cases of one product, with the quantity printed on its own line. */
    val JETRO_MULTI_CASE = """
        HELLM MAYONNAISE 8Z
        CASE ${'$'}33.99 SIZE 12 UNIT ${'$'}2.83
        UNITS 1  CASES 3
    """.trimIndent()

    /** A discount whose flyer text names a completely different product. */
    val JETRO_MISMATCHED_DISCOUNT = """
        R&W OIL VEGETABLE 48Z
        CASE ${'$'}39.25 SIZE 9 UNIT ${'$'}4.36
        Flyer 51 - TIDE ORIGINAL 40Z
        -${'$'}5.00
    """.trimIndent()

    /** The tail of photo one, repeated at the head of photo two. */
    val PHOTO_ONE = """
        R&W OIL VEGETABLE 48Z
        CASE ${'$'}39.25 SIZE 9 UNIT ${'$'}4.36
        KELL FROOT LOOP FM 13.2Z
        CASE ${'$'}57.59 SIZE 10 UNIT ${'$'}5.76
    """.trimIndent()

    val PHOTO_TWO = """
        KELL FROOT LOOP FM 13.2Z
        CASE ${'$'}57.59 SIZE 10 UNIT ${'$'}5.76
        DOWNY ULTRA APRIL FRESH 10Z
        CASE ${'$'}19.74 SIZE 6 UNIT ${'$'}3.29
    """.trimIndent()
}
