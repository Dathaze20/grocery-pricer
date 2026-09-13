package com.grocerypricer.app.data.db.entity

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * One conversation, belonging to one order.
 *
 * Kept as its own row rather than derived from the messages so an order can be reopened weeks
 * later and still show the thread the shopkeeper had with it.
 */
@Entity(
    tableName = "chat_sessions",
    foreignKeys = [
        ForeignKey(
            entity = OrderEntity::class,
            parentColumns = ["id"],
            childColumns = ["orderId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index(value = ["orderId"], unique = true)],
)
data class ChatSessionEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val orderId: Long,
    val createdAt: Long,
    val updatedAt: Long,
)

/**
 * One line of the conversation.
 *
 * [resolvedItemIdsJson] is what makes "number two should be 7.99" work: when the assistant lists
 * products, the ids it listed are stored against that message in the order they were shown, so a
 * later ordinal resolves against what was actually on screen rather than against a guess.
 */
@Entity(
    tableName = "chat_messages",
    foreignKeys = [
        ForeignKey(
            entity = ChatSessionEntity::class,
            parentColumns = ["id"],
            childColumns = ["sessionId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("sessionId"), Index("createdAt")],
)
data class ChatMessageEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val sessionId: Long,
    /** `user` or `assistant`. */
    val role: String,
    val text: String,
    /** A photograph the user attached, copied into app storage. */
    val attachedImagePath: String? = null,
    /** JSON array of order-item ids, in the order they were shown. */
    val resolvedItemIdsJson: String? = null,
    /** True while the assistant is still working, so a restart can clear it. */
    val pending: Boolean = false,
    val createdAt: Long,
)

/**
 * What happened the last time this order was processed.
 *
 * Deliberately holds no credential of any kind - just which provider and model ran, how many
 * photographs went in, and what went wrong if anything did.
 */
@Entity(
    tableName = "ai_extraction_metadata",
    foreignKeys = [
        ForeignKey(
            entity = OrderEntity::class,
            parentColumns = ["id"],
            childColumns = ["orderId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index("orderId")],
)
data class AiExtractionMetadataEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val orderId: Long,
    val provider: String,
    val model: String,
    val processedAt: Long,
    val inputImageCount: Int,
    val itemsExtracted: Int,
    val itemsRejected: Int,
    val successful: Boolean,
    /** An [com.grocerypricer.core.ai.AiError] class name, never a message that could carry a key. */
    val errorType: String? = null,
)
