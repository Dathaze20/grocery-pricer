package com.grocerypricer.app.chat

import com.grocerypricer.app.data.model.OrderItem
import com.grocerypricer.app.data.repository.OrderRepository
import com.grocerypricer.app.data.repository.ProductRepository
import com.grocerypricer.core.ai.AiError
import com.grocerypricer.core.ai.AiImage
import com.grocerypricer.core.ai.AiProvider
import com.grocerypricer.core.ai.AiResult
import com.grocerypricer.core.ai.ConversationTurn
import com.grocerypricer.core.ai.OrderQuestionRequest
import com.grocerypricer.core.ai.OrderQuestionResolution
import com.grocerypricer.core.ai.ProductIdentificationRequest
import com.grocerypricer.core.ai.QuestionCandidate
import com.grocerypricer.core.chat.ChatAnswerFormatter
import com.grocerypricer.core.chat.ChatIntent
import com.grocerypricer.core.chat.ChatIntentParser
import com.grocerypricer.core.chat.CorrectionTarget
import com.grocerypricer.core.chat.PriceAnswer
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.query.OrderQueryEngine
import com.grocerypricer.core.query.QueryOutcome
import com.grocerypricer.core.query.QueryRequest

/** What one turn of conversation produced. */
data class ChatReply(
    val text: String,
    /** Items the reply listed, in the order shown, so "number two" resolves next turn. */
    val listedItemIds: List<Long> = emptyList(),
    /** Shelf prices the user confirmed this turn. */
    val savedPrices: List<Pair<Long, Money>> = emptyList(),
)

/**
 * Decides what to do with a sentence.
 *
 * The routing order is the whole cost-and-speed story of V2. Every question is tried locally
 * first, because most of them have exactly one answer already sitting in the database and paying
 * a cloud model to find it would be slower, cost the shopkeeper money, and work no better. The
 * model is called for what it is genuinely needed for: photographs, real ambiguity, and sentences
 * that refer back to the conversation.
 *
 * When the model is called, it is asked to pick an item id - never to state a price. The answer is
 * then built from the row, so what the shopkeeper reads is always the database's number.
 */
