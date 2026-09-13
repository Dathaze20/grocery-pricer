package com.grocerypricer.app.processing

import com.grocerypricer.app.ai.ImagePreparer
import com.grocerypricer.app.data.files.ImageStore
import com.grocerypricer.app.data.repository.OrderRepository
import com.grocerypricer.app.data.repository.PricingRulesRepository
import com.grocerypricer.app.ocr.ReceiptTextRecognizer
import com.grocerypricer.core.ai.AiConfig
import com.grocerypricer.core.ai.AiError
import com.grocerypricer.core.ai.AiExtractionValidator
import com.grocerypricer.core.ai.AiImage
import com.grocerypricer.core.ai.AiOrderExtraction
import com.grocerypricer.core.ai.AiProvider
import com.grocerypricer.core.ai.AiResult
import com.grocerypricer.core.ai.ExtractionMerger
import com.grocerypricer.core.ai.ImageClassificationRequest
import com.grocerypricer.core.ai.OcrEvidence
import com.grocerypricer.core.ai.OrderExtractionRequest
import com.grocerypricer.core.ai.OrderImageType
import com.grocerypricer.core.ai.ValidatedExtraction
import java.io.File

/**
 * What the user sees while an order is being read.
 *
 * Named after what is happening to their receipt rather than to the software: "Matching products"
 * rather than "Resolving catalogue entities", and never "Calling the API".
 */
enum class ProcessingStage(val message: String) {
    STARTING("Analyzing your order..."),
    READING_PHOTOS("Reading receipt photos..."),
    UNDERSTANDING("Reading the receipt..."),
    MATCHING("Matching products..."),
    CASE_QUANTITIES("Checking case quantities..."),
    DISCOUNTS("Applying discounts..."),
    PRICING("Building your price list..."),
    DONE("Order ready"),
}

/** The outcome of one processing run. */
sealed interface ProcessingOutcome {
    data class Success(
        val itemsFound: Int,
        val itemsNeedingAttention: Int,
        val warnings: List<String>,
    ) : ProcessingOutcome

    /**
     * The model could not be reached or could not be understood.
     *
     * The photographs and their OCR are untouched, so the user can retry or fall back to the
     * deterministic V1 parser.
     */
    data class Failed(val error: AiError, val ocrSucceeded: Boolean) : ProcessingOutcome

    /** No photograph produced anything readable. */
    data object NothingToRead : ProcessingOutcome
}

/**
 * PROCESS ORDER, end to end.
 *
 * The one button in V2. Everything between the user tapping it and the conversation opening
 * happens here: copy, OCR, classify, extract, merge, validate, price, save.
 *
 * Two design points worth stating out loud:
 *
 * The photographs go out in small batches rather than all at once. A whole Jetro order can be
 * thirty screenshots; one request would risk the provider's size ceiling, produce a reply long
 * enough to hit the token ceiling, and lose the entire order on a single failure. Batching also
 * means the progress bar moves.
 *
 * On-device OCR still runs, and still matters. It is sent alongside the pictures as supporting
 * evidence, it makes the model's job cheaper, and when the model cannot be reached at all it is
 * what the V1 parser falls back to. Removing it would have made the app useless offline.
 */
