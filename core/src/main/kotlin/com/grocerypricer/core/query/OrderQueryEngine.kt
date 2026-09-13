package com.grocerypricer.core.query

import com.grocerypricer.core.matching.MatchableProduct
import com.grocerypricer.core.matching.NameNormalizer
import com.grocerypricer.core.matching.ProductMatcher
import com.grocerypricer.core.matching.SizeParser
import com.grocerypricer.core.money.Money

/**
 * One row of an imported order, as far as searching is concerned.
 *
 * It extends [MatchableProduct] so the existing barcode-and-name matcher can be reused rather
 * than reimplemented; `productId` carries the order-item id, which is what the conversation
 * refers to.
 */
interface QueryableOrderItem : MatchableProduct {
    val brand: String?
    val category: String?
    val unitsPerCase: Int?
    val unitCost: Money?
    val suggestedRetail: Money?
    val approvedRetail: Money?

    /** What the shelf price would be today: what the user set, else what was suggested. */
    val effectiveRetail: Money? get() = approvedRetail ?: suggestedRetail
}

/** What the user's words appeared to be asking for. */
data class QueryRequest(
    val phrase: String,
    /** True when the wording was plural - "the juices", "all six" - so several answers are wanted. */
    val expectMultiple: Boolean = false,
    /** A count the user stated, e.g. 2 in "how much are these two". */
    val expectedCount: Int? = null,
)

sealed interface QueryOutcome {
    /** Exactly what they meant. */
    data class Exact(val item: QueryableOrderItem) : QueryOutcome

    /** Several products, all of them wanted. */
    data class Several(val items: List<QueryableOrderItem>) : QueryOutcome

    /** Plausible candidates that need one short question to separate. */
    data class Ambiguous(val candidates: List<QueryableOrderItem>) : QueryOutcome

    /** Nothing in this order looked like it. */
    data object None : QueryOutcome
}

/**
 * Local product lookup over one imported order.
 *
 * This exists so the common question never leaves the phone. "How much is the Hellmann's 8 oz"
 * has exactly one answer sitting in the database, and paying a cloud model to find it would be
 * slower, cost the shopkeeper money, and work no better. The AI is for the cases this cannot
 * settle: real ambiguity, photographs, and sentences that refer back to the conversation.
 *
 * Nothing here computes or returns a price. It returns rows; the caller reads the money off them.
 */
class OrderQueryEngine(private val items: List<QueryableOrderItem>) {

    /** Words that carry no product meaning, so they never decide a match. */
    private val stopWords = setOf(
        "a", "an", "and", "are", "at", "be", "buy", "can", "charge", "cost", "costs", "did",
        "do", "does", "each", "for", "get", "give", "how", "i", "in", "is", "it", "its", "many",
        "me", "much", "my", "of", "on", "one", "ones", "or", "our", "pay", "paid", "per",
        "price", "prices", "sell", "selling", "should", "show", "that", "the", "them", "these",
        "they", "this", "those", "to", "us", "was", "we", "were", "what", "whats", "which",
        "with", "you", "your",
        // Counting words. "how much are these two" says how many answers are wanted, not what
        // the product is called, and leaving them in makes every phrase unmatchable.
        "both", "couple", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        "all", "every",
    )

    fun all(): List<QueryableOrderItem> = items

    fun byItemId(id: Long): QueryableOrderItem? = items.firstOrNull { it.productId == id }

    fun byItemIds(ids: Collection<Long>): List<QueryableOrderItem> {
        // Preserve the caller's order: "number two" depends on it.
        val byId = items.associateBy { it.productId }
        return ids.mapNotNull { byId[it] }
    }

    /** A scanned barcode is an exact answer or no answer. It never guesses. */
    fun byBarcode(barcode: String?): QueryableOrderItem? {
        val normalized = ProductMatcher.normalizeUpc(barcode) ?: return null
        return items.firstOrNull { ProductMatcher.upcEquivalent(it.upc, normalized) }
    }

    fun inCategory(category: String?): List<QueryableOrderItem> {
        val wanted = category?.trim()?.lowercase().orEmpty()
        if (wanted.isEmpty()) return emptyList()
        return items.filter { it.category?.trim()?.lowercase() == wanted }
    }

    fun costingUnder(limit: Money): List<QueryableOrderItem> =
        items.filter { item -> item.unitCost?.let { it < limit } == true }
            .sortedBy { it.unitCost?.toStorageLong() ?: Long.MAX_VALUE }

    fun costingOver(limit: Money): List<QueryableOrderItem> =
        items.filter { item -> item.unitCost?.let { it > limit } == true }
            .sortedByDescending { it.unitCost?.toStorageLong() ?: Long.MIN_VALUE }

    /**
     * Resolve a product phrase against this order.
     *
     * The plural rule matters more than it looks. "How much is the mayonnaise" with an 8 oz and a
     * 15 oz on the receipt must ask which one, because answering with either is a coin flip on a
     * real shelf price. "How much are the two juices" with the same shaped result must answer
     * both. The difference is entirely in how the person spoke, so [QueryRequest] carries it.
     */
    fun resolve(request: QueryRequest): QueryOutcome {
        val phrase = request.phrase.trim()
        if (phrase.isEmpty()) return QueryOutcome.None

        barcodeIn(phrase)?.let { return QueryOutcome.Exact(it) }

        val scored = rank(phrase)
        if (scored.isEmpty()) return QueryOutcome.None

        val best = scored.first()

        // A clear winner is a clear winner, however the sentence was phrased.
        val runnerUp = scored.getOrNull(1)
        val decisive = runnerUp == null || best.score >= runnerUp.score + DECISIVE_MARGIN

        if (request.expectMultiple) {
            val wanted = request.expectedCount
            val strong = scored.filter { it.score >= best.score - SIBLING_MARGIN }
            val chosen = if (wanted != null && wanted <= scored.size) {
                scored.take(wanted)
            } else {
                strong
            }
            return if (chosen.size <= 1) {
                QueryOutcome.Exact(best.item)
            } else {
                QueryOutcome.Several(chosen.map { it.item })
            }
        }

        if (decisive) return QueryOutcome.Exact(best.item)

        // Everything close to the top is a genuine candidate worth asking about.
        val tied = scored.filter { it.score >= best.score - SIBLING_MARGIN }
        return if (tied.size <= 1) {
            QueryOutcome.Exact(best.item)
        } else {
            QueryOutcome.Ambiguous(tied.take(MAX_CANDIDATES).map { it.item })
        }
    }

