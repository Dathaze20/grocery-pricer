package com.grocerypricer.app.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.grocerypricer.app.data.model.Order
import com.grocerypricer.app.di.AppContainer
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * What the V2 home screen needs, which is very little.
 *
 * The order summary that used to live here - wholesale value, estimated retail, gross profit,
 * average margin - is gone from this screen, and so is the work of computing it on every
 * recomposition of a screen that is mostly two buttons. It is still available in Order Details.
 */
data class HomeUiState(
    val currentOrder: Order? = null,
    val recentOrders: List<Order> = emptyList(),
    val aiConfigured: Boolean = true,
    val loading: Boolean = true,
)

class HomeViewModel(private val container: AppContainer) : ViewModel() {

    val state: StateFlow<HomeUiState> = combine(
        container.settingsRepository.settings,
        container.orderRepository.observeOrders(),
    ) { settings, orders ->
        HomeUiState(
            // The order the user last worked on, falling back to the newest one they have.
            currentOrder = orders.firstOrNull { it.id == settings.currentOrderId }
                ?: orders.firstOrNull(),
            recentOrders = orders.take(RECENT_ORDERS),
            aiConfigured = container.secureKeyStore.hasApiKey(),
            loading = false,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), HomeUiState())

    fun setCurrentOrder(orderId: Long) {
        viewModelScope.launch { container.settingsRepository.setCurrentOrder(orderId) }
    }

    companion object {
        private const val RECENT_ORDERS = 5

        fun factory(container: AppContainer): ViewModelProvider.Factory = viewModelFactory {
            initializer { HomeViewModel(container) }
        }
    }
}
