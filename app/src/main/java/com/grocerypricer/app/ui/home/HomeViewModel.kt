package com.grocerypricer.app.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.grocerypricer.app.data.model.Order
import com.grocerypricer.app.data.model.OrderSummary
import com.grocerypricer.app.di.AppContainer
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class HomeUiState(
    val currentOrder: Order? = null,
    val summary: OrderSummary = OrderSummary(),
    val productCount: Int = 0,
    val loading: Boolean = true,
)

class HomeViewModel(private val container: AppContainer) : ViewModel() {

    private val currentOrder = combine(
        container.settingsRepository.settings,
        container.orderRepository.observeOrders(),
    ) { settings, orders ->
        orders.firstOrNull { it.id == settings.currentOrderId } ?: orders.firstOrNull()
    }

    val state: StateFlow<HomeUiState> = combine(
        currentOrder,
        container.productRepository.observeCount(),
        container.pricingRulesRepository.rules,
    ) { order, productCount, rules -> Triple(order, productCount, rules) }
        .flatMapLatest { (order, productCount, rules) ->
            if (order == null) {
                flowOf(HomeUiState(productCount = productCount, loading = false))
            } else {
                container.orderRepository.observeItems(order.id).map { items ->
                    HomeUiState(
                        currentOrder = order,
                        summary = container.orderRepository.summarise(items, rules),
                        productCount = productCount,
                        loading = false,
                    )
                }
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), HomeUiState())

    fun setCurrentOrder(orderId: Long) {
        viewModelScope.launch { container.settingsRepository.setCurrentOrder(orderId) }
    }

    companion object {
        fun factory(container: AppContainer): ViewModelProvider.Factory = viewModelFactory {
            initializer { HomeViewModel(container) }
        }
    }
}
