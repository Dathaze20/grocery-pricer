package com.grocerypricer.core.ai

import com.grocerypricer.core.matching.NameNormalizer
import com.grocerypricer.core.matching.SizeParser
import com.grocerypricer.core.money.Money

/**
 * Stitches the results of several extraction batches into one order.
 *
 * Photographs of a long receipt overlap - people take them that way, and they are told to. The
 * same product therefore turns up in two batches, and naively concatenating the batches would bill
 * the shop twice for one case.
 *
 * The rule is conservative in the direction that costs nothing: two rows are the same purchase
 * only when the product, the size AND the case price all agree. Two rows for the same product at
 * different prices are two real purchases and are both kept, because a wholesaler genuinely does
 * print the same item twice at two prices, and silently collapsing those would lose money that
 * was actually spent.
 */
object ExtractionMerger {

    fun merge(batches: List<AiOrderExtraction>): AiOrderExtraction {
        if (batches.isEmpty()) return AiOrderExtraction(null, emptyList())
        if (batches.size == 1) return batches.single()

        val all = batches.flatMap { it.items }

        // A legible barcode is the strongest identity there is, stronger than a size someone
        // photographed at an angle. Merge on it first, across size readings, so a product whose
        // barcode scanned in one picture and not the other is still one purchase.
        val byBarcode = LinkedHashMap<String, AiExtractedItem>()
        val withoutBarcode = mutableListOf<AiExtractedItem>()
        for (item in all) {
            val upc = item.upc?.trim()?.takeIf { it.isNotEmpty() }
            if (upc == null) {
                withoutBarcode += item
                continue
            }
            val key = upc + "|" + priceKey(item)
            val existing = byBarcode[key]
            byBarcode[key] = if (existing == null) item else combine(existing, item)
        }

        // Everything else buckets on the two things that must agree exactly - package size and
        // case price - and is matched on the name inside each bucket. Keying directly on the
        // name instead would bill a shop twice whenever one photograph read "HELLM MAYONNAISE"
        // and the other read "Hellmann's Mayonnaise".
        val buckets = LinkedHashMap<String, MutableList<AiExtractedItem>>()
        for (item in byBarcode.values + withoutBarcode) {
            buckets.getOrPut(bucketKey(item)) { mutableListOf() }.add(item)
        }

        val items = buckets.values.flatMap { bucket ->
            val survivors = mutableListOf<AiExtractedItem>()
            for (candidate in bucket) {
                val existingIndex = survivors.indexOfFirst { isSamePurchase(it, candidate) }
                if (existingIndex >= 0) {
                    survivors[existingIndex] = combine(survivors[existingIndex], candidate)
                } else {
                    survivors += candidate
                }
            }
            survivors
        }

        return AiOrderExtraction(
            supplier = batches.firstNotNullOfOrNull { it.supplier?.takeIf { s -> s.isNotBlank() } },
            items = items,
            warnings = batches.flatMap { it.warnings }.distinct(),
        )
    }

    /**
     * The two facts that must match exactly before two rows can even be considered the same.
     *
     * Size keeps Hellmann's 8 oz away from 15 oz. Case price separates a duplicate photograph
     * from a genuine second line at a different price - a wholesaler really does print the same
     * item twice, and collapsing those loses money the shop actually spent.
     */
    private fun bucketKey(item: AiExtractedItem): String {
        val size = SizeParser.canonicalOrNull(item.size)
            ?: item.size?.trim()?.uppercase().orEmpty()
        return size + "|" + priceKey(item)
    }

    /** The case price, normalised so "33.99" and "33.990" are one key rather than two. */
    private fun priceKey(item: AiExtractedItem): String =
        item.casePrice?.let { Money.parseOrNull(it)?.toPlainString() } ?: "?"

    /**
     * Whether two rows in the same bucket are one purchase seen twice.
     *
     * A barcode settles it outright when both rows carry one. Otherwise the names have to look
     * alike, which is what lets an OCR-mangled reading meet a clean one.
     */
    private fun isSamePurchase(a: AiExtractedItem, b: AiExtractedItem): Boolean {
        val upcA = a.upc?.trim()?.takeIf { it.isNotEmpty() }
        val upcB = b.upc?.trim()?.takeIf { it.isNotEmpty() }
        if (upcA != null && upcB != null) return upcA == upcB

        val nameA = a.canonicalName ?: a.rawName
        val nameB = b.canonicalName ?: b.rawName
        if (nameA.isNullOrBlank() || nameB.isNullOrBlank()) return false

        if (NameNormalizer.normalize(nameA) == NameNormalizer.normalize(nameB)) return true
        return NameNormalizer.similarity(nameA, nameB) >= SAME_PRODUCT_SIMILARITY
    }

    /**
     * Folds a second sighting into the first.
     *
     * Photo ids and source lines are unioned, because the evidence for the row genuinely is both
     * pictures. Everything else takes the better-read version: a field one batch could read and
     * the other could not is worth having, and the higher confidence wins a real disagreement.
     */
    private fun combine(first: AiExtractedItem, second: AiExtractedItem): AiExtractedItem {
        val better = if (second.confidence > first.confidence) second else first
        val other = if (better === first) second else first

        return better.copy(
            rawName = better.rawName ?: other.rawName,
            canonicalName = better.canonicalName ?: other.canonicalName,
            brand = better.brand ?: other.brand,
            size = better.size ?: other.size,
            upc = better.upc ?: other.upc,
            supplierSku = better.supplierSku ?: other.supplierSku,
            casePrice = better.casePrice ?: other.casePrice,
            unitsPerCase = better.unitsPerCase ?: other.unitsPerCase,
            printedUnitCost = better.printedUnitCost ?: other.printedUnitCost,
            // Not summed. Both sightings describe the same printed line, and adding the counts
            // would turn one case into two - the exact bug this class exists to prevent.
            casesPurchased = better.casesPurchased ?: other.casesPurchased,
            discount = better.discount ?: other.discount,
            category = better.category ?: other.category,
            sourcePhotoIds = (first.sourcePhotoIds + second.sourcePhotoIds).distinct(),
            sourceText = (first.sourceText + second.sourceText).distinct(),
            confidence = maxOf(first.confidence, second.confidence),
        )
    }

    /**
     * How alike two product names must look before two rows at the same size and price are
     * treated as one purchase. Set so an OCR-mangled reading meets a clean one, and no lower:
     * merging two different products would hide a case the shop actually paid for.
     */
    const val SAME_PRODUCT_SIMILARITY = 0.72
}
