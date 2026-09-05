package com.grocerypricer.core.parser

import com.grocerypricer.core.dedup.DuplicateDetector
import com.grocerypricer.core.matching.NameNormalizer
import com.grocerypricer.core.matching.SizeParser
import com.grocerypricer.core.model.Category
import com.grocerypricer.core.model.DiscountScope
import com.grocerypricer.core.model.ParseIssueType
import com.grocerypricer.core.model.ParsedReceipt
import com.grocerypricer.core.model.ParsedReceiptItem
import com.grocerypricer.core.model.ReceiptDiscount
import com.grocerypricer.core.model.ReceiptLine
import com.grocerypricer.core.money.Money

/**
 * Rebuilds a wholesale order from the text OCR pulled off receipt photos.
 *
 * The parser understands the Jetro / Restaurant Depot shape, where a product description is
 * followed by a detail line such as `CASE $33.99 SIZE 12 UNIT $2.83` and optionally by a flyer
 * discount underneath it.
 *
 * It never invents a value. Anything it cannot read stays null and the row is flagged, so the
 * review screen can insist on a human before the numbers are saved.
 */
object ReceiptParser {

    // --- Detail line ---------------------------------------------------------------------
    private val CASE_PRICE = Regex("""\b(?:CASE|CS)\b\s*[:#]?\s*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)""", RegexOption.IGNORE_CASE)
    private val SIZE_COUNT = Regex("""\b(?:SIZE|SZ|PACK|PK)\b\s*[:#]?\s*([0-9]{1,4})\b""", RegexOption.IGNORE_CASE)
    private val UNIT_PRICE = Regex("""\bUNIT\b\s*[:#]?\s*\$\s*([0-9]+(?:\.[0-9]{1,3})?)""", RegexOption.IGNORE_CASE)
    private val UNIT_PRICE_BARE = Regex("""\bUNIT\b\s*[:#]?\s*([0-9]+\.[0-9]{2,3})\b""", RegexOption.IGNORE_CASE)
    private val ANY_MONEY = Regex("""\$\s*[0-9]+(?:\.[0-9]{1,2})?""")

    // --- Quantities ----------------------------------------------------------------------
    private val CASES_QTY = Regex("""\bCASES\b\s*[:#x]?\s*([0-9]{1,3})\b""", RegexOption.IGNORE_CASE)
    private val UNITS_QTY = Regex("""\bUNITS\b\s*[:#x]?\s*([0-9]{1,4})\b""", RegexOption.IGNORE_CASE)
    private val QTY_ANY = Regex("""\bQTY\b\s*[:#x]?\s*([0-9]{1,4})\b""", RegexOption.IGNORE_CASE)
    private val LOOSE_QTY = Regex("""\b(?:LOOSE|EACHES|EACH|SPLIT)\b\s*[:#x]?\s*([0-9]{1,4})\b""", RegexOption.IGNORE_CASE)

    // --- Discounts -----------------------------------------------------------------------
    private val DISCOUNT_KEYWORDS = listOf(
        "FLYER", "DISCOUNT", "COUPON", "PROMO", "PROMOTION", "REBATE",
        "SCAN DOWN", "SCANDOWN", "ALLOWANCE", "INSTANT", "MFG",
    )
    private val NEGATIVE_AMOUNT = Regex("""-\s*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)""")
    private val PAREN_AMOUNT = Regex("""\(\s*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)\s*\)""")
    private val DISCOUNT_LABEL_PREFIX = Regex(
        """^\s*(?:FLYER|COUPON|PROMO(?:TION)?|DISCOUNT|SCAN\s*DOWN|ALLOWANCE|INSTANT|REBATE|MFG)\b[\s#:0-9]*[-–—]?\s*""",
        RegexOption.IGNORE_CASE,
    )

    // --- Other ---------------------------------------------------------------------------
    private val UPC_PATTERN = Regex("""(?<![0-9])([0-9]{8}|[0-9]{12,14})(?![0-9])""")
    private val ITEM_NUMBER = Regex("""\b(?:ITEM|SKU|ITM)\b\s*[:#]?\s*([0-9A-Z-]{4,15})\b""", RegexOption.IGNORE_CASE)
    private val NOISE = Regex(
        """\b(SUB\s*TOTAL|TOTAL|TAX|BALANCE|TENDER|CHANGE\s+DUE|CASHIER|MEMBER|INVOICE|TERMINAL|THANK\s+YOU|REGISTER|AUTH|VISA|MASTERCARD|AMEX|DEBIT|CREDIT|ACCOUNT|SIGNATURE|CUSTOMER\s+COPY|RESTAURANT\s+DEPOT|JETRO|CASH\b)""",
        RegexOption.IGNORE_CASE,
    )
    private val HAS_LETTERS = Regex("""[A-Za-z]{3,}""")

