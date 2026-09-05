package com.grocerypricer.core.parser

/** A cleaned-up line plus a note of whether cleaning had to touch anything. */
data class NormalizedLine(
    val original: String,
    val text: String,
    val correctedCharacters: Boolean,
)

/**
 * Cleans up the characters OCR most often gets wrong on a receipt, without ever inventing digits.
 *
 * Corrections are only applied inside tokens that are already mostly numeric, so `SIZE` is never
 * turned into `5IZE` and a product name keeps its letters. When anything is corrected the line is
 * marked so the parsed row can be flagged for a human to glance at.
 */
object OcrTextNormalizer {

    private val MONEY_LOOKALIKE = Regex("^[Ss]([0-9]+\\.[0-9]{2})$")
    private val DIGIT_COMMA_DECIMAL = Regex("^([0-9]+),([0-9]{2})$")

    fun normalize(raw: String): NormalizedLine {
        val collapsed = raw
            .replace('\u00A0', ' ')
            .replace(Regex("[\\t\\u000B\\f\\r]"), " ")
            .replace(Regex(" {2,}"), " ")
            .trim()

        if (collapsed.isEmpty()) return NormalizedLine(raw, "", false)

        var corrected = false
        val rebuilt = collapsed.split(" ").joinToString(" ") { token ->
            val fixed = fixToken(token)
            if (fixed != token) corrected = true
            fixed
        }

        // "$ 33.99" -> "$33.99" so downstream patterns only have to handle one shape.
        val tightened = rebuilt.replace(Regex("\\$\\s+(?=[0-9])")) { "$" }
        return NormalizedLine(raw, tightened, corrected)
    }

    fun normalizeAll(rawLines: List<String>): List<NormalizedLine> =
        rawLines.map { normalize(it) }.filter { it.text.isNotEmpty() }

    private fun fixToken(token: String): String {
        // A dollar sign misread as a capital S: "S2.83" is a price, not a word.
        MONEY_LOOKALIKE.matchEntire(token)?.let { return "$" + it.groupValues[1] }

        // European-style comma decimal from a smudged point: "33,99" -> "33.99".
        DIGIT_COMMA_DECIMAL.matchEntire(token)?.let { return it.groupValues[1] + "." + it.groupValues[2] }

        if (!isMostlyNumeric(token)) return token

        val builder = StringBuilder(token.length)
        token.forEachIndexed { index, ch ->
            builder.append(
                when {
                    ch == 'O' || ch == 'o' -> '0'
                    ch == 'I' || ch == 'l' || ch == '|' -> '1'
                    ch == 'B' -> '8'
                    // 'S' only mid-token; a leading S is far more likely to be a dollar sign.
                    (ch == 'S' || ch == 's') && index > 0 -> '5'
                    else -> ch
                }
            )
        }
        return builder.toString()
    }

    /**
     * True when a token is already carrying enough digits that the remaining letters are almost
     * certainly misread digits (`1O.5O`), rather than a word.
     */
    private fun isMostlyNumeric(token: String): Boolean {
        val core = token.trim('$', ',', '.', '-', '(', ')', ':', '#', '*')
            .filter { it != '.' && it != ',' }
        if (core.length < 2) return false
        val digits = core.count { it.isDigit() }
        val lookalikes = core.count { it in LOOKALIKE_CHARS }
        if (digits == 0) return false
        if (digits + lookalikes != core.length) return false
        return digits.toDouble() / core.length >= 0.5
    }

    private val LOOKALIKE_CHARS = charArrayOf('O', 'o', 'I', 'l', '|', 'B', 'S', 's')
}
