package com.grocerypricer.core.matching

/** Anything the matcher can look at. Room entities in the app implement this. */
interface MatchableProduct {
    val productId: Long
    val upc: String?
    val supplierSku: String?
    val name: String
    val size: String?
}

/** A lightweight matchable, for callers that are not backed by a database row. */
data class SimpleMatchable(
    override val productId: Long,
    override val upc: String? = null,
    override val supplierSku: String? = null,
    override val name: String,
    override val size: String? = null,
) : MatchableProduct

data class ProductQuery(
    val upc: String? = null,
    val supplierSku: String? = null,
    val name: String? = null,
    val size: String? = null,
)

enum class MatchMethod(val displayName: String) {
    UPC("Barcode"),
    SUPPLIER_SKU("Supplier item number"),
    NAME_AND_SIZE("Name and size"),
    FUZZY_NAME("Similar name"),
}

enum class SizeRelation { MATCH, MISMATCH, UNKNOWN }

data class ProductMatch(
    val product: MatchableProduct,
    val method: MatchMethod,
    val score: Double,
    val sizeRelation: SizeRelation,
)

sealed interface MatchOutcome {
    /** Safe to use without asking. */
    data class Confident(val match: ProductMatch) : MatchOutcome

    /** Plausible, but the user has to choose. */
    data class Ambiguous(val candidates: List<ProductMatch>) : MatchOutcome

    data object NoMatch : MatchOutcome
}

/**
 * Finds the product a barcode, receipt line or label photo refers to.
 *
 * Priority is barcode, then supplier item number, then an exact normalised name + size, then a
 * fuzzy name comparison. Package size is load-bearing: Tide 25 oz and Tide 40 oz are different
 * products and are never merged just because the names read alike.
 */
object ProductMatcher {

    /** A fuzzy name only auto-resolves above this, and only when it is the single best candidate. */
    const val CONFIDENT_SCORE = 0.88

    /** Below this a candidate is not even worth showing. */
    const val CANDIDATE_SCORE = 0.45

    private const val MAX_CANDIDATES = 8

    fun match(query: ProductQuery, candidates: List<MatchableProduct>): MatchOutcome {
        if (candidates.isEmpty()) return MatchOutcome.NoMatch

        normalizeUpc(query.upc)?.let { wanted ->
            val hits = candidates.filter { upcEquivalent(normalizeUpc(it.upc), wanted) }
            if (hits.size == 1) {
                return MatchOutcome.Confident(ProductMatch(hits.first(), MatchMethod.UPC, 1.0, sizeRelation(query.size, hits.first().size)))
            }
            if (hits.size > 1) {
                return MatchOutcome.Ambiguous(hits.map { ProductMatch(it, MatchMethod.UPC, 1.0, sizeRelation(query.size, it.size)) })
            }
        }

        query.supplierSku?.trim()?.takeIf { it.isNotEmpty() }?.let { wanted ->
            val hits = candidates.filter { it.supplierSku?.trim().equals(wanted, ignoreCase = true) }
            if (hits.size == 1) {
                return MatchOutcome.Confident(ProductMatch(hits.first(), MatchMethod.SUPPLIER_SKU, 1.0, sizeRelation(query.size, hits.first().size)))
            }
        }

        val queryName = query.name
        if (queryName.isNullOrBlank()) return MatchOutcome.NoMatch
        val normalizedQuery = NameNormalizer.normalize(queryName)
        if (normalizedQuery.isBlank()) return MatchOutcome.NoMatch

        val exact = candidates.filter {
            NameNormalizer.normalize(it.name) == normalizedQuery &&
                sizeRelation(query.size, it.size) == SizeRelation.MATCH
        }
        if (exact.size == 1) {
            return MatchOutcome.Confident(ProductMatch(exact.first(), MatchMethod.NAME_AND_SIZE, 1.0, SizeRelation.MATCH))
        }

        val scored = candidates.mapNotNull { candidate ->
            val relation = sizeRelation(query.size, candidate.size)
            val base = NameNormalizer.similarity(queryName, candidate.name)
            // A different pack size is a hard signal that this is a different product.
            val score = if (relation == SizeRelation.MISMATCH) base * 0.5 else base
            if (score < CANDIDATE_SCORE) null
            else ProductMatch(candidate, MatchMethod.FUZZY_NAME, score, relation)
        }.sortedByDescending { it.score }

        if (scored.isEmpty()) return MatchOutcome.NoMatch

        val best = scored.first()
        val runnerUp = scored.getOrNull(1)
        val clearWinner = runnerUp == null || best.score - runnerUp.score >= 0.05
        if (best.score >= CONFIDENT_SCORE && best.sizeRelation != SizeRelation.MISMATCH && clearWinner) {
            return MatchOutcome.Confident(best)
        }
        return MatchOutcome.Ambiguous(scored.take(MAX_CANDIDATES))
    }

