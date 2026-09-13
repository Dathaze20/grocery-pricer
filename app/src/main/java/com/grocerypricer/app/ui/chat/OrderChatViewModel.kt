package com.grocerypricer.app.ui.chat

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.grocerypricer.app.ai.ImagePreparer
import com.grocerypricer.app.chat.ChatMessage
import com.grocerypricer.app.chat.ChatRepository
import com.grocerypricer.app.chat.ConversationEngine
import com.grocerypricer.app.data.files.ImageStore
import com.grocerypricer.app.data.model.Order
import com.grocerypricer.app.data.repository.OrderRepository
import com.grocerypricer.app.di.AppContainer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.io.File

data class OrderChatUiState(
    val order: Order? = null,
    val itemCount: Int = 0,
    val needsAttentionCount: Int = 0,
    val messages: List<ChatMessage> = emptyList(),
    val sending: Boolean = false,
    /** What the small indicator says while the answer is worked out. */
    val workingMessage: String? = null,
    val attachmentPath: String? = null,
    val aiConfigured: Boolean = true,
)

/**
 * Drives the conversation screen.
 *
 * Everything slow happens off the main thread and the transcript is a Room-backed flow, so the
 * screen survives rotation, process death and the user wandering off mid-question.
 */
@Suppress("OPT_IN_USAGE")
class OrderChatViewModel(
    private val orderId: Long,
    private val container: AppContainer,
) : ViewModel() {

    private val orderRepository: OrderRepository = container.orderRepository
    private val chatRepository: ChatRepository = container.chatRepository
    private val conversation: ConversationEngine = container.conversationEngine
    private val imageStore: ImageStore = container.imageStore

    private val sessionId = MutableStateFlow(0L)

    private val local = MutableStateFlow(OrderChatUiState())
    val state: StateFlow<OrderChatUiState> = local.asStateFlow()

    private val messages: StateFlow<List<ChatMessage>> = sessionId
        .flatMapLatest { id ->
            if (id == 0L) flowOf(emptyList()) else chatRepository.observeMessages(id)
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    init {
        viewModelScope.launch {
            // A pending bubble left behind by a crash is noise, not history.
            chatRepository.clearPending()
            val id = chatRepository.sessionFor(orderId)
            sessionId.value = id

            val order = orderRepository.getOrder(orderId)
            val items = orderRepository.getItems(orderId)
            local.value = local.value.copy(
                order = order,
                itemCount = items.size,
                needsAttentionCount = items.count {
                    it.confidence == com.grocerypricer.core.model.ItemConfidence.PROBLEM
                },
                aiConfigured = container.secureKeyStore.hasApiKey(),
            )

            // The opening line, written once per order.
            if (!chatRepository.hasMessages(id)) {
                chatRepository.addAssistantMessage(id, openingMessage(items.size, local.value.needsAttentionCount))
            }
        }

        viewModelScope.launch {
            messages.collect { list -> local.value = local.value.copy(messages = list) }
        }
    }

    /**
     * The first thing the order says.
     *
     * It names a number and then gets out of the way. Uncertain rows are mentioned but never
     * listed: dumping them into the conversation would be the V1 review screen wearing a
     * different hat.
     */
    private fun openingMessage(itemCount: Int, needingAttention: Int): String = when {
        itemCount == 0 ->
            "I could not read any products from those photos. Try Check Receipt Data to see what I got."
        needingAttention == 0 ->
            "Order ready. I found $itemCount products from your receipt photos. " +
                "Ask me what anything cost or what you should charge."
        else ->
            "Order ready. I found $itemCount products. $needingAttention " +
                (if (needingAttention == 1) "has" else "have") +
                " uncertain receipt details, and I'll only ask if one matters to your question."
    }

    fun attach(uri: Uri) {
        viewModelScope.launch {
            val copied = imageStore.copyIn(uri, orderId)
            local.value = local.value.copy(attachmentPath = copied?.absolutePath)
        }
    }

    fun attachFile(path: String) {
        local.value = local.value.copy(attachmentPath = path)
    }

    fun clearAttachment() {
        local.value = local.value.copy(attachmentPath = null)
    }

    fun send(text: String) {
        val trimmed = text.trim()
        val attachment = local.value.attachmentPath
        if (trimmed.isEmpty() && attachment == null) return
        val session = sessionId.value
        if (session == 0L) return

        viewModelScope.launch {
            local.value = local.value.copy(
                sending = true,
                workingMessage = if (attachment != null) "Looking at the photo..." else "Checking this order...",
                attachmentPath = null,
            )

            chatRepository.addUserMessage(session, trimmed, attachment)

            val prepared = attachment?.let { path ->
                ImagePreparer.prepare(File(path), photoId = 0L)
            }

            val reply = conversation.reply(
                orderId = orderId,
                message = trimmed,
                attachment = prepared,
                history = chatRepository.recentTurns(session, HISTORY_TURNS),
                lastListedItemIds = chatRepository.lastListedItemIds(session),
                provider = container.aiProviderOrNull(),
            )

            chatRepository.addAssistantMessage(session, reply.text, reply.listedItemIds)

            // A saved price changes what the rest of the order is worth, so refresh the header.
            if (reply.savedPrices.isNotEmpty()) {
                val items = orderRepository.getItems(orderId)
                local.value = local.value.copy(itemCount = items.size)
            }

            local.value = local.value.copy(sending = false, workingMessage = null)
        }
    }

    companion object {
        private const val HISTORY_TURNS = 8

        fun factory(container: AppContainer, orderId: Long): ViewModelProvider.Factory =
            viewModelFactory { initializer { OrderChatViewModel(orderId, container) } }
    }
}
