package com.grocerypricer.app.ai

import com.grocerypricer.core.ai.AiError
import com.grocerypricer.core.ai.AiImageClassification
import com.grocerypricer.core.ai.AiOrderExtraction
import com.grocerypricer.core.ai.AiProvider
import com.grocerypricer.core.ai.AiResponseParser
import com.grocerypricer.core.ai.AiResult
import com.grocerypricer.core.ai.ImageClassificationRequest
import com.grocerypricer.core.ai.OrderExtractionRequest
import com.grocerypricer.core.ai.OrderQuestionRequest
import com.grocerypricer.core.ai.OrderQuestionResolution
import com.grocerypricer.core.ai.ProductIdentification
import com.grocerypricer.core.ai.ProductIdentificationRequest

/**
 * A provider that answers from a script instead of from the network.
 *
 * Tests must never need a real API key: CI has none, and a suite that quietly spends the
 * maintainer's money every time it runs is a suite people stop running. This takes either a raw
 * JSON string - so a test can hand over exactly the malformed reply it wants to prove is survived
 * - or a prepared result.
 */
class FakeAiProvider(
    override val id: String = "fake",
    override val modelId: String = "fake-model",
    private var extraction: AiResult<AiOrderExtraction>? = null,
    private var classification: AiResult<List<AiImageClassification>> = AiResult.Success(emptyList()),
    private var identification: AiResult<ProductIdentification>? = null,
    private var question: AiResult<OrderQuestionResolution>? = null,
    private var connection: AiResult<Unit> = AiResult.Success(Unit),
) : AiProvider {

    /** Every request that was made, so a test can assert on batching and on what was sent. */
    val extractionRequests = mutableListOf<OrderExtractionRequest>()
    val questionRequests = mutableListOf<OrderQuestionRequest>()
    val identificationRequests = mutableListOf<ProductIdentificationRequest>()

    /** Raw replies, consumed one per call, so a test can script a failure then a success. */
    private val extractionScript = ArrayDeque<AiResult<AiOrderExtraction>>()

    fun respondWithRawExtraction(vararg rawJson: String) = apply {
        rawJson.forEach { extractionScript.addLast(AiResponseParser.parseOrderExtraction(it)) }
    }

    fun respondWithExtraction(vararg results: AiResult<AiOrderExtraction>) = apply {
        results.forEach { extractionScript.addLast(it) }
    }

    fun failExtractionWith(error: AiError) = apply {
        extraction = AiResult.Failure(error)
    }

    fun respondWithIdentification(result: AiResult<ProductIdentification>) = apply {
        identification = result
    }

    fun respondWithQuestion(result: AiResult<OrderQuestionResolution>) = apply {
        question = result
    }

    fun respondWithRawQuestion(rawJson: String, allowedIds: Set<Long>) = apply {
        question = AiResponseParser.parseQuestionResolution(rawJson, allowedIds)
    }

    fun failConnectionWith(error: AiError) = apply { connection = AiResult.Failure(error) }

    override suspend fun extractOrder(
        request: OrderExtractionRequest,
    ): AiResult<AiOrderExtraction> {
        extractionRequests += request
        extractionScript.removeFirstOrNull()?.let { return it }
        return extraction ?: AiResult.Success(AiOrderExtraction(null, emptyList()))
    }

    override suspend fun classifyImages(
        request: ImageClassificationRequest,
    ): AiResult<List<AiImageClassification>> = classification

    override suspend fun identifyProducts(
        request: ProductIdentificationRequest,
    ): AiResult<ProductIdentification> {
        identificationRequests += request
        return identification ?: AiResult.Success(ProductIdentification(emptyList()))
    }

    override suspend fun resolveQuestion(
        request: OrderQuestionRequest,
    ): AiResult<OrderQuestionResolution> {
        questionRequests += request
        return question ?: AiResult.Success(OrderQuestionResolution.Unresolved())
    }

    override suspend fun testConnection(): AiResult<Unit> = connection
}
