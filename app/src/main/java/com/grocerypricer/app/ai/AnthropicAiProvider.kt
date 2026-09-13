package com.grocerypricer.app.ai

import com.grocerypricer.core.ai.AiConfig
import com.grocerypricer.core.ai.AiError
import com.grocerypricer.core.ai.AiImage
import com.grocerypricer.core.ai.AiImageClassification
import com.grocerypricer.core.ai.AiOrderExtraction
import com.grocerypricer.core.ai.AiPrompts
import com.grocerypricer.core.ai.AiProvider
import com.grocerypricer.core.ai.AiResponseParser
import com.grocerypricer.core.ai.AiResult
import com.grocerypricer.core.ai.ImageClassificationRequest
import com.grocerypricer.core.ai.OrderExtractionRequest
import com.grocerypricer.core.ai.OrderQuestionRequest
import com.grocerypricer.core.ai.OrderQuestionResolution
import com.grocerypricer.core.ai.ProductIdentification
import com.grocerypricer.core.ai.ProductIdentificationRequest
import com.grocerypricer.core.ai.map
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import android.util.Base64

/**
 * Talks to the Anthropic Messages API over plain HTTPS.
 *
 * The official Anthropic Java SDK is not used here on purpose. It is a server-side JVM library:
 * it pulls in Jackson databind, Apache HttpClient 5 and a JSON-schema generator, none of which
 * belong in an APK that already ships bundled ML Kit models, and there is no official Anthropic
 * SDK for Android. The wire format is a single JSON POST, so this speaks it directly through the
 * OkHttp client Android apps already use.
 *
 * Nothing in this class logs a request body, a response body or a header. The API key is read on
 * demand and never held in a field.
 */
