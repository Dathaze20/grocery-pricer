package com.grocerypricer.app.ui.chat

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.grocerypricer.app.di.AppContainer
import com.grocerypricer.app.processing.OrderProcessingWorker
import com.grocerypricer.app.processing.ProcessingStage
import com.grocerypricer.core.ai.AiError
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
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
    private val appContext: Context,
) : ViewModel() {

    private val local = MutableStateFlow(ProcessingUiState())
    val state: StateFlow<ProcessingUiState> = local.asStateFlow()

    init {
        start()
    }

    /**
     * Hands the work to WorkManager and then just watches.
     *
     * Deliberately not run in `viewModelScope`: that dies when the screen goes away, which would
     * mean an order was lost because somebody answered the phone halfway through. WorkManager
     * outlives the screen and the process, so leaving the app is safe and the notification brings
     * them back to the finished order.
     */
    fun start() {
        local.value = ProcessingUiState()
        viewModelScope.launch {
            if (container.aiProviderOrNull() == null) {
                local.value = local.value.copy(failureMessage = AiError.MissingKey.userMessage())
                return@launch
            }
            OrderProcessingWorker.enqueue(appContext, orderId)
            observeWork()
        }
    }

    private suspend fun observeWork() {
        WorkManager.getInstance(appContext)
            .getWorkInfosForUniqueWorkFlow(OrderProcessingWorker.uniqueNameFor(orderId))
            .collectLatest { infos ->
                val info = infos.lastOrNull() ?: return@collectLatest
                when (info.state) {
                    WorkInfo.State.RUNNING, WorkInfo.State.ENQUEUED -> {
                        val stageName = info.progress.getString(OrderProcessingWorker.KEY_STAGE)
                        val stage = ProcessingStage.entries.firstOrNull { it.name == stageName }
                        local.value = local.value.copy(stage = stage ?: local.value.stage)
                    }

                    WorkInfo.State.SUCCEEDED ->
                        local.value = local.value.copy(stage = ProcessingStage.DONE, finished = true)

                    WorkInfo.State.FAILED ->
                        local.value = local.value.copy(
                            failureMessage = messageFor(
                                info.outputData.getString(OrderProcessingWorker.KEY_ERROR),
                            ),
                        )

                    WorkInfo.State.CANCELLED ->
                        local.value = local.value.copy(failureMessage = "Processing was cancelled.")

                    WorkInfo.State.BLOCKED -> Unit
                }
            }
    }

    /**
     * Turns the worker's error tag back into something worth reading.
     *
     * The worker stores a type, never a message, so nothing that might carry a key or a URL ends
     * up in WorkManager's database.
     */
    private fun messageFor(errorType: String?): String = when (errorType) {
        "no_key" -> AiError.MissingKey.userMessage()
        "nothing_readable" -> "None of those photos had anything readable on them."
        "InvalidKey" -> AiError.InvalidKey.userMessage()
        "Billing" -> AiError.Billing.userMessage()
        "PermissionDenied" -> AiError.PermissionDenied.userMessage()
        "RequestTooLarge" -> AiError.RequestTooLarge.userMessage()
        "Timeout" -> AiError.Timeout.userMessage()
        "Truncated" -> AiError.Truncated.userMessage()
        "Network" -> "No internet connection."
        else -> "Something went wrong while reading this order."
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
        fun factory(
            container: AppContainer,
            orderId: Long,
            appContext: Context,
        ): ViewModelProvider.Factory = viewModelFactory {
            initializer { ProcessingViewModel(orderId, container, appContext) }
        }
    }
}