class OrderProcessor(
    private val orderRepository: OrderRepository,
    private val pricingRulesRepository: PricingRulesRepository,
    private val imageStore: ImageStore,
    private val textRecognizer: ReceiptTextRecognizer,
) {

    suspend fun process(
        orderId: Long,
        provider: AiProvider,
        supplierHint: String? = null,
        onStage: (ProcessingStage) -> Unit = {},
    ): ProcessingOutcome {
        onStage(ProcessingStage.STARTING)

        // ---- 1. read every photograph on the device ------------------------------------------
        onStage(ProcessingStage.READING_PHOTOS)
        val images = orderRepository.receiptImagesOnce(orderId)
        if (images.isEmpty()) return ProcessingOutcome.NothingToRead

        val ocrByPhoto = LinkedHashMap<Long, String>()
        val prepared = mutableListOf<AiImage>()

        for (image in images) {
            val file = File(image.localPath)

            // OCR is best-effort. A photograph the recognizer chokes on can still be read by the
            // model from the picture itself, so a failure here is not a failure of the order.
            if (image.recognizedText.isBlank()) {
                orderRepository.markImageProcessing(image.id)
                textRecognizer.recognize(file)
                    .onSuccess { text ->
                        orderRepository.saveImageText(image.id, text)
                        if (text.isNotBlank()) ocrByPhoto[image.id] = text
                    }
                    .onFailure { orderRepository.saveImageFailure(image.id, "Could not read this photo") }
            } else {
                ocrByPhoto[image.id] = image.recognizedText
            }

            ImagePreparer.prepare(file, image.id)?.let { prepared += it }
        }

        if (prepared.isEmpty() && ocrByPhoto.isEmpty()) return ProcessingOutcome.NothingToRead

        // ---- 2. work out which pictures are even receipts -------------------------------------
        // Case labels and product shots get imported alongside receipts, and feeding a picture of
        // a shampoo bottle into receipt extraction produces confident nonsense.
        val classified = classify(provider, prepared)
        val receiptImages = prepared.filter {
            classified[it.photoId] != OrderImageType.PRODUCT_PHOTO
        }.ifEmpty { prepared }

        // ---- 3. extract, in batches ------------------------------------------------------------
        onStage(ProcessingStage.UNDERSTANDING)
        val batches = receiptImages.chunked(AiConfig.IMAGES_PER_EXTRACTION_BATCH)
        val extractions = mutableListOf<AiOrderExtraction>()
        var lastError: AiError? = null

        for ((index, batch) in batches.withIndex()) {
            val request = OrderExtractionRequest(
                images = batch,
                ocr = batch.mapNotNull { image ->
                    ocrByPhoto[image.photoId]?.let { OcrEvidence(image.photoId, it) }
                },
                supplierHint = supplierHint,
            )
            when (val result = provider.extractOrder(request)) {
                is AiResult.Success -> extractions += result.value
                is AiResult.Failure -> {
                    lastError = result.error
                    // A key that is wrong or an account that cannot be billed will fail on every
                    // remaining batch too. Stop rather than spending the rest of the order on it.
                    if (result.error.isFatalForRun()) break
                }
            }
            onStage(if (index < batches.lastIndex) ProcessingStage.UNDERSTANDING else ProcessingStage.MATCHING)
        }

        if (extractions.isEmpty()) {
            val error = lastError ?: AiError.MalformedResponse("nothing was extracted")
            orderRepository.markProcessingFailed(orderId, error::class.java.simpleName)
            return ProcessingOutcome.Failed(error, ocrSucceeded = ocrByPhoto.isNotEmpty())
        }

        // ---- 4. stitch the batches back into one order ----------------------------------------
        onStage(ProcessingStage.MATCHING)
        val merged = ExtractionMerger.merge(extractions)

        onStage(ProcessingStage.CASE_QUANTITIES)
        val validated: ValidatedExtraction = AiExtractionValidator.validate(
            extraction = merged,
            knownPhotoIds = images.map { it.id }.toSet(),
        )

        // ---- 5. the deterministic part ---------------------------------------------------------
        onStage(ProcessingStage.DISCOUNTS)
        val rules = pricingRulesRepository.current()

        onStage(ProcessingStage.PRICING)
        val saved = orderRepository.replaceItemsFromAi(
            orderId = orderId,
            validated = validated,
            rules = rules,
        )

        onStage(ProcessingStage.DONE)
        return ProcessingOutcome.Success(
            itemsFound = saved,
            itemsNeedingAttention = validated.itemsNeedingAttention.size,
            warnings = validated.warnings,
        )
    }

    /**
     * Classification is a convenience, not a gate.
     *
     * If it fails - no key for it, a malformed reply, an outage - every picture is treated as a
     * possible receipt and extraction goes ahead. Refusing to process an order because the
     * sorting step failed would be the software managing the user.
     */
    private suspend fun classify(
        provider: AiProvider,
        images: List<AiImage>,
    ): Map<Long, OrderImageType> {
        if (images.isEmpty()) return emptyMap()
        return when (val result = provider.classifyImages(ImageClassificationRequest(images))) {
            is AiResult.Success -> result.value.associate { it.photoId to it.type }
            is AiResult.Failure -> emptyMap()
        }
    }
}

/** Errors where trying the next batch is throwing good money after bad. */
private fun AiError.isFatalForRun(): Boolean = when (this) {
    AiError.MissingKey, AiError.InvalidKey, AiError.Billing, AiError.PermissionDenied -> true
    else -> false
}
