package com.grocerypricer.app.ui.scan

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.grocerypricer.app.data.model.OrderItem
import com.grocerypricer.app.data.model.PriceHistoryEntry
import com.grocerypricer.app.data.model.Product
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.core.matching.MatchOutcome
import com.grocerypricer.core.model.Category
import com.grocerypricer.core.model.CostChange
import com.grocerypricer.core.model.PricingSuggestion
import com.grocerypricer.core.money.Money
import com.grocerypricer.core.pricing.PricingEngine
import com.grocerypricer.core.pricing.ProfitCalculator
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File

/** What the pricing card is showing. */
data class PricingTarget(
    val title: String,
    val size: String? = null,
    val unitCost: Money? = null,
    val previousPrice: Money? = null,
    val suggestion: PricingSuggestion? = null,
    val costChange: CostChange? = null,
    val orderItemId: Long? = null,
    val productId: Long? = null,
    val barcode: String? = null,
    val inCurrentOrder: Boolean = false,
)

enum class ScanMode { SCANNING, RESULT, NOT_FOUND, CANDIDATES, SEARCH }

data class ScanUiState(
    val mode: ScanMode = ScanMode.SCANNING,
    val target: PricingTarget? = null,
    val candidates: List<PricingTarget> = emptyList(),
    val searchResults: List<PricingTarget> = emptyList(),
    val lastBarcode: String? = null,
    val message: String? = null,
    val busy: Boolean = false,
    val approvedCount: Int = 0,
)

/**
 * The pricing loop: scan, see the cost, approve a price, next product.
 *
 * A scan is looked up in the order being priced first, because that is where the fresh cost is,
 * and only then in the wider catalogue.
 */