    /** Similarity at or above which a flyer line is confidently the product printed above it. */
    private const val DISCOUNT_MATCH_THRESHOLD = 0.55

    /** Splits raw OCR output for one image into numbered lines. */
    fun toLines(rawText: String, imageId: Long = 0L, startIndex: Int = 0): List<ReceiptLine> =
        rawText.split("\n")
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .mapIndexed { offset, text ->
                ReceiptLine(
                    index = startIndex + offset,
                    text = text,
                    imageId = imageId,
                    indexWithinImage = offset,
                )
            }

    /** Convenience for a single blob of text, mainly used by tests and manual paste-in. */
    fun parseText(rawText: String, imageId: Long = 0L): ParsedReceipt = parse(toLines(rawText, imageId))

    fun parse(lines: List<ReceiptLine>): ParsedReceipt {
        val prepared = lines.map { line ->
            val normalized = OcrTextNormalizer.normalize(line.text)
            PreparedLine(
                line = line.copy(text = normalized.text),
                original = line.text,
                corrected = normalized.correctedCharacters,
                kind = classify(normalized.text),
            )
        }.filter { it.line.text.isNotBlank() }

        val items = mutableListOf<ParsedReceiptItem>()
        val unmatchedDiscounts = mutableListOf<ReceiptDiscount>()
        val consumed = BooleanArray(prepared.size)

        prepared.forEachIndexed { index, prep ->
            if (prep.kind != LineKind.DETAIL || consumed[index]) return@forEachIndexed
            consumed[index] = true

            val descriptionSource = descriptionFor(prepared, index, consumed)
            val item = buildItem(prep, descriptionSource, index)
            items += item
        }

        // Attach quantities and discounts to the item each one sits under.
        var withExtras = items.toMutableList()
        prepared.forEachIndexed { index, prep ->
            when (prep.kind) {
                LineKind.QUANTITY -> {
                    val target = indexOfItemAbove(withExtras, prep.line.index) ?: return@forEachIndexed
                    withExtras[target] = applyQuantities(withExtras[target], prep.line.text)
                }
                LineKind.DISCOUNT_INLINE, LineKind.DISCOUNT_AMOUNT, LineKind.DISCOUNT_LABEL -> {
                    val discount = discountFrom(prepared, index) ?: return@forEachIndexed
                    val target = indexOfItemAbove(withExtras, prep.line.index)
                    if (target == null) {
                        unmatchedDiscounts += discount
                    } else {
                        withExtras[target] = attachDiscount(withExtras[target], discount)
                    }
                }
                else -> Unit
            }
        }

        withExtras = withExtras.map { ReceiptItemValidator.validate(it) }.toMutableList()
        val deduped = DuplicateDetector.flagDuplicates(withExtras)

        val unparsed = prepared.filterIndexed { index, prep ->
            prep.kind == LineKind.TEXT && !consumed[index]
        }.map { it.line }

        return ParsedReceipt(
            items = deduped,
            unmatchedDiscounts = unmatchedDiscounts,
            unparsedLines = unparsed,
        )
    }

    // -----------------------------------------------------------------------------------------

    private fun buildItem(
        prep: PreparedLine,
        description: DescriptionSource?,
        lineIndex: Int,
    ): ParsedReceiptItem {
        val text = prep.line.text
        val casePrice = CASE_PRICE.find(text)?.groupValues?.get(1)?.let { Money.parseOrNull(it) }
        val unitsPerCase = SIZE_COUNT.find(text)?.groupValues?.get(1)?.toIntOrNull()
        val printedUnit = (UNIT_PRICE.find(text) ?: UNIT_PRICE_BARE.find(text))
            ?.groupValues?.get(1)?.let { Money.parseOrNull(it) }

        val inlineDescription = inlineDescriptionOf(text)
        val descriptionText = description?.text ?: inlineDescription
        val descriptionLine = description?.lineIndex

        val searchSpace = listOfNotNull(descriptionText, text).joinToString(" ")
        val upc = UPC_PATTERN.find(searchSpace)?.groupValues?.get(1)
        val sku = ITEM_NUMBER.find(searchSpace)?.groupValues?.get(1)

        val cleanedDescription = descriptionText
            ?.let { UPC_PATTERN.replace(it, " ") }
            ?.let { ITEM_NUMBER.replace(it, " ") }
            ?.replace(Regex(" {2,}"), " ")
            ?.trim()
            ?.takeIf { it.isNotBlank() }

        var item = ParsedReceiptItem(
            id = "item-$lineIndex",
            description = cleanedDescription,
            upc = upc,
            supplierSku = sku,
            packageSize = SizeParser.canonicalOrNull(cleanedDescription),
            casePrice = casePrice,
            unitsPerCase = unitsPerCase,
            printedUnitCost = printedUnit,
            casesPurchased = 1,
            looseUnits = 0,
            category = Category.guessFrom(cleanedDescription),
            sourceLineIndexes = listOfNotNull(descriptionLine, lineIndex),
            rawText = listOfNotNull(description?.original, prep.original).joinToString(" | "),
            imageId = prep.line.imageId,
        )

        if (prep.corrected || description?.corrected == true) {
            item = item.withIssue(ParseIssueType.AMBIGUOUS_CHARACTERS)
        }
        return item
    }

