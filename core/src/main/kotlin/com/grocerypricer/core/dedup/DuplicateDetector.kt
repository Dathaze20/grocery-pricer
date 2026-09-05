package com.grocerypricer.core.dedup

import com.grocerypricer.core.matching.NameNormalizer
import com.grocerypricer.core.model.ParseIssueType
import com.grocerypricer.core.model.ParsedReceiptItem

/**
 * Tells apart the three reasons the same product can appear twice in one import:
 *
 *  1. it really was bought twice on the same receipt - left alone,
 *  2. the same line was read twice out of one photo - flagged,
 *  3. two photos overlapped and share a run of lines - flagged.
 *
 * Nothing is ever removed automatically. A flagged row shows up on the review screen for the user
 * to keep or drop, because throwing away a genuine second purchase is worse than asking.
 */
object DuplicateDetector {

    /** Lines this close together in one photo are the same line read twice, not two purchases. */
    private const val SAME_PHOTO_LINE_WINDOW = 6

    /** A shared run at least this long between two photos is an overlap, not a coincidence. */
    private const val OVERLAP_RUN_THRESHOLD = 1

    fun signature(item: ParsedReceiptItem): String = listOf(
        NameNormalizer.normalize(item.description),
        item.casePrice?.toPlainString() ?: "?",
        item.unitsPerCase?.toString() ?: "?",
    ).joinToString("|")

    fun flagDuplicates(items: List<ParsedReceiptItem>): List<ParsedReceiptItem> {
        if (items.size < 2) return items
        val result = items.toMutableList()
        flagSamePhotoRepeats(result)
        flagPhotoOverlaps(result)
        return result
    }

    private fun flagSamePhotoRepeats(items: MutableList<ParsedReceiptItem>) {
        for (i in items.indices) {
            val a = items[i]
            val signatureA = signature(a)
            if (signatureA.startsWith("|")) continue
            for (j in i + 1 until items.size) {
                val b = items[j]
                if (a.imageId != b.imageId) continue
                if (signature(b) != signatureA) continue
                val lineA = a.sourceLineIndexes.maxOrNull() ?: continue
                val lineB = b.sourceLineIndexes.minOrNull() ?: continue
                if (lineB - lineA <= SAME_PHOTO_LINE_WINDOW) {
                    items[j] = b.withIssue(
                        ParseIssueType.POSSIBLE_DUPLICATE_LINE,
                        "Matches \"${a.description}\" a few lines above in the same photo.",
                    )
                }
            }
        }
    }

    /**
     * Looks for the tail of one photo repeating at the head of the next. Photographers overlap
     * long receipts on purpose, so this is the common case, not an edge case.
     */
    private fun flagPhotoOverlaps(items: MutableList<ParsedReceiptItem>) {
        val imageOrder = items.map { it.imageId }.distinct()
        if (imageOrder.size < 2) return

        for (pair in imageOrder.windowed(2)) {
            val (firstImage, secondImage) = pair
            val tailPositions = items.indices.filter { items[it].imageId == firstImage }
            val headPositions = items.indices.filter { items[it].imageId == secondImage }
            if (tailPositions.isEmpty() || headPositions.isEmpty()) continue

            val tail = tailPositions.map { signature(items[it]) }
            val head = headPositions.map { signature(items[it]) }
            val maxRun = minOf(tail.size, head.size)

            var overlap = 0
            for (run in maxRun downTo 1) {
                val tailSlice = tail.takeLast(run)
                val headSlice = head.take(run)
                if (tailSlice == headSlice && tailSlice.none { it.startsWith("|") }) {
                    overlap = run
                    break
                }
            }

            if (overlap >= OVERLAP_RUN_THRESHOLD) {
                headPositions.take(overlap).forEach { position ->
                    items[position] = items[position].withIssue(
                        ParseIssueType.POSSIBLE_PHOTO_OVERLAP,
                        "Also read from the previous photo.",
                    )
                }
            }
        }
    }
}
