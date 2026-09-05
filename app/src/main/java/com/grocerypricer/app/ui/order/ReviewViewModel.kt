package com.grocerypricer.app.ui.order

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.grocerypricer.app.data.model.Order
import com.grocerypricer.app.data.model.OrderItem
import com.grocerypricer.app.data.model.OrderSummary
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.core.model.PricingRules
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ReviewUiState(
    val items: List<OrderItem> = emptyList(),
    val summary: OrderSummary = OrderSummary(),
    val rules: PricingRules = PricingRules(),
    val busy: Boolean = false,
    val message: String? = null,
)

class ReviewViewModel(
    private val container: AppContainer,
    private val orderId: Long,
) : ViewModel() {

    val order: StateFlow<Order?> = container.orderRepository.observeOrder(orderId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    private val _transient = MutableStateFlow(TransientState())
    val transient: StateFlow<TransientState> = _transient.asStateFlow()

    val state: StateFlow<ReviewUiState> = combine(
        container.orderRepository.observeItems(orderId),
        container.pricingRulesRepository.rules,
        _transient,
    ) { items, rules, transientState ->
        ReviewUiState(
            items = items,
            summary = container.orderRepository.summarise(items, rules),
            rules = rules,
            busy = transientState.busy,
            message = transientState.message,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ReviewUiState())

    fun setApproved(item: OrderItem, approved: Boolean) {
        viewModelScope.launch { container.orderRepository.setReviewApproved(item.id, approved) }
    }

    fun approveAllHighConfidence() {
        viewModelScope.launch {
            val count = container.orderRepository.approveAllHighConfidence(orderId)
            _transient.update {
                it.copy(
                    message = if (count == 0) {
                        "Nothing left to approve automatically - the remaining rows were flagged."
                    } else {
                        "Approved $count high-confidence item(s)."
                    },
                )
            }
        }
    }

    fun saveItem(item: OrderItem) {
        viewModelScope.launch {
            val rules = container.pricingRulesRepository.current()
            container.orderRepository.saveItem(item, rules)
        }
    }

    fun deleteItem(item: OrderItem) {
        viewModelScope.launch { container.orderRepository.deleteItem(item.id) }
    }

    /** Writes the approved rows into the permanent catalogue. */
    fun saveOrder(onDone: (Int) -> Unit) {
        viewModelScope.launch {
            _transient.update { it.copy(busy = true, message = null) }
            val saved = runCatching { container.orderRepository.commitOrder(orderId) }
            _transient.update { current ->
                saved.fold(
                    onSuccess = { count -> current.copy(busy = false, message = "Saved $count product(s) to the catalog.") },
                    onFailure = { error -> current.copy(busy = false, message = "Could not save this order: ${error.message}") },
                )
            }
            saved.getOrNull()?.let(onDone)
        }
    }

    fun clearMessage() {
        _transient.update { it.copy(message = null) }
    }

    data class TransientState(val busy: Boolean = false, val message: String? = null)

    companion object {
        fun factory(container: AppContainer, orderId: Long): ViewModelProvider.Factory = viewModelFactory {
            initializer { ReviewViewModel(container, orderId) }
        }
    }
}
