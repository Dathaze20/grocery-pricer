package com.grocerypricer.app.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.processing.ProcessingOutcome
import com.grocerypricer.app.processing.ProcessingStage
import com.grocerypricer.core.ai.AiError
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class ProcessingUiState(
    val stage: ProcessingStage = ProcessingStage.STARTING,
    val failureMessage: String? = null,
    val finished: Boolean = false,
)

/**
 * Runs PROCESS ORDER and reports where it has got to.
 *
 * A failure here never discards work: the photographs and their on-device OCR stay exactly as
 * they were, so TRY AGAIN costs one more attempt rather than another round of photographing a
 * receipt, and the deterministic V1 parser can still read what OCR managed.
 */
class ProcessingViewModel(
    private val orderId: Long,
    private val container: AppContainer,
) : ViewModel() {

    private val local = MutableStateFlow(ProcessingUiState())
    val state: StateFlow<ProcessingUiState> = local.asStateFlow()

    init {
        start()
    }

    fun start() {
        local.value = ProcessingUiState()
        viewModelScope.launch {
            val provider = container.aiProviderOrNull()
            if (provider == null) {
                local.value = local.value.copy(failureMessage = AiError.MissingKey.userMessage())
                return@launch
            }

            container.orderRepository.markProcessing(orderId)
            val settings = container.settingsRepository.current()

            val outcome = container.orderProcessor.process(
                orderId = orderId,
                provider = provider,
                supplierHint = settings.defaultSupplier,
                onStage = { stage -> local.value = local.value.copy(stage = stage) },
            )

            local.value = when (outcome) {
                is ProcessingOutcome.Success ->
                    local.value.copy(stage = ProcessingStage.DONE, finished = true)

                is ProcessingOutcome.Failed ->
                    local.value.copy(failureMessage = outcome.error.userMessage())

                ProcessingOutcome.NothingToRead -> local.value.copy(
                    failureMessage = "None of those photos had anything readable on them.",
                )
            }
        }
    }

    /**
     * The offline path: read the order with the deterministic V1 parser instead.
     *
     * Worse than the model at reconstructing a receipt, but it needs no network and no key, and
     * it is why the OCR step was kept rather than replaced.
     */
    fun useLocalReader() {
        local.value = ProcessingUiState()
        viewModelScope.launch {
            val rules = container.pricingRulesRepository.current()
            val count = container.orderRepository.reparseOrder(orderId, rules)
            local.value = if (count > 0) {
                local.value.copy(stage = ProcessingStage.DONE, finished = true)
            } else {
                local.value.copy(
                    failureMessage = "The local reader could not find any products either.",
                )
            }
        }
    }

    companion object {
        fun factory(container: AppContainer, orderId: Long): ViewModelProvider.Factory =
            viewModelFactory { initializer { ProcessingViewModel(orderId, container) } }
    }
}
