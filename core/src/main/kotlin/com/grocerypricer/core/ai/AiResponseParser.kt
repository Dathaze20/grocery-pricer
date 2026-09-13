package com.grocerypricer.core.ai

import com.grocerypricer.core.ai.AiJson.array
import com.grocerypricer.core.ai.AiJson.double
import com.grocerypricer.core.ai.AiJson.int
import com.grocerypricer.core.ai.AiJson.longList
import com.grocerypricer.core.ai.AiJson.money
import com.grocerypricer.core.ai.AiJson.obj
import com.grocerypricer.core.ai.AiJson.objectList
import com.grocerypricer.core.ai.AiJson.str
import com.grocerypricer.core.ai.AiJson.stringList
import kotlinx.serialization.json.JsonObject

/**
 * Turns whatever the model actually sent into the typed shapes the rest of the app expects.
 *
 * A parse never throws. Anything unreadable becomes [AiError.MalformedResponse] carrying a short
 * reason, and anything readable-but-wrong is left for [AiExtractionValidator] to throw out.
 */
object AiResponseParser {

    fun parseOrderExtraction(raw: String?): AiResult<AiOrderExtraction> {
        val root = AiJson.parseObject(raw)
            ?: return AiResult.Failure(
                AiError.MalformedResponse(
                    if (raw.isNullOrBlank()) "the reply was empty"
                    else "the reply contained no complete JSON object",
                ),
            )

        // An items array is the one thing that must be present. Everything else can be absent.
        if (root.array("items") == null) {
            return AiResult.Failure(AiError.MalformedResponse("the reply had no \"items\" array"))
        }

        val items = root.objectList("items").map { it.toExtractedItem() }
        return AiResult.Success(
            AiOrderExtraction(
                supplier = root.str("supplier"),
                items = items,
                warnings = root.stringList("warnings"),
            ),
        )
    }

    private fun JsonObject.toExtractedItem(): AiExtractedItem = AiExtractedItem(
        rawName = str("rawName"),
        canonicalName = str("canonicalName"),
        brand = str("brand"),
        size = str("size"),
        upc = str("upc"),
        supplierSku = str("supplierSku"),
        casePrice = money("casePrice"),
        unitsPerCase = int("unitsPerCase"),
        printedUnitCost = money("printedUnitCost"),
        casesPurchased = int("casesPurchased"),
        discount = obj("discount")?.toDiscount(),
        category = str("category"),
        sourcePhotoIds = longList("sourcePhotoIds"),
        sourceText = stringList("sourceText"),
        // A model that forgets to score itself is treated as unsure, never as certain.
        confidence = double("confidence") ?: 0.0,
    )

    private fun JsonObject.toDiscount(): AiExtractedDiscount? {
        val discount = AiExtractedDiscount(
            amount = money("amount"),
            scope = str("scope"),
            appliesToUnits = int("appliesToUnits"),
        )
        // `"discount": {}` means no discount, not a zero-dollar one.
        return discount.takeIf { it.amount != null || it.scope != null }
    }

    fun parseImageClassification(raw: String?): AiResult<List<AiImageClassification>> {
        val root = AiJson.parseObject(raw)
            ?: return AiResult.Failure(AiError.MalformedResponse("no JSON object in the reply"))
        if (root.array("images") == null) {
            return AiResult.Failure(AiError.MalformedResponse("the reply had no \"images\" array"))
        }
        val classified = root.objectList("images").mapNotNull { el ->
            val id = el.int("photoId")?.toLong() ?: return@mapNotNull null
            AiImageClassification(
                photoId = id,
                type = OrderImageType.fromNameOrUnknown(el.str("type")),
                confidence = el.double("confidence") ?: 0.0,
            )
        }
        return AiResult.Success(classified)
    }

