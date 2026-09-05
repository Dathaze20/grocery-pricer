package com.grocerypricer.core.matching

/**
 * Reduces a product description to comparable tokens.
 *
 * Wholesale receipts abbreviate hard (`HELLM MAYONNAISE 8Z`, `KELL FROOT LOOP FM 13.2Z`), so
 * normalisation strips punctuation and packaging noise but deliberately keeps brand fragments -
 * they carry most of the signal.
 */
object NameNormalizer {

    private val NOISE_WORDS = setOf(
        "the", "and", "of", "with", "for", "size", "case", "unit", "units", "pack", "pk",
        "ea", "each", "ct", "count", "fm", "asst", "assorted", "reg", "regular", "new",
    )

    private val POSSESSIVE = Regex("['\u2019]s\\b", RegexOption.IGNORE_CASE)
    private val PUNCTUATION = Regex("[^A-Za-z0-9 ]")
    private val MULTISPACE = Regex(" {2,}")

    /** Uppercase, punctuation-free, size-free, noise-free. Empty when nothing meaningful is left. */
    fun normalize(raw: String?): String {
        if (raw.isNullOrBlank()) return ""
        val withoutSize = SizeParser.stripSize(raw)
        val cleaned = PUNCTUATION.replace(POSSESSIVE.replace(withoutSize, ""), " ")
            .uppercase()
            .let { MULTISPACE.replace(it, " ") }
            .trim()
        return cleaned.split(" ")
            .filter { it.isNotBlank() && it.lowercase() !in NOISE_WORDS }
            .joinToString(" ")
    }

    fun tokens(raw: String?): List<String> =
        normalize(raw).split(" ").filter { it.isNotBlank() }

    /**
     * 0.0 - 1.0 similarity built from shared tokens plus a character-level comparison, so
     * `HELLM MAYONNAISE` and `HELLMANNS MAYONNAISE` score highly while `TIDE` and `TIDY` do not.
     */
    fun similarity(a: String?, b: String?): Double {
        val tokensA = tokens(a)
        val tokensB = tokens(b)
        if (tokensA.isEmpty() || tokensB.isEmpty()) return 0.0

        val matchedA = tokensA.count { tokenA -> tokensB.any { tokensAlike(tokenA, it) } }
        val matchedB = tokensB.count { tokenB -> tokensA.any { tokensAlike(tokenB, it) } }
        val tokenScore = (matchedA + matchedB).toDouble() / (tokensA.size + tokensB.size)

        val charScore = levenshteinRatio(normalize(a), normalize(b))
        return (tokenScore * 0.7) + (charScore * 0.3)
    }

    /** Two tokens count as the same word when one is a prefix of the other (`HELLM` / `HELLMANNS`). */
    fun tokensAlike(a: String, b: String): Boolean {
        if (a == b) return true
        val shorter = if (a.length <= b.length) a else b
        val longer = if (a.length <= b.length) b else a
        if (shorter.length < 3) return false
        if (longer.startsWith(shorter)) return true
        return levenshteinRatio(a, b) >= 0.85
    }

    fun levenshteinRatio(a: String, b: String): Double {
        if (a.isEmpty() && b.isEmpty()) return 1.0
        if (a.isEmpty() || b.isEmpty()) return 0.0
        val distance = levenshtein(a, b)
        val longest = maxOf(a.length, b.length)
        return 1.0 - (distance.toDouble() / longest)
    }

    fun levenshtein(a: String, b: String): Int {
        var previous = IntArray(b.length + 1) { it }
        var current = IntArray(b.length + 1)
        for (i in 1..a.length) {
            current[0] = i
            for (j in 1..b.length) {
                val substitution = previous[j - 1] + if (a[i - 1] == b[j - 1]) 0 else 1
                current[j] = minOf(current[j - 1] + 1, previous[j] + 1, substitution)
            }
            val swap = previous
            previous = current
            current = swap
        }
        return previous[b.length]
    }
}