    /**
     * The shortlist handed to the model when local matching cannot settle it.
     *
     * Deliberately short. Sending the whole order would cost the user money on every question and
     * make the model's job harder, not easier.
     */
    fun candidatesFor(phrase: String, limit: Int = MAX_CANDIDATES): List<QueryableOrderItem> {
        val ranked = rank(phrase)
        if (ranked.isNotEmpty()) return ranked.take(limit).map { it.item }
        // Nothing matched at all - offer a small slice so the model can still say "did you mean".
        return items.take(limit)
    }

    private fun barcodeIn(phrase: String): QueryableOrderItem? {
        val digits = Regex("\\b\\d{8,14}\\b").find(phrase)?.value ?: return null
        return byBarcode(digits)
    }

    private data class Scored(val item: QueryableOrderItem, val score: Double)

    /**
     * Score every row against the phrase.
     *
     * Size is treated as a hard filter rather than a soft signal: if the person said a size and a
     * row contradicts it, that row is out. Merging an 8 oz and a 15 oz would produce a confident
     * answer at the wrong price, which is worse than no answer at all.
     */
    private fun rank(phrase: String): List<Scored> {
        val askedSize = SizeParser.parse(phrase)
        val bareNumbers = looseSizeNumbers(phrase)
        val words = meaningfulWords(phrase)
        if (words.isEmpty() && askedSize == null && bareNumbers.isEmpty()) return emptyList()

        return items.mapNotNull { item ->
            val itemSize = SizeParser.parse(item.size)

            if (askedSize != null) {
                if (itemSize == null || !itemSize.matches(askedSize)) return@mapNotNull null
            }

            val haystack = listOfNotNull(item.brand, item.name, item.size)
                .joinToString(" ")
            // NameNormalizer works in upper case; everything here is compared in lower case.
            val normalizedHaystack = NameNormalizer.normalize(haystack).lowercase()
            val haystackWords = NameNormalizer.tokens(haystack).map { it.lowercase() }.toSet()
            val haystackStems = haystackWords.map(::stem).toSet()

            var score = 0.0
            var matchedWords = 0

            for (word in words) {
                val hit = when {
                    word in haystackWords -> 1.0
                    // "the oils" must reach "Corn Oil"; plain edit distance never gets there on
                    // a three-letter word, so singular and plural are compared as stems.
                    stem(word) in haystackStems -> 0.95
                    normalizedHaystack.contains(word) -> 0.85
                    haystackWords.any { NameNormalizer.levenshteinRatio(it, word) >= 0.82 } -> 0.7
                    else -> 0.0
                }
                if (hit > 0.0) {
                    matchedWords++
                    score += hit
                }
            }

            // Every meaningful word has to land somewhere. "corn oil 48" must not match plain
            // "vegetable oil" just because "oil" is in both.
            if (words.isNotEmpty() && matchedWords < words.size) return@mapNotNull null

            if (askedSize != null) {
                score += 2.0
            } else if (bareNumbers.isNotEmpty() && itemSize != null) {
                // "mayo 8" - a naked number that lines up with a package size is a strong hint.
                if (bareNumbers.any { it.compareTo(itemSize.value) == 0 }) score += 2.0
            }

            if (score <= 0.0) null else Scored(item, score)
        }.sortedWith(
            compareByDescending<Scored> { it.score }.thenBy { it.item.name.lowercase() },
        )
    }

    /**
     * Crude, deliberately. "oils" -> "oil", "juices" -> "juice", "boxes" -> "box". It exists to
     * let a plural question reach a singular product name, not to conjugate English.
     */
    private fun stem(word: String): String = when {
        word.length > 4 && word.endsWith("es") -> word.dropLast(2)
        word.length > 3 && word.endsWith("s") && !word.endsWith("ss") -> word.dropLast(1)
        else -> word
    }

    private fun meaningfulWords(phrase: String): List<String> =
        NameNormalizer.tokens(phrase)
            .map { it.lowercase() }
            .filter { it.isNotBlank() && it !in stopWords }
            // A bare number is handled as a size hint, not as a name word.
            .filterNot { it.all(Char::isDigit) }
            .distinct()

    private fun looseSizeNumbers(phrase: String): List<java.math.BigDecimal> =
        Regex("\\b\\d+(?:\\.\\d+)?\\b").findAll(phrase)
            .mapNotNull { runCatching { java.math.BigDecimal(it.value) }.getOrNull() }
            .toList()

    companion object {
        /** How far ahead the top match must be before it answers without asking. */
        const val DECISIVE_MARGIN = 0.9

        /** How close to the top a row must be to count as a real alternative. */
        const val SIBLING_MARGIN = 1.0

        const val MAX_CANDIDATES = 8
    }
}
