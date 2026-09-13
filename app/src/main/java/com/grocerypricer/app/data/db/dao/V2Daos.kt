package com.grocerypricer.app.data.db.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import com.grocerypricer.app.data.db.entity.AiExtractionMetadataEntity
import com.grocerypricer.app.data.db.entity.ChatMessageEntity
import com.grocerypricer.app.data.db.entity.ChatSessionEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface ChatDao {

    @Query("SELECT * FROM chat_sessions WHERE orderId = :orderId LIMIT 1")
    suspend fun sessionForOrder(orderId: Long): ChatSessionEntity?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertSession(session: ChatSessionEntity): Long

    @Query("UPDATE chat_sessions SET updatedAt = :at WHERE id = :sessionId")
    suspend fun touchSession(sessionId: Long, at: Long)

    /** Oldest first: a conversation reads downwards. */
    @Query("SELECT * FROM chat_messages WHERE sessionId = :sessionId ORDER BY createdAt ASC, id ASC")
    fun observeMessages(sessionId: Long): Flow<List<ChatMessageEntity>>

    @Query("SELECT * FROM chat_messages WHERE sessionId = :sessionId ORDER BY createdAt ASC, id ASC")
    suspend fun messages(sessionId: Long): List<ChatMessageEntity>

    /**
     * The most recent assistant message that actually listed products.
     *
     * This is what "number two should be 7.99" resolves against.
     */
    @Query(
        """
        SELECT * FROM chat_messages
        WHERE sessionId = :sessionId
          AND role = 'assistant'
          AND resolvedItemIdsJson IS NOT NULL
        ORDER BY createdAt DESC, id DESC
        LIMIT 1
        """,
    )
    suspend fun lastMessageWithItems(sessionId: Long): ChatMessageEntity?

    @Query("SELECT * FROM chat_messages WHERE id = :id")
    suspend fun messageById(id: Long): ChatMessageEntity?

    @Insert
    suspend fun insertMessage(message: ChatMessageEntity): Long

    @Update
    suspend fun updateMessage(message: ChatMessageEntity)

    @Query("DELETE FROM chat_messages WHERE id = :id")
    suspend fun deleteMessage(id: Long)

    /** A message left mid-flight by a crash or a force-stop is not worth showing again. */
    @Query("DELETE FROM chat_messages WHERE pending = 1")
    suspend fun clearPending()
}

@Dao
interface AiExtractionMetadataDao {

    @Insert
    suspend fun insert(metadata: AiExtractionMetadataEntity): Long

    @Query("SELECT * FROM ai_extraction_metadata WHERE orderId = :orderId ORDER BY processedAt DESC")
    suspend fun forOrder(orderId: Long): List<AiExtractionMetadataEntity>

    @Query("SELECT * FROM ai_extraction_metadata WHERE orderId = :orderId ORDER BY processedAt DESC LIMIT 1")
    suspend fun latestForOrder(orderId: Long): AiExtractionMetadataEntity?
}
