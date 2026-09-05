package com.grocerypricer.core.matching

import java.math.BigDecimal
import java.math.RoundingMode

/** A package size reduced to a comparable value + unit, e.g. `13.2Z` -> `13.2 OZ`. */
data class PackageSize(val value: BigDecimal, val unit: SizeUnit) {
    val canonical: String
        get() = value.stripTrailingZeros().toPlainString() + " " + unit.display

    /** Sizes only match when both the number and the unit agree. 8 oz is not 15 oz. */
    fun matches(other: PackageSize): Boolean =
        unit == other.unit && value.compareTo(other.value) == 0
}

enum class SizeUnit(val display: String, val aliases: List<String>) {
    OZ("OZ", listOf("oz", "ozs", "ounce", "ounces", "z", "flo z", "floz", "fl oz", "fluid ounce")),
    LB("LB", listOf("lb", "lbs", "pound", "pounds", "#")),
    GRAM("G", listOf("g", "gr", "gram", "grams")),
    KILOGRAM("KG", listOf("kg", "kgs", "kilogram", "kilograms")),
    ML("ML", listOf("ml", "mls", "milliliter", "millilitre")),
    LITER("L", listOf("l", "lt", "ltr", "liter", "litre", "liters")),
    COUNT("CT", listOf("ct", "cnt", "count", "pk", "pack", "ea", "each", "roll", "rolls", "sheets")),
    GALLON("GAL", listOf("gal", "gallon", "gallons")),
    QUART("QT", listOf("qt", "quart", "quarts")),
    PINT("PT", listOf("pt", "pint", "pints"));

    companion object {
        fun fromToken(token: String): SizeUnit? {
            val cleaned = token.lowercase().trim().trim('.', ',', ')', '(')
            if (cleaned.isEmpty()) return null
            return entries.firstOrNull { unit -> unit.aliases.any { it == cleaned } }
        }
    }
}

/**
 * Pulls a package size out of free text such as `HELLM MAYONNAISE 8Z` or `DOWNY 10 FL OZ`.
 *
 * Size is load-bearing for product matching - Tide 25 oz and Tide 40 oz are different products -
 * so this returns null rather than guessing when nothing clear is present.
 */
object SizeParser {

    // "10 FL OZ", "13.2 OZ", "8Z", "750ML", "2 LB", "12 CT"
    private val SIZE_PATTERN = Regex(
        "(?<![0-9.])([0-9]+(?:\\.[0-9]+)?)\\s*(fl\\.?\\s*oz|floz|oz|ozs|lbs|lb|kgs|kg|gal|qt|pt|ml|ltr|ct|cnt|pk|pack|count|rolls|roll|g|l|z)\\b",
        RegexOption.IGNORE_CASE,
    )

    fun parse(text: String?): PackageSize? {
        if (text.isNullOrBlank()) return null
        val matches = SIZE_PATTERN.findAll(text).toList()
        if (matches.isEmpty()) return null
        // Receipt descriptions put the size last ("KELL FROOT LOOP FM 13.2Z"), so prefer the
        // right-most match when a product name happens to contain another number.
        val match = matches.last()
        val rawValue = match.groupValues[1]
        val rawUnit = match.groupValues[2].lowercase().replace(".", "").replace(" ", "")
        val unit = SizeUnit.fromToken(rawUnit) ?: return null
        return try {
            PackageSize(BigDecimal(rawValue).setScale(3, RoundingMode.HALF_UP).stripTrailingZeros(), unit)
        } catch (e: NumberFormatException) {
            null
        }
    }

    /** The size portion of a description, as text, for display and storage. */
    fun canonicalOrNull(text: String?): String? = parse(text)?.canonical

    /** Removes the size from a description so the remaining words can be name-matched. */
    fun stripSize(text: String): String =
        SIZE_PATTERN.replace(text, " ").replace(Regex(" {2,}"), " ").trim()
}