class ScanViewModel(
    private val container: AppContainer,
    private val orderId: Long,
) : ViewModel() {

    private val _state = MutableStateFlow(ScanUiState())
    val state: StateFlow<ScanUiState> = _state.asStateFlow()

    fun onBarcodeScanned(barcode: String) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true, lastBarcode = barcode) }
            val target = resolveBarcode(barcode)
            _state.update {
                if (target == null) {
                    it.copy(mode = ScanMode.NOT_FOUND, target = null, busy = false, message = null)
                } else {
                    it.copy(mode = ScanMode.RESULT, target = target, busy = false, message = null)
                }
            }
        }
    }

    private suspend fun resolveBarcode(barcode: String): PricingTarget? {
        if (orderId > 0) {
            container.orderRepository.findInOrderByBarcode(orderId, barcode)?.let { item ->
                return buildTargetFromOrderItem(item, barcode)
            }
        }
        return when (val outcome = container.productRepository.findByBarcode(barcode)) {
            is MatchOutcome.Confident -> {
                val product = outcome.match.product as? Product ?: return null
                buildTargetFromProduct(product, barcode)
            }
            is MatchOutcome.Ambiguous -> {
                val targets = outcome.candidates.mapNotNull { candidate ->
                    (candidate.product as? Product)?.let { buildTargetFromProduct(it, barcode) }
                }
                _state.update { it.copy(candidates = targets) }
                targets.firstOrNull()
            }
            MatchOutcome.NoMatch -> null
        }
    }

    private suspend fun buildTargetFromOrderItem(item: OrderItem, barcode: String?): PricingTarget {
        val rules = container.pricingRulesRepository.current()
        val product = item.productId?.let { container.productRepository.getById(it) }
        val suggestion = PricingEngine(rules).suggest(
            unitCost = item.cost.trueUnitCost.takeIf { it.isPositive },
            category = item.category,
            previousRetailPrice = product?.lastRetailPrice,
            productOverridePrice = product?.overridePrice,
        )
        val costChange = product?.let { existing ->
            val previous = item.productId?.let { id ->
                container.productRepository.previousCost(id, System.currentTimeMillis())
            } ?: existing.lastUnitCost
            previous?.takeIf { it != item.cost.trueUnitCost }?.let {
                ProfitCalculator.compareCost(it, item.cost.trueUnitCost, rules.costChangeAlertPercent)
            }
        }
        return PricingTarget(
            title = item.description.ifBlank { "Unnamed product" },
            size = item.size,
            unitCost = item.cost.trueUnitCost,
            previousPrice = product?.lastRetailPrice,
            suggestion = suggestion,
            costChange = costChange?.takeIf { it.exceedsThreshold },
            orderItemId = item.id,
            productId = item.productId,
            barcode = barcode ?: item.upc,
            inCurrentOrder = true,
        )
    }

    private suspend fun buildTargetFromProduct(product: Product, barcode: String?): PricingTarget {
        val rules = container.pricingRulesRepository.current()
        val suggestion = PricingEngine(rules).suggest(
            unitCost = product.lastUnitCost,
            category = product.category,
            previousRetailPrice = product.lastRetailPrice,
            productOverridePrice = product.overridePrice,
        )
        return PricingTarget(
            title = product.name,
            size = product.size,
            unitCost = product.lastUnitCost,
            previousPrice = product.lastRetailPrice,
            suggestion = suggestion,
            orderItemId = null,
            productId = product.id,
            barcode = barcode ?: product.upc,
            inCurrentOrder = false,
        )
    }

    /** Records the shelf price the user approved and returns to the scanner. */
    fun approvePrice(price: Money, resumeScanning: Boolean) {
        val target = _state.value.target ?: return
        viewModelScope.launch {
            _state.update { it.copy(busy = true) }
            if (target.orderItemId != null) {
                container.orderRepository.approvePrice(target.orderItemId, price)
            } else if (target.productId != null) {
                container.productRepository.getById(target.productId)?.let { product ->
                    container.productRepository.update(product.copy(lastRetailPrice = price))
                    container.productRepository.recordPriceHistory(
                        PriceHistoryEntry(
                            productId = product.id,
                            unitCost = product.lastUnitCost ?: Money.ZERO,
                            retailPrice = price,
                            supplier = product.lastSupplier,
                            note = "Price approved while scanning",
                            recordedAt = System.currentTimeMillis(),
                        )
                    )
                }
            }
            container.productRepository.recordScan(
                productId = target.productId,
                barcode = target.barcode,
                matchedName = target.title,
                approvedPrice = price,
            )
            _state.update {
                it.copy(
                    busy = false,
                    approvedCount = it.approvedCount + 1,
                    message = "${target.title} priced at ${price.format()}",
                    mode = if (resumeScanning) ScanMode.SCANNING else ScanMode.RESULT,
                    target = if (resumeScanning) null else it.target,
                )
            }
        }
    }

    fun nextProduct() {
        _state.update {
            it.copy(mode = ScanMode.SCANNING, target = null, candidates = emptyList(), message = null)
        }
    }

    fun openSearch() {
        _state.update { it.copy(mode = ScanMode.SEARCH, searchResults = emptyList()) }
    }

    fun search(term: String) {
        viewModelScope.launch {
            if (term.isBlank()) {
                _state.update { it.copy(searchResults = emptyList()) }
                return@launch
            }
            val orderMatches = if (orderId > 0) {
                container.orderRepository.searchInOrder(orderId, term)
                    .map { buildTargetFromOrderItem(it, it.upc) }
            } else {
                emptyList()
            }
            val catalogueMatches = container.productRepository.search(term)
                .filter { product -> orderMatches.none { it.productId == product.id } }
                .map { buildTargetFromProduct(it, it.upc) }
            _state.update { it.copy(searchResults = orderMatches + catalogueMatches) }
        }
    }

    fun choose(target: PricingTarget) {
        _state.update { it.copy(mode = ScanMode.RESULT, target = target, candidates = emptyList()) }
    }

    /** No barcode visible: read the label and offer what it might be. */
    fun identifyFromPhoto(file: File) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true, message = "Reading the label...") }
            val result = container.textRecognizer.recognize(file)
            val text = result.getOrNull()
            if (text.isNullOrBlank()) {
                _state.update {
                    it.copy(
                        busy = false,
                        mode = ScanMode.NOT_FOUND,
                        message = "No words could be read from that photo. Try again, closer to the label.",
                    )
                }
                return@launch
            }

            val orderCandidates = if (orderId > 0) {
                container.orderRepository.identifyInOrderFromLabel(orderId, text)
                    .map { buildTargetFromOrderItem(it, it.upc) }
            } else {
                emptyList()
            }
            val catalogueCandidates = when (val outcome = container.productRepository.identifyFromLabel(text)) {
                is MatchOutcome.Confident ->
                    listOfNotNull((outcome.match.product as? Product)?.let { buildTargetFromProduct(it, it.upc) })
                is MatchOutcome.Ambiguous ->
                    outcome.candidates.mapNotNull { candidate ->
                        (candidate.product as? Product)?.let { buildTargetFromProduct(it, it.upc) }
                    }
                MatchOutcome.NoMatch -> emptyList()
            }

            val combined = (orderCandidates + catalogueCandidates).distinctBy { it.title to it.size }
            _state.update {
                if (combined.isEmpty()) {
                    it.copy(
                        busy = false,
                        mode = ScanMode.NOT_FOUND,
                        message = "Nothing in this order or the catalog matched that label.",
                    )
                } else {
                    // Never picked silently: the user confirms which product this is.
                    it.copy(busy = false, mode = ScanMode.CANDIDATES, candidates = combined, message = null)
                }
            }
        }
    }

    fun clearMessage() {
        _state.update { it.copy(message = null) }
    }

    fun categoryOf(target: PricingTarget): Category = Category.guessFrom(target.title)

    companion object {
        fun factory(container: AppContainer, orderId: Long): ViewModelProvider.Factory = viewModelFactory {
            initializer { ScanViewModel(container, orderId) }
        }
    }
}
