package com.grocerypricer.app.chat

import com.grocerypricer.app.data.db.GroceryPricerDatabase
import com.grocerypricer.app.data.db.entity.ChatMessageEntity
import com.grocerypricer.app.data.db.entity.ChatSessionEntity
import com.grocerypricer.app.data.model.ChatRole
import com.grocerypricer.core.ai.ConversationTurn
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import org.json.JSONArray

/** One line of the conversation, as the UI wants it. */
data class ChatMessage(
    val id: Long,
    val role: ChatRole,
    val text: String,
    val attachedImagePath: String? = null,
    val listedItemIds: List<Long> = emptyList(),
    val pending: Boolean = false,
    val createdAt: Long,
)

/**
 * The conversation, kept.
 *
 * The brief asks that closing the app, or restarting the phone, does not lose the thread - and it
 * matters for more than tidiness: "number two should be 7.99" only means anything if the app
 * still knows which products it listed, so the ids behind each assistant message are stored with
 * it rather than held in memory.
 */
class ChatRepository(
    database: GroceryPricerDatabase,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val chatDao = database.chatDao()

    /** The conversation for an order, created on first use. */
    suspend fun sessionFor(orderId: Long): Long {
        chatDao.sessionForOrder(orderId)?.let { return it.id }
        val timestamp = now()
        val inserted = chatDao.insertSession(
            ChatSessionEntity(orderId = orderId, createdAt = timestamp, updatedAt = timestamp),
        )
        // The unique index on orderId means a race loses the insert rather than duplicating.
        return if (inserted > 0) inserted else chatDao.sessionForOrder(orderId)!!.id
    }

    fun observeMessages(sessionId: Long): Flow<List<ChatMessage>> =
        chatDao.observeMessages(sessionId).map { rows -> rows.map { it.toChatMessage() } }

    suspend fun addUserMessage(
        sessionId: Long,
        text: String,
        attachedImagePath: String? = null,
    ): Long = insert(
        sessionId = sessionId,
        role = ChatRole.USER,
        text = text,
        attachedImagePath = attachedImagePath,
    )

    suspend fun addAssistantMessage(
        sessionId: Long,
        text: String,
        listedItemIds: List<Long> = emptyList(),
    ): Long = insert(
        sessionId = sessionId,
        role = ChatRole.ASSISTANT,
        text = text,
        listedItemIds = listedItemIds,
    )

    /** A placeholder shown while the answer is being worked out. */
    suspend fun addPendingAssistantMessage(sessionId: Long, text: String): Long =
        insert(sessionId = sessionId, role = ChatRole.ASSISTANT, text = text, pending = true)

    suspend fun resolvePending(messageId: Long, text: String, listedItemIds: List<Long>) {
        val existing = chatDao.messageById(messageId)
        if (existing != null) {
            chatDao.updateMessage(
                existing.copy(
                    text = text,
                    resolvedItemIdsJson = listedItemIds.toJsonOrNull(),
                    pending = false,
                ),
            )
        }
    }

    /** The ids the assistant last listed, in the order they were shown. */
    suspend fun lastListedItemIds(sessionId: Long): List<Long> =
        chatDao.lastMessageWithItems(sessionId)?.resolvedItemIdsJson?.toLongList().orEmpty()

    /** Recent turns, oldest first, for handing to the model as context. */
    suspend fun recentTurns(sessionId: Long, limit: Int): List<ConversationTurn> =
        chatDao.messages(sessionId)
            .filterNot { it.pending }
            .takeLast(limit)
            .map { ConversationTurn(role = it.role, text = it.text) }

    suspend fun hasMessages(sessionId: Long): Boolean = chatDao.messages(sessionId).isNotEmpty()

    /** A message left mid-flight by a crash or a force-stop is not worth showing again. */
    suspend fun clearPending() = chatDao.clearPending()

    suspend fun deleteMessage(id: Long) = chatDao.deleteMessage(id)

    private suspend fun insert(
        sessionId: Long,
        role: ChatRole,
        text: String,
        attachedImagePath: String? = null,
        listedItemIds: List<Long> = emptyList(),
        pending: Boolean = false,
    ): Long {
        val timestamp = now()
        val id = chatDao.insertMessage(
            ChatMessageEntity(
                sessionId = sessionId,
                role = role.storedName,
                text = text,
                attachedImagePath = attachedImagePath,
                resolvedItemIdsJson = listedItemIds.toJsonOrNull(),
                pending = pending,
                createdAt = timestamp,
            ),
        )
        chatDao.touchSession(sessionId, timestamp)
        return id
    }

    private fun ChatMessageEntity.toChatMessage() = ChatMessage(
        id = id,
        role = ChatRole.fromName(role),
        text = text,
        attachedImagePath = attachedImagePath,
        listedItemIds = resolvedItemIdsJson.toLongList(),
        pending = pending,
        createdAt = createdAt,
    )
}

private fun List<Long>.toJsonOrNull(): String? =
    takeIf { it.isNotEmpty() }?.let { ids -> JSONArray().apply { ids.forEach { put(it) } }.toString() }

private fun String?.toLongList(): List<Long> {
    if (this.isNullOrBlank()) return emptyList()
    return try {
        val array = JSONArray(this)
        (0 until array.length()).map { array.getLong(it) }
    } catch (e: Exception) {
        emptyList()
    }
}