    /** Text sitting on the detail line itself, before the `CASE` keyword. */
    private fun inlineDescriptionOf(text: String): String? {
        val caseAt = CASE_PRICE.find(text)?.range?.first ?: return null
        val prefix = text.substring(0, caseAt).trim().trim('-', ':', '|')
        return prefix.takeIf { HAS_LETTERS.containsMatchIn(it) }
    }

    /**
     * The product name for a detail line: text on the line itself when there is any, otherwise the
     * nearest description line above that has not already been used by another product.
     */
    private fun descriptionFor(
        prepared: List<PreparedLine>,
        detailIndex: Int,
        consumed: BooleanArray,
    ): DescriptionSource? {
        inlineDescriptionOf(prepared[detailIndex].line.text)?.let {
            return DescriptionSource(it, prepared[detailIndex].original, null, prepared[detailIndex].corrected)
        }
        var cursor = detailIndex - 1
        var hops = 0
        while (cursor >= 0 && hops < 3) {
            val candidate = prepared[cursor]
            if (!consumed[cursor] && candidate.kind == LineKind.TEXT) {
                consumed[cursor] = true
                return DescriptionSource(
                    text = candidate.line.text,
                    original = candidate.original,
                    lineIndex = candidate.line.index,
                    corrected = candidate.corrected,
                )
            }
            if (candidate.kind == LineKind.DETAIL) return null
            cursor--
            hops++
        }
        return null
    }

    private fun indexOfItemAbove(items: List<ParsedReceiptItem>, lineIndex: Int): Int? {
        var best: Int? = null
        items.forEachIndexed { position, item ->
            val itemLine = item.sourceLineIndexes.maxOrNull() ?: return@forEachIndexed
            if (itemLine < lineIndex) best = position
        }
        return best
    }

    private fun applyQuantities(item: ParsedReceiptItem, text: String): ParsedReceiptItem {
        val cases = CASES_QTY.find(text)?.groupValues?.get(1)?.toIntOrNull()
        val units = UNITS_QTY.find(text)?.groupValues?.get(1)?.toIntOrNull()
        val qty = QTY_ANY.find(text)?.groupValues?.get(1)?.toIntOrNull()
        val loose = LOOSE_QTY.find(text)?.groupValues?.get(1)?.toIntOrNull()

        // `CASES 3` is authoritative. A bare `UNITS n` with no case count means n selling units
        // were bought, which on a case-priced line is n cases. When both appear, `UNITS` is the
        // packing count the receipt prints alongside, not extra loose pieces.
        val casesPurchased = cases ?: qty ?: units ?: item.casesPurchased
        return item.copy(
            casesPurchased = casesPurchased.coerceAtLeast(0),
            looseUnits = loose ?: item.looseUnits,
        )
    }

    /**
     * Builds a discount from a label line, an amount line, or a line carrying both. Returns null
     * when the pieces do not add up to a usable amount.
     */
    private fun discountFrom(prepared: List<PreparedLine>, index: Int): ReceiptDiscount? {
        val prep = prepared[index]
        val text = prep.line.text
        val amount = amountIn(text)

        return when (prep.kind) {
            LineKind.DISCOUNT_INLINE -> amount?.let {
                ReceiptDiscount(labelOf(text), it, DiscountScope.UNKNOWN, sourceLineIndex = prep.line.index)
            }
            LineKind.DISCOUNT_AMOUNT -> {
                // A bare amount belongs to the label directly above it, when there is one.
                val label = prepared.getOrNull(index - 1)?.takeIf { it.kind == LineKind.DISCOUNT_LABEL }
                amount?.let {
                    ReceiptDiscount(
                        description = label?.let { l -> labelOf(l.line.text) } ?: "Discount",
                        amount = it,
                        scope = DiscountScope.UNKNOWN,
                        sourceLineIndex = prep.line.index,
                    )
                }
            }
            // A label whose amount is on the following line is handled when that line is reached.
            else -> null
        }
    }

