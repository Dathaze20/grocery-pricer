package com.grocerypricer.app.ui.catalog

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.grocerypricer.app.data.model.PriceHistoryEntry
import com.grocerypricer.app.data.model.Product
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.export.CsvExporter
import com.grocerypricer.core.matching.ProductMatcher
import com.grocerypricer.core.money.Money
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class CatalogViewModel(private val container: AppContainer) : ViewModel() {

    private val _searchTerm = MutableStateFlow("")
    val searchTerm: StateFlow<String> = _searchTerm.asStateFlow()

    val products: StateFlow<List<Product>> = combine(
        container.productRepository.observeAll(),
        _searchTerm,
    ) { all, term ->
        if (term.isBlank()) all else ProductMatcher.search(term, all).filterIsInstance<Product>()
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val recentHistory: StateFlow<List<PriceHistoryEntry>> =
        container.productRepository.observeRecentPriceHistory(200)
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun setSearchTerm(term: String) {
        _searchTerm.value = term
    }

    suspend fun buildCatalogCsv(): Pair<String, String> =
        CsvExporter.catalogFileName() to CsvExporter.catalogCsv(container.productRepository.getAll())

    fun observeProduct(productId: Long) = container.productRepository.observeById(productId)

    fun observeHistory(productId: Long) = container.productRepository.observePriceHistory(productId)

    fun setOverridePrice(productId: Long, price: Money?) {
        viewModelScope.launch { container.productRepository.setOverridePrice(productId, price) }
    }

    fun setQuantityAdjustment(productId: Long, adjustment: Int) {
        viewModelScope.launch { container.productRepository.adjustQuantity(productId, adjustment) }
    }

    fun deleteProduct(product: Product, onDone: () -> Unit) {
        viewModelScope.launch {
            container.productRepository.delete(product)
            onDone()
        }
    }

    companion object {
        fun factory(container: AppContainer): ViewModelProvider.Factory = viewModelFactory {
            initializer { CatalogViewModel(container) }
        }
    }
}