class ConversationEngine(
    private val orderRepository: OrderRepository,
    private val productRepository: ProductRepository,
) {

    suspend fun reply(
        orderId: Long,
        message: String,
        attachment: AiImage?,
        history: List<ConversationTurn>,
        lastListedItemIds: List<Long>,
        provider: AiProvider?,
    ): ChatReply {
        val items = orderRepository.getItems(orderId)
        if (items.isEmpty()) {
            return ChatReply("This order has no products in it yet.")
        }
        val engine = OrderQueryEngine(items.map { OrderItemQueryView(it) })
        val byId = items.associateBy { it.id }

        // A photograph is the one thing that always needs the model: nothing on the device can
        // tell a Downy bottle from a Mr. Clean bottle.
        if (attachment != null) {
            return replyToPhoto(orderId, message, attachment, engine, byId, provider)
        }

        when (val intent = ChatIntentParser.parse(message)) {
            is ChatIntent.Correction ->
                return applyCorrections(intent.targets, engine, byId, lastListedItemIds)

            is ChatIntent.CaseQuantity -> {
                val target = resolveOrContext(intent.request, engine, lastListedItemIds, byId)
                if (target != null) {
                    return ChatReply(
                        ChatAnswerFormatter.caseQuantity(answerFor(target)),
                        listedItemIds = listOf(target.id),
                    )
                }
            }

            is ChatIntent.ProfitAt -> {
                val target = intent.request
                    ?.let { (engine.resolve(it) as? QueryOutcome.Exact)?.item?.productId?.let(byId::get) }
                    ?: lastListedItemIds.firstOrNull()?.let(byId::get)
                if (target != null) {
                    return ChatReply(
                        ChatAnswerFormatter.profitAt(answerFor(target), intent.retailPrice),
                        listedItemIds = listOf(target.id),
                    )
                }
            }

            is ChatIntent.CostUnder -> {
                val matches = engine.costingUnder(intent.limit).mapNotNull { byId[it.productId] }
                return listReply(matches, "Nothing in this order costs under ${intent.limit.format()}.")
            }

            is ChatIntent.CostOver -> {
                val matches = engine.costingOver(intent.limit).mapNotNull { byId[it.productId] }
                return listReply(matches, "Nothing in this order costs over ${intent.limit.format()}.")
            }

            is ChatIntent.LastCharged -> {
                val target = resolveOrContext(intent.request, engine, lastListedItemIds, byId)
                if (target != null) return ChatReply(lastChargedText(target), listOf(target.id))
            }

            ChatIntent.OrderSummary -> return ChatReply(summaryText(items))

            is ChatIntent.PriceLookup ->
                resolveLocally(intent.request, engine, byId)?.let { return it }

            ChatIntent.Unknown -> {
                // A bare phrase - "8 oz", or a product name typed on its own - is a perfectly
                // normal thing to send, and usually resolves without help.
                resolveLocally(QueryRequest(message), engine, byId)?.let { return it }
            }
        }

        return escalate(message, engine, byId, history, lastListedItemIds, provider, null)
    }

    // ------------------------------------------------------------------ local paths

    /** Returns null when the local engine could not settle it, so the caller can escalate. */
    private fun resolveLocally(
        request: QueryRequest,
        engine: OrderQueryEngine,
        byId: Map<Long, OrderItem>,
    ): ChatReply? = when (val outcome = engine.resolve(request)) {
        is QueryOutcome.Exact -> byId[outcome.item.productId]?.let { item ->
            ChatReply(ChatAnswerFormatter.single(answerFor(item)), listOf(item.id))
        }

        is QueryOutcome.Several -> {
            val items = outcome.items.mapNotNull { byId[it.productId] }
            listReply(items, "I could not find those in this order.")
        }

        // Ambiguity is exactly what the model is for - unless the difference is only the size,
        // which is a question the app can ask perfectly well by itself and for free.
        is QueryOutcome.Ambiguous -> sizeClarification(outcome.candidates.mapNotNull { byId[it.productId] })

        QueryOutcome.None -> null
    }

    /**
     * "Which one - 8 oz or 15 oz?"
     *
     * Only offered when the candidates really are one product in several sizes. Anything more
     * tangled than that goes to the model rather than producing a confusing question.
     */
    private fun sizeClarification(candidates: List<OrderItem>): ChatReply? {
        if (candidates.size < 2) return null
        val names = candidates.map { it.description.trim().lowercase() }.distinct()
        if (names.size != 1) return null
        val sizes = candidates.mapNotNull { it.size?.trim() }.distinct()
        if (sizes.size != candidates.size) return null
        return ChatReply(
            "Which one - " + sizes.joinToString(" or ") + "?",
            listedItemIds = candidates.map { it.id },
        )
    }

    private fun listReply(items: List<OrderItem>, emptyMessage: String): ChatReply {
        if (items.isEmpty()) return ChatReply(emptyMessage)
        return ChatReply(
            ChatAnswerFormatter.numbered(items.map { answerFor(it) }),
            listedItemIds = items.map { it.id },
        )
    }

    /** Falls back to whatever was last being discussed, which is what "it" usually means. */
    private fun resolveOrContext(
        request: QueryRequest,
        engine: OrderQueryEngine,
        lastListedItemIds: List<Long>,
        byId: Map<Long, OrderItem>,
    ): OrderItem? {
        if (request.phrase.isNotBlank()) {
            (engine.resolve(request) as? QueryOutcome.Exact)?.let { return byId[it.item.productId] }
        }
        return lastListedItemIds.singleOrNull()?.let(byId::get)
            ?: lastListedItemIds.firstOrNull()?.let(byId::get)
    }

    // ------------------------------------------------------------------ corrections

    /**
     * Saves what the shopkeeper actually charges.
     *
     * This is the one path that writes, so it refuses to act on a guess: a target that cannot be
     * resolved to a specific row is reported rather than applied to a plausible one.
     */
    private suspend fun applyCorrections(
        targets: List<CorrectionTarget>,
        engine: OrderQueryEngine,
        byId: Map<Long, OrderItem>,
        lastListedItemIds: List<Long>,
    ): ChatReply {
        val updates = mutableListOf<Pair<OrderItem, Money>>()

        for (target in targets) {
            val item: OrderItem? = when (target) {
                is CorrectionTarget.Ordinal ->
                    lastListedItemIds.getOrNull(target.position - 1)?.let(byId::get)

                is CorrectionTarget.Named ->
                    (engine.resolve(QueryRequest(target.phrase)) as? QueryOutcome.Exact)
                        ?.item?.productId?.let(byId::get)

                is CorrectionTarget.Current ->
                    lastListedItemIds.singleOrNull()?.let(byId::get)

                is CorrectionTarget.AllListed -> null
            }

            if (target is CorrectionTarget.AllListed) {
                lastListedItemIds.mapNotNull(byId::get).forEach { updates += it to target.price }
                continue
            }
            if (item != null) updates += item to target.price
        }

        if (updates.isEmpty()) {
            return ChatReply(
                "I am not sure which product you mean. Ask me about it first, then tell me the price.",
            )
        }

        updates.forEach { (item, price) -> orderRepository.approvePrice(item.id, price) }

        val refreshed = updates.map { (item, price) ->
            (orderRepository.getItem(item.id) ?: item) to price
        }
        return ChatReply(
            text = ChatAnswerFormatter.savedPrices(refreshed.map { answerFor(it.first) to it.second }),
            listedItemIds = refreshed.map { it.first.id },
            savedPrices = refreshed.map { it.first.id to it.second },
        )
    }

    // ------------------------------------------------------------------ the model

    private suspend fun replyToPhoto(
        orderId: Long,
        message: String,
        attachment: AiImage,
        engine: OrderQueryEngine,
        byId: Map<Long, OrderItem>,
        provider: AiProvider?,
    ): ChatReply {
        provider ?: return ChatReply(AiError.MissingKey.userMessage())

        val identified = provider.identifyProducts(
            ProductIdentificationRequest(image = attachment, question = message.takeIf { it.isNotBlank() }),
        )
        if (identified is AiResult.Failure) return ChatReply(identified.error.userMessage())

        val sightings = (identified as AiResult.Success).value.products
        if (sightings.isEmpty()) {
            return ChatReply("I could not make out a product in that photo. Try a closer shot of the label.")
        }

        // Each thing the model says it can see is looked up locally, in the order it appears in
        // the picture, so "the second one" keeps meaning what the shopkeeper pointed at.
        val matched = sightings.sortedBy { it.position }.mapNotNull { sighting ->
            sighting.upc?.let { engine.byBarcode(it) }?.productId?.let(byId::get)
                ?: (engine.resolve(QueryRequest(sighting.toSearchText())) as? QueryOutcome.Exact)
                    ?.item?.productId?.let(byId::get)
        }

        if (matched.isEmpty()) {
            val names = sightings.mapNotNull { it.toSearchText().takeIf(String::isNotBlank) }
            return ChatReply(
                if (names.isEmpty()) {
                    "I could not match that to anything on this order."
                } else {
                    "I can see " + names.joinToString(", ") + ", but none of those are on this order."
                },
            )
        }

        return listReply(matched, "I could not match that to anything on this order.")
    }

    /**
     * Hands the question to the model, with a shortlist rather than the whole order.
     *
     * Sending every row would cost the shopkeeper money on every question and make the model's
     * job harder, not easier.
     */
    private suspend fun escalate(
        message: String,
        engine: OrderQueryEngine,
        byId: Map<Long, OrderItem>,
        history: List<ConversationTurn>,
        lastListedItemIds: List<Long>,
        provider: AiProvider?,
        attachment: AiImage?,
    ): ChatReply {
        provider ?: return ChatReply(
            "I can still search this order, but a question like that needs an internet connection. " +
                "Try naming the product, for example \"Hellmann's mayonnaise 8 oz\".",
        )

        val candidates = engine.candidatesFor(message).mapNotNull { view ->
            byId[view.productId]?.let { item ->
                QuestionCandidate(
                    itemId = item.id,
                    name = item.description,
                    size = item.size,
                    category = item.category.displayName,
                    unitsPerCase = item.unitsPerCase,
                )
            }
        }

        val result = provider.resolveQuestion(
            OrderQuestionRequest(
                question = message,
                candidates = candidates,
                history = history.takeLast(MAX_HISTORY_TURNS),
                lastListedItemIds = lastListedItemIds,
                attachedImage = attachment,
            ),
        )

        return when (result) {
            is AiResult.Failure -> ChatReply(result.error.userMessage())
            is AiResult.Success -> renderResolution(result.value, byId, lastListedItemIds)
        }
    }

    private suspend fun renderResolution(
        resolution: OrderQuestionResolution,
        byId: Map<Long, OrderItem>,
        lastListedItemIds: List<Long>,
    ): ChatReply = when (resolution) {
        is OrderQuestionResolution.ProductMatches ->
            listReply(resolution.itemIds.mapNotNull(byId::get), "I could not find that in this order.")

        is OrderQuestionResolution.CategoryMatches ->
            listReply(resolution.itemIds.mapNotNull(byId::get), "Nothing in this order is in that group.")

        is OrderQuestionResolution.Clarification ->
            ChatReply(ChatAnswerFormatter.clarification(resolution.question), lastListedItemIds)

        is OrderQuestionResolution.CaseQuantityQuery -> {
            val item = resolution.itemIds.firstNotNullOfOrNull(byId::get)
            if (item == null) {
                ChatReply("I could not find that in this order.")
            } else {
                ChatReply(ChatAnswerFormatter.caseQuantity(answerFor(item)), listOf(item.id))
            }
        }

        is OrderQuestionResolution.ProfitQuery -> {
            val item = resolution.itemIds.firstNotNullOfOrNull(byId::get)
            val price = Money.parseOrNull(resolution.retailPrice)
            if (item == null || price == null) {
                ChatReply("I could not work out which product or which price you meant.")
            } else {
                ChatReply(ChatAnswerFormatter.profitAt(answerFor(item), price), listOf(item.id))
            }
        }

        is OrderQuestionResolution.PriceCorrection -> {
            // The model resolved which product; the price still goes through Money, and a string
            // it could not parse is refused rather than saved.
            val parsed = resolution.updates.mapNotNull { update ->
                val item = byId[update.itemId] ?: return@mapNotNull null
                val price = Money.parseOrNull(update.retailPrice) ?: return@mapNotNull null
                item to price
            }
            if (parsed.isEmpty()) {
                ChatReply("I could not tell which price you meant.")
            } else {
                parsed.forEach { (item, price) -> orderRepository.approvePrice(item.id, price) }
                val refreshed = parsed.map { (item, price) ->
                    (orderRepository.getItem(item.id) ?: item) to price
                }
                ChatReply(
                    text = ChatAnswerFormatter.savedPrices(refreshed.map { answerFor(it.first) to it.second }),
                    listedItemIds = refreshed.map { it.first.id },
                    savedPrices = refreshed.map { it.first.id to it.second },
                )
            }
        }

        is OrderQuestionResolution.General -> ChatReply(resolution.reply, lastListedItemIds)

        is OrderQuestionResolution.Unresolved ->
            ChatReply("I could not work out which product you meant. Try naming it and its size.")
    }

    // ------------------------------------------------------------------ answers

    private suspend fun answerFor(item: OrderItem): PriceAnswer {
        val product = item.productId?.let { productRepository.getById(it) }
        val previousCost = product?.lastUnitCost?.takeIf { it != item.cost.trueUnitCost }
        return item.toPriceAnswer(product = product, previousUnitCost = previousCost)
    }

    private suspend fun lastChargedText(item: OrderItem): String {
        val product = item.productId?.let { productRepository.getById(it) }
        val previous = product?.lastRetailPrice
        val answer = answerFor(item)
        return if (previous == null) {
            answer.title + "\nYou have not set a price for this one before."
        } else {
            answer.title + "\nLast time you charged " + previous.format() + "."
        }
    }

    private fun summaryText(items: List<OrderItem>): String {
        val priced = items.count { it.approvedPrice != null }
        return buildString {
            append(items.size).append(" products in this order.\n")
            append(priced).append(" have a price you confirmed")
            if (priced != items.size) {
                append("; ").append(items.size - priced).append(" are using my suggestion")
            }
            append('.')
        }
    }

    private companion object {
        /** Enough for the model to resolve "the 8 oz one", not enough to re-send the whole day. */
        const val MAX_HISTORY_TURNS = 8
    }
}