    /**
     * Matching from words read off a product label, used when no barcode is visible.
     * This deliberately only ever returns candidates unless a barcode-grade signal is present -
     * an uncertain product is shown to the user, never picked silently.
     */
    fun matchFromLabelText(labelText: String, candidates: List<MatchableProduct>): MatchOutcome {
        val cleaned = labelText.split("\n").joinToString(" ") { it.trim() }.trim()
        if (cleaned.isBlank()) return MatchOutcome.NoMatch
        val query = ProductQuery(
            upc = UPC_IN_TEXT.find(cleaned)?.value,
            name = cleaned,
            size = SizeParser.canonicalOrNull(cleaned),
        )
        return match(query, candidates)
    }

    /** Free-text search across name, size, UPC and supplier item number. */
    fun search(term: String, candidates: List<MatchableProduct>): List<MatchableProduct> {
        val needle = term.trim()
        if (needle.isEmpty()) return emptyList()
        val lower = needle.lowercase()
        val normalized = NameNormalizer.normalize(needle)

        return candidates
            .map { it to searchScore(it, lower, normalized) }
            .filter { it.second > 0.0 }
            .sortedWith(compareByDescending<Pair<MatchableProduct, Double>> { it.second }.thenBy { it.first.name })
            .map { it.first }
    }

    /**
     * Every word typed has to appear somewhere on the product, so `Tide 40` finds the 40 oz and
     * not the 25 oz. Exact barcode and item-number hits always sort first.
     */
    private fun searchScore(product: MatchableProduct, lowerTerm: String, normalizedTerm: String): Double {
        val name = product.name.lowercase()
        val size = product.size?.lowercase().orEmpty()
        val upc = product.upc?.lowercase().orEmpty()
        val sku = product.supplierSku?.lowercase().orEmpty()
        val haystack = listOf(name, size, upc, sku).joinToString(" ")

        if (upc.isNotEmpty() && upc.contains(lowerTerm)) return 100.0
        if (sku.isNotEmpty() && sku.contains(lowerTerm)) return 95.0
        if (name.startsWith(lowerTerm)) return 90.0

        val words = lowerTerm.split(" ").filter { it.isNotBlank() }
        if (words.isNotEmpty() && words.all { haystack.contains(it) }) return 80.0

        if (normalizedTerm.isBlank()) return 0.0
        val fuzzy = NameNormalizer.similarity(normalizedTerm, product.name)
        return if (fuzzy >= 0.6) fuzzy * 50.0 else 0.0
    }

    private val UPC_IN_TEXT = Regex("""(?<![0-9])([0-9]{8}|[0-9]{12,14})(?![0-9])""")

    fun normalizeUpc(raw: String?): String? {
        val digits = raw?.filter { it.isDigit() } ?: return null
        return digits.takeIf { it.length >= 8 }
    }

    /**
     * A 12-digit UPC-A and the 13-digit EAN-13 the same product scans as differ only by a leading
     * zero, so they are treated as the same code.
     */
    fun upcEquivalent(a: String?, b: String?): Boolean {
        if (a == null || b == null) return false
        if (a == b) return true
        return a.trimStart('0') == b.trimStart('0') && a.trimStart('0').isNotEmpty()
    }

    fun sizeRelation(a: String?, b: String?): SizeRelation {
        val sizeA = SizeParser.parse(a)
        val sizeB = SizeParser.parse(b)
        if (sizeA == null || sizeB == null) return SizeRelation.UNKNOWN
        return if (sizeA.matches(sizeB)) SizeRelation.MATCH else SizeRelation.MISMATCH
    }
}