    fun parseProductIdentification(raw: String?): AiResult<ProductIdentification> {
        val root = AiJson.parseObject(raw)
            ?: return AiResult.Failure(AiError.MalformedResponse("no JSON object in the reply"))
        if (root.array("products") == null) {
            return AiResult.Failure(AiError.MalformedResponse("the reply had no \"products\" array"))
        }
        val products = root.objectList("products").mapIndexed { index, el ->
            AiVisualProduct(
                brand = el.str("brand"),
                productName = el.str("productName"),
                size = el.str("size"),
                variant = el.str("variant"),
                upc = el.str("upc"),
                // Fall back to reading order so "the second one" still means something.
                position = el.int("position") ?: index,
                confidence = el.double("confidence") ?: 0.0,
            )
        }.filter { it.brand != null || it.productName != null || it.upc != null }

        return AiResult.Success(
            ProductIdentification(products = products, warnings = root.stringList("warnings")),
        )
    }

    /**
     * Reads the model's decision about what the user meant.
     *
     * Any item id the model returns is filtered against [allowedItemIds]. A model that invents an
     * id, or reaches for a row that was never offered to it, gets that id dropped rather than
     * obeyed - which is what stops a hallucinated reference turning into a real price change.
     */
    fun parseQuestionResolution(
        raw: String?,
        allowedItemIds: Set<Long>,
    ): AiResult<OrderQuestionResolution> {
        val root = AiJson.parseObject(raw)
            ?: return AiResult.Failure(AiError.MalformedResponse("no JSON object in the reply"))

        val ids = root.longList("itemIds").filter { it in allowedItemIds }

        return when (root.str("kind")?.uppercase()) {
            "PRODUCT_MATCHES" -> AiResult.Success(
                if (ids.isEmpty()) {
                    OrderQuestionResolution.Unresolved("no known item matched")
                } else {
                    OrderQuestionResolution.ProductMatches(ids, followUp = root.str("followUp"))
                },
            )

            "CATEGORY_MATCHES" -> AiResult.Success(
                if (ids.isEmpty()) {
                    OrderQuestionResolution.Unresolved("no item in that group")
                } else {
                    OrderQuestionResolution.CategoryMatches(ids, label = root.str("label"))
                },
            )

            "CLARIFICATION" -> {
                val question = root.str("question")
                    ?: return AiResult.Failure(
                        AiError.MalformedResponse("a clarification with no question in it"),
                    )
                AiResult.Success(OrderQuestionResolution.Clarification(question))
            }

            "PRICE_CORRECTION" -> {
                val updates = root.objectList("updates").mapNotNull { el ->
                    val id = el.int("itemId")?.toLong() ?: return@mapNotNull null
                    if (id !in allowedItemIds) return@mapNotNull null
                    val price = el.money("retailPrice") ?: return@mapNotNull null
                    PriceUpdate(itemId = id, retailPrice = price)
                }
                AiResult.Success(
                    if (updates.isEmpty()) {
                        OrderQuestionResolution.Unresolved("a correction naming no known product")
                    } else {
                        OrderQuestionResolution.PriceCorrection(updates)
                    },
                )
            }

            "PROFIT_QUERY" -> {
                val price = root.money("retailPrice")
                if (price == null || ids.isEmpty()) {
                    AiResult.Success(OrderQuestionResolution.Unresolved("an incomplete profit question"))
                } else {
                    AiResult.Success(OrderQuestionResolution.ProfitQuery(ids, price))
                }
            }

            "CASE_QUANTITY_QUERY" -> AiResult.Success(
                if (ids.isEmpty()) {
                    OrderQuestionResolution.Unresolved("no known item matched")
                } else {
                    OrderQuestionResolution.CaseQuantityQuery(ids)
                },
            )

            "GENERAL" -> {
                val reply = root.str("reply")
                    ?: return AiResult.Failure(AiError.MalformedResponse("a general answer with no text"))
                AiResult.Success(OrderQuestionResolution.General(reply))
            }

            null -> AiResult.Failure(AiError.MalformedResponse("the reply had no \"kind\""))

            else -> AiResult.Success(OrderQuestionResolution.Unresolved("an unrecognised answer type"))
        }
    }
}