    private fun amountIn(text: String): Money? {
        PAREN_AMOUNT.find(text)?.let { return Money.parseOrNull(it.groupValues[1]) }
        NEGATIVE_AMOUNT.find(text)?.let { return Money.parseOrNull(it.groupValues[1]) }
        return null
    }

    private fun labelOf(text: String): String =
        text.replace(NEGATIVE_AMOUNT, "").replace(PAREN_AMOUNT, "").trim().trim('-', ':', '|').trim()
            .ifBlank { "Discount" }

    /**
     * Ties a discount to a product. When the flyer text clearly names the product above it the
     * discount is treated as coming off the whole case; otherwise it is left as
     * [DiscountScope.UNKNOWN] and flagged, so it changes nothing until the user says how it applies.
     */
    private fun attachDiscount(item: ParsedReceiptItem, discount: ReceiptDiscount): ParsedReceiptItem {
        val productPart = DISCOUNT_LABEL_PREFIX.replace(discount.description, "").trim()
        val similarity = NameNormalizer.similarity(productPart, item.description)
        val confident = productPart.isNotBlank() && similarity >= DISCOUNT_MATCH_THRESHOLD

        val existing = item.discount
        val resolved = if (existing == null) {
            discount.copy(scope = if (confident) DiscountScope.WHOLE_CASE else DiscountScope.UNKNOWN)
        } else {
            val bothConfident = existing.scope == DiscountScope.WHOLE_CASE && confident
            ReceiptDiscount(
                description = existing.description + " + " + discount.description,
                amount = existing.amount + discount.amount,
                scope = if (bothConfident) DiscountScope.WHOLE_CASE else DiscountScope.UNKNOWN,
                sourceLineIndex = existing.sourceLineIndex,
            )
        }

        val updated = item.copy(
            discount = resolved,
            sourceLineIndexes = item.sourceLineIndexes + listOfNotNull(discount.sourceLineIndex),
        )
        return if (resolved.scope == DiscountScope.UNKNOWN) {
            updated.withIssue(
                ParseIssueType.UNCERTAIN_DISCOUNT,
                "Read as \"${discount.description}\".",
            )
        } else {
            updated
        }
    }

    // -----------------------------------------------------------------------------------------

    private fun classify(text: String): LineKind {
        val hasCasePrice = CASE_PRICE.containsMatchIn(text)
        val hasSize = SIZE_COUNT.containsMatchIn(text)
        val hasMoney = ANY_MONEY.containsMatchIn(text)
        if (hasCasePrice && (hasSize || hasMoney || UNIT_PRICE.containsMatchIn(text))) return LineKind.DETAIL
        if (hasSize && hasMoney && UNIT_PRICE.containsMatchIn(text)) return LineKind.DETAIL

        val hasDiscountWord = DISCOUNT_KEYWORDS.any { text.contains(it, ignoreCase = true) }
        val hasNegative = PAREN_AMOUNT.containsMatchIn(text) || NEGATIVE_AMOUNT.containsMatchIn(text)
        if (hasDiscountWord && hasNegative) return LineKind.DISCOUNT_INLINE
        if (hasDiscountWord) return LineKind.DISCOUNT_LABEL
        if (hasNegative && !HAS_LETTERS.containsMatchIn(text)) return LineKind.DISCOUNT_AMOUNT

        if (NOISE.containsMatchIn(text)) return LineKind.NOISE
        if (CASES_QTY.containsMatchIn(text) || UNITS_QTY.containsMatchIn(text) ||
            QTY_ANY.containsMatchIn(text) || LOOSE_QTY.containsMatchIn(text)
        ) {
            return LineKind.QUANTITY
        }
        if (HAS_LETTERS.containsMatchIn(text)) return LineKind.TEXT
        return LineKind.NOISE
    }

    private enum class LineKind { DETAIL, DISCOUNT_LABEL, DISCOUNT_AMOUNT, DISCOUNT_INLINE, QUANTITY, NOISE, TEXT }

    private data class PreparedLine(
        val line: ReceiptLine,
        val original: String,
        val corrected: Boolean,
        val kind: LineKind,
    )

    private data class DescriptionSource(
        val text: String,
        val original: String,
        val lineIndex: Int?,
        val corrected: Boolean,
    )
}