class AnthropicAiProvider(
    private val keyStore: SecureKeyStore,
    override val modelId: String = AiConfig.DEFAULT_MODEL,
    private val client: OkHttpClient = defaultClient(),
) : AiProvider {

    override val id: String = AiConfig.PROVIDER_ANTHROPIC

    // ------------------------------------------------------------------ public API

    override suspend fun extractOrder(request: OrderExtractionRequest): AiResult<AiOrderExtraction> {
        val content = JSONArray().apply {
            request.images.forEach { put(imageBlock(it)) }
            put(textBlock(AiPrompts.buildExtractionUserText(request)))
        }
        return call(
            system = AiPrompts.EXTRACTION_SYSTEM,
            content = content,
            maxTokens = AiConfig.EXTRACTION_MAX_TOKENS,
            schema = AiPrompts.EXTRACTION_SCHEMA,
            timeoutSeconds = AiConfig.EXTRACTION_TIMEOUT_SECONDS,
        ).flatMap { AiResponseParser.parseOrderExtraction(it) }
    }

    override suspend fun classifyImages(
        request: ImageClassificationRequest,
    ): AiResult<List<AiImageClassification>> {
        if (request.images.isEmpty()) return AiResult.Success(emptyList())
        val content = JSONArray().apply {
            request.images.forEach { put(imageBlock(it)) }
            put(
                textBlock(
                    buildString {
                        append("Images in order:\n")
                        request.images.forEachIndexed { index, image ->
                            append("  image ").append(index + 1)
                                .append(" has photoId ").append(image.photoId).append('\n')
                        }
                    },
                ),
            )
        }
        return call(
            system = AiPrompts.CLASSIFICATION_SYSTEM,
            content = content,
            maxTokens = AiConfig.CLASSIFICATION_MAX_TOKENS,
            schema = AiPrompts.CLASSIFICATION_SCHEMA,
            timeoutSeconds = AiConfig.INTERACTIVE_TIMEOUT_SECONDS,
        ).flatMap { AiResponseParser.parseImageClassification(it) }
    }

    override suspend fun identifyProducts(
        request: ProductIdentificationRequest,
    ): AiResult<ProductIdentification> {
        val content = JSONArray().apply {
            put(imageBlock(request.image))
            put(
                textBlock(
                    request.question?.takeIf { it.isNotBlank() }
                        ?.let { "The shopkeeper asked: $it" }
                        ?: "Identify the products in this photograph.",
                ),
            )
        }
        return call(
            system = AiPrompts.IDENTIFICATION_SYSTEM,
            content = content,
            maxTokens = AiConfig.IDENTIFICATION_MAX_TOKENS,
            schema = AiPrompts.IDENTIFICATION_SCHEMA,
            timeoutSeconds = AiConfig.INTERACTIVE_TIMEOUT_SECONDS,
        ).flatMap { AiResponseParser.parseProductIdentification(it) }
    }

    override suspend fun resolveQuestion(
        request: OrderQuestionRequest,
    ): AiResult<OrderQuestionResolution> {
        val content = JSONArray().apply {
            request.attachedImage?.let { put(imageBlock(it)) }
            put(textBlock(AiPrompts.buildQuestionUserText(request)))
        }
        val allowed = request.candidates.map { it.itemId }.toSet() + request.lastListedItemIds
        return call(
            system = AiPrompts.QUESTION_SYSTEM,
            content = content,
            maxTokens = AiConfig.QUESTION_MAX_TOKENS,
            schema = AiPrompts.QUESTION_SCHEMA,
            timeoutSeconds = AiConfig.INTERACTIVE_TIMEOUT_SECONDS,
            // Routing a sentence to an id is not the part worth thinking hard about; the
            // shopkeeper pays for every token and wants the answer now.
            effort = "low",
        ).flatMap { AiResponseParser.parseQuestionResolution(it, allowed) }
    }

    override suspend fun testConnection(): AiResult<Unit> {
        val content = JSONArray().put(textBlock("Reply with the single word: ok"))
        return call(
            system = "You are a connection test. Reply with one word.",
            content = content,
            maxTokens = 16,
            schema = null,
            timeoutSeconds = AiConfig.CONNECT_TIMEOUT_SECONDS,
        ).map { }
    }

    // ------------------------------------------------------------------ transport

    /**
     * One Messages call, with bounded retries and a structured-output escape hatch.
     *
     * If the provider rejects the JSON schema, the call is retried once without it. The system
     * prompt already demands a bare JSON object and the parser already digs one out of prose, so
     * that path genuinely works - it exists so a schema incompatibility degrades into a slightly
     * less reliable reply instead of bricking every order the app will ever process.
     */
    private suspend fun call(
        system: String,
        content: JSONArray,
        maxTokens: Int,
        schema: String?,
        timeoutSeconds: Long,
        effort: String? = null,
    ): AiResult<String> {
        val apiKey = keyStore.apiKey() ?: return AiResult.Failure(AiError.MissingKey)

        var useSchema = schema != null
        var attempt = 0

        while (true) {
            val body = buildBody(
                system = system,
                content = content,
                maxTokens = maxTokens,
                schema = if (useSchema) schema else null,
                effort = effort,
            )

            when (val outcome = post(apiKey, body, timeoutSeconds)) {
                is AiResult.Success -> return outcome

                is AiResult.Failure -> {
                    val error = outcome.error

                    // A 400 while sending a schema is almost always the schema itself.
                    if (useSchema && error is AiError.ServerError && error.status == 400) {
                        useSchema = false
                        continue
                    }

                    if (!error.isTransient || attempt >= AiConfig.MAX_TRANSIENT_RETRIES) {
                        return outcome
                    }

                    val wait = when (error) {
                        is AiError.RateLimited -> error.retryAfterSeconds?.times(1000)
                        else -> null
                    } ?: (AiConfig.RETRY_BASE_DELAY_MILLIS shl attempt)

                    attempt++
                    delay(wait)
                }
            }
        }
    }

    private fun buildBody(
        system: String,
        content: JSONArray,
        maxTokens: Int,
        schema: String?,
        effort: String?,
    ): String {
        val root = JSONObject()
            .put("model", modelId)
            .put("max_tokens", maxTokens)
            .put("system", system)
            .put(
                "messages",
                JSONArray().put(JSONObject().put("role", "user").put("content", content)),
            )

        val outputConfig = JSONObject()
        if (schema != null) {
            outputConfig.put(
                "format",
                JSONObject().put("type", "json_schema").put("schema", JSONObject(schema)),
            )
        }
        if (effort != null) outputConfig.put("effort", effort)
        if (outputConfig.length() > 0) root.put("output_config", outputConfig)

        return root.toString()
    }

    private suspend fun post(
        apiKey: String,
        body: String,
        timeoutSeconds: Long,
    ): AiResult<String> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(AiConfig.ANTHROPIC_MESSAGES_URL)
            .addHeader("content-type", "application/json")
            .addHeader("x-api-key", apiKey)
            .addHeader("anthropic-version", AiConfig.ANTHROPIC_VERSION)
            .post(body.toRequestBody(JSON_MEDIA_TYPE))
            .build()

        val scoped = client.newBuilder()
            .readTimeout(timeoutSeconds, TimeUnit.SECONDS)
            .writeTimeout(timeoutSeconds, TimeUnit.SECONDS)
            .callTimeout(timeoutSeconds + AiConfig.CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .build()

        try {
            scoped.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    return@withContext AiResult.Failure(
                        errorForStatus(response.code, response.header("retry-after")),
                    )
                }
                readAssistantText(text)
            }
        } catch (e: SocketTimeoutException) {
            AiResult.Failure(AiError.Timeout)
        } catch (e: UnknownHostException) {
            AiResult.Failure(AiError.Network("no route to the provider"))
        } catch (e: IOException) {
            // Deliberately not e.message: it can contain the full request URL.
            AiResult.Failure(AiError.Network("the connection failed"))
        } catch (e: Exception) {
            AiResult.Failure(AiError.Unknown(e::class.java.simpleName))
        }
    }

    /** Maps the documented status codes. Anything unlisted is treated by class of code. */
    private fun errorForStatus(status: Int, retryAfter: String?): AiError = when (status) {
        400 -> AiError.ServerError(400, "the request was rejected")
        401 -> AiError.InvalidKey
        402 -> AiError.Billing
        403 -> AiError.PermissionDenied
        404 -> AiError.ServerError(404, "that model is not available to this key")
        413 -> AiError.RequestTooLarge
        429 -> AiError.RateLimited(retryAfter?.toLongOrNull())
        529 -> AiError.Overloaded
        else -> AiError.ServerError(status)
    }

    /**
     * Pulls the assistant's text out of the response envelope.
     *
     * Also honours `stop_reason`: a refusal and a token-ceiling truncation both arrive as HTTP
     * 200 with content attached, and treating either as a normal answer would mean parsing half
     * an order and saving it as a whole one.
     */
    private fun readAssistantText(raw: String): AiResult<String> = try {
        val root = JSONObject(raw)
        when (root.optString("stop_reason")) {
            "refusal" -> AiResult.Failure(
                AiError.Refused(root.optJSONObject("stop_details")?.optString("category")),
            )
            "max_tokens" -> AiResult.Failure(AiError.Truncated)
            else -> {
                val content = root.optJSONArray("content")
                val text = buildString {
                    for (i in 0 until (content?.length() ?: 0)) {
                        val block = content?.optJSONObject(i) ?: continue
                        if (block.optString("type") == "text") append(block.optString("text"))
                    }
                }
                if (text.isBlank()) {
                    AiResult.Failure(AiError.MalformedResponse("the reply carried no text"))
                } else {
                    AiResult.Success(text)
                }
            }
        }
    } catch (e: Exception) {
        AiResult.Failure(AiError.MalformedResponse("the reply was not valid JSON"))
    }

    // ------------------------------------------------------------------ content blocks

    private fun textBlock(text: String): JSONObject =
        JSONObject().put("type", "text").put("text", text)

    private fun imageBlock(image: AiImage): JSONObject = JSONObject()
        .put("type", "image")
        .put(
            "source",
            JSONObject()
                .put("type", "base64")
                .put("media_type", image.mediaType)
                .put("data", Base64.encodeToString(image.bytes, Base64.NO_WRAP)),
        )

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(AiConfig.CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            // Retries are handled explicitly above, where the error type decides.
            .retryOnConnectionFailure(false)
            .build()
    }
}

/** Chains a parse onto a successful call without unwrapping by hand at four call sites. */
private inline fun <T, R> AiResult<T>.flatMap(transform: (T) -> AiResult<R>): AiResult<R> =
    when (this) {
        is AiResult.Success -> transform(value)
        is AiResult.Failure -> this
    }
