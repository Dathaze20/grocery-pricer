package com.grocerypricer.app.ui.order

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.grocerypricer.app.data.model.CostMovement
import com.grocerypricer.app.data.model.Order
import com.grocerypricer.app.data.model.OrderItem
import com.grocerypricer.app.data.model.OrderSummary
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.export.CsvExporter
import com.grocerypricer.core.model.PricingRules
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

enum class PriceListSort(val displayName: String) {
    UNPRICED_FIRST("Unpriced first"),
    NAME("Name"),
    CATEGORY("Category"),
    COST("Cost"),
    RETAIL("Retail price"),
}

data class OrderUiState(
    val order: Order? = null,
    val items: List<OrderItem> = emptyList(),
    val summary: OrderSummary = OrderSummary(),
    val rules: PricingRules = PricingRules(),
)

class OrderViewModel(
    private val container: AppContainer,
    private val orderId: Long,
) : ViewModel() {

    val state: StateFlow<OrderUiState> = combine(
        container.orderRepository.observeOrder(orderId),
        container.orderRepository.observeItems(orderId),
        container.pricingRulesRepository.rules,
    ) { order, items, rules ->
        OrderUiState(
            order = order,
            items = items,
            summary = container.orderRepository.summarise(items, rules),
            rules = rules,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), OrderUiState())

    private val _costMovements = MutableStateFlow<List<CostMovement>>(emptyList())
    val costMovements: StateFlow<List<CostMovement>> = _costMovements.asStateFlow()

    private val _sort = MutableStateFlow(PriceListSort.UNPRICED_FIRST)
    val sort: StateFlow<PriceListSort> = _sort.asStateFlow()

    init {
        refreshCostMovements()
    }

    fun refreshCostMovements() {
        viewModelScope.launch {
            val rules = container.pricingRulesRepository.current()
            _costMovements.value = runCatching {
                container.orderRepository.costMovements(orderId, rules)
            }.getOrDefault(emptyList())
        }
    }

    fun setSort(value: PriceListSort) {
        _sort.value = value
    }

    fun sortedItems(items: List<OrderItem>, sort: PriceListSort): List<OrderItem> = when (sort) {
        PriceListSort.UNPRICED_FIRST -> items.sortedWith(
            compareBy<OrderItem> { it.priceApproved }.thenBy { it.description.lowercase() }
        )
        PriceListSort.NAME -> items.sortedBy { it.description.lowercase() }
        PriceListSort.CATEGORY -> items.sortedWith(
            compareBy<OrderItem> { it.category.displayName }.thenBy { it.description.lowercase() }
        )
        PriceListSort.COST -> items.sortedByDescending { it.cost.trueUnitCost.amount }
        PriceListSort.RETAIL -> items.sortedByDescending { (it.effectivePrice ?: com.grocerypricer.core.money.Money.ZERO).amount }
    }

    /** Builds the order CSV. The screen hands it to whatever file the user picked. */
    suspend fun buildCsv(): Pair<String, String>? {
        val order = container.orderRepository.getOrder(orderId) ?: return null
        val items = container.orderRepository.getItems(orderId)
        return CsvExporter.orderFileName(order) to CsvExporter.orderCsv(order, items)
    }

    fun approvePrice(item: OrderItem, price: com.grocerypricer.core.money.Money) {
        viewModelScope.launch { container.orderRepository.approvePrice(item.id, price) }
    }

    fun deleteOrder(onDone: () -> Unit) {
        viewModelScope.launch {
            container.orderRepository.deleteOrder(orderId)
            onDone()
        }
    }

    companion object {
        fun factory(container: AppContainer, orderId: Long): ViewModelProvider.Factory = viewModelFactory {
            initializer { OrderViewModel(container, orderId) }
        }
    }
}
