package com.grocerypricer.app.ui.rules

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.grocerypricer.app.data.model.AppSettings
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.core.model.Category
import com.grocerypricer.core.model.CategoryPricingRule
import com.grocerypricer.core.model.CostTier
import com.grocerypricer.core.model.PriceEnding
import com.grocerypricer.core.model.PricingRules
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class PricingRulesViewModel(private val container: AppContainer) : ViewModel() {

    val rules: StateFlow<PricingRules> = container.pricingRulesRepository.rules
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), PricingRules())

    val settings: StateFlow<AppSettings> = container.settingsRepository.settings
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), AppSettings())

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    fun saveTier(index: Int, tier: CostTier) {
        viewModelScope.launch {
            val current = rules.value.tiers.toMutableList()
            if (index in current.indices) current[index] = tier else current.add(tier)
            container.pricingRulesRepository.replaceTiers(current.sortedBy { it.minCost.amount })
            _message.value = "Cost tier saved."
        }
    }

    fun deleteTier(index: Int) {
        viewModelScope.launch {
            val current = rules.value.tiers.toMutableList()
            if (index !in current.indices) return@launch
            current.removeAt(index)
            container.pricingRulesRepository.replaceTiers(current)
            _message.value = "Cost tier removed."
        }
    }

    fun saveCategoryRule(rule: CategoryPricingRule) {
        viewModelScope.launch {
            val current = rules.value.categoryRules.toMutableMap()
            current[rule.category] = rule
            container.pricingRulesRepository.replaceCategoryRules(current.values.toList())
            _message.value = "${rule.category.displayName} rule saved."
        }
    }

    fun clearCategoryRule(category: Category) {
        viewModelScope.launch {
            val current = rules.value.categoryRules.toMutableMap()
            current.remove(category)
            container.pricingRulesRepository.replaceCategoryRules(current.values.toList())
            _message.value = "${category.displayName} rule removed."
        }
    }

    fun setDefaultEnding(ending: PriceEnding) {
        viewModelScope.launch {
            container.settingsRepository.update { it.copy(priceEndingCents = ending.cents) }
        }
    }

    fun setScalars(highCostMarkup: String, minimumMargin: String, costChangeAlert: String) {
        viewModelScope.launch {
            container.settingsRepository.update {
                it.copy(
                    highCostMarkupPercent = highCostMarkup.ifBlank { it.highCostMarkupPercent },
                    minimumGrossMarginPercent = minimumMargin.ifBlank { it.minimumGrossMarginPercent },
                    costChangeAlertPercent = costChangeAlert.ifBlank { it.costChangeAlertPercent },
                )
            }
            _message.value = "Pricing settings saved."
        }
    }

    fun resetToDefaults() {
        viewModelScope.launch {
            container.pricingRulesRepository.resetToDefaults()
            _message.value = "The starter cost ladder has been restored."
        }
    }

    fun clearMessage() {
        _message.value = null
    }

    companion object {
        fun factory(container: AppContainer): ViewModelProvider.Factory = viewModelFactory {
            initializer { PricingRulesViewModel(container) }
        }
    }
}
