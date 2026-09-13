package com.grocerypricer.core.ai

/**
 * An image being handed to the model. Bytes, not a path, so this contract stays free of Android.
 */
data class AiImage(
    val photoId: Long,
    val bytes: ByteArray,
    val mediaType: String = "image/jpeg",
) {
    // ByteArray gives identity equals, which makes these useless in assertions and sets.
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is AiImage) return false
        return photoId == other.photoId &&
            mediaType == other.mediaType &&
            bytes.contentEquals(other.bytes)
    }

    override fun hashCode(): Int =
        (photoId.hashCode() * 31 + mediaType.hashCode()) * 31 + bytes.contentHashCode()
}

/** OCR the device already did, offered to the model as supporting evidence. */
data class OcrEvidence(
    val photoId: Long,
    val text: String,
)

data class OrderExtractionRequest(
    val images: List<AiImage>,
    val ocr: List<OcrEvidence> = emptyList(),
    val supplierHint: String? = null,
    /** Rows the deterministic V1 parser already recovered, offered as a second opinion. */
    val parserHints: List<String> = emptyList(),
)

data class ImageClassificationRequest(val images: List<AiImage>)

data class ProductIdentificationRequest(
    val image: AiImage,
    /** The user's words, which say how many products they mean. */
    val question: String? = null,
)

/** One candidate row, flattened to text, that the model may pick from. Never a source of money. */
data class QuestionCandidate(
    val itemId: Long,
    val name: String,
    val brand: String? = null,
    val size: String? = null,
    val category: String? = null,
    val unitsPerCase: Int? = null,
) {
    fun describe(): String = buildString {
        append("id=").append(itemId).append(' ')
        append(name)
        brand?.takeIf { it.isNotBlank() }?.let { append(" | brand=").append(it) }
        size?.takeIf { it.isNotBlank() }?.let { append(" | size=").append(it) }
        category?.takeIf { it.isNotBlank() }?.let { append(" | category=").append(it) }
        unitsPerCase?.let { append(" | ").append(it).append("/case") }
    }
}

data class ConversationTurn(val role: String, val text: String)

data class OrderQuestionRequest(
    val question: String,
    /** Only the shortlist the local engine thought plausible - never the whole order. */
    val candidates: List<QuestionCandidate>,
    val history: List<ConversationTurn> = emptyList(),
    /** Items the assistant last listed, in the order shown, so "number two" resolves. */
    val lastListedItemIds: List<Long> = emptyList(),
    val attachedImage: AiImage? = null,
)

/** Why an AI call did not produce an answer. Each case maps to something worth saying out loud. */
sealed interface AiError {
    /** No API key configured yet. */
    data object MissingKey : AiError

    /** The key was rejected. Retrying will not help. */
    data object InvalidKey : AiError

    /** The key is valid but the account cannot be billed. Retrying will not help. */
    data object Billing : AiError

    /** The key is valid but not allowed to do this. */
    data object PermissionDenied : AiError

    /** Too many photographs in one request. The caller must send fewer. */
    data object RequestTooLarge : AiError

    /** The model declined the request outright. */
    data class Refused(val category: String? = null) : AiError

    /** The answer was cut off by the token ceiling; whatever arrived is incomplete. */
    data object Truncated : AiError

    data class RateLimited(val retryAfterSeconds: Long? = null) : AiError

    /** The provider is up but overloaded. Worth one retry. */
    data object Overloaded : AiError

    data object Timeout : AiError

    /** No usable connection. */
    data class Network(val detail: String? = null) : AiError

    data class ServerError(val status: Int, val detail: String? = null) : AiError

    /** A 200 response whose body was not the JSON we asked for. */
    data class MalformedResponse(val detail: String) : AiError

    data class Unknown(val detail: String? = null) : AiError

    /** True when trying the same call again could plausibly succeed. */
    val isTransient: Boolean
        get() = when (this) {
            is RateLimited, Overloaded, Timeout, is Network -> true
            is ServerError -> status >= 500
            else -> false
        }

    /** What the user should read. Never leaks a key, a URL or a stack trace. */
    fun userMessage(): String = when (this) {
        MissingKey -> "AI setup is required once before Grocery Pricer can analyze receipt photos."
        InvalidKey -> "That API key was rejected. Check it in Settings under AI Provider."
        Billing -> "Your AI provider account could not be billed. Check its billing settings."
        PermissionDenied -> "That API key is not allowed to use this model."
        RequestTooLarge -> "Too many photos went out at once. Try again with fewer."
        is Refused -> "The AI provider declined to process that. Try a different photo."
        Truncated -> "The reply was cut off before it finished. Try processing fewer photos at once."
        is RateLimited -> "The AI provider is rate limiting requests. Try again in a moment."
        Overloaded -> "The AI provider is busy right now. Try again in a moment."
        Timeout -> "That took too long to come back. Try again."
        is Network -> "No internet connection."
        is ServerError -> "The AI provider returned an error. Try again."
        is MalformedResponse -> "I got a reply I could not read. Try again."
        is Unknown -> "Something went wrong talking to the AI provider."
    }
}

sealed interface AiResult<out T> {
    data class Success<T>(val value: T) : AiResult<T>
    data class Failure(val error: AiError) : AiResult<Nothing>

    fun valueOrNull(): T? = (this as? Success)?.value
    fun errorOrNull(): AiError? = (this as? Failure)?.error
}

inline fun <T, R> AiResult<T>.map(transform: (T) -> R): AiResult<R> = when (this) {
    is AiResult.Success -> AiResult.Success(transform(value))
    is AiResult.Failure -> this
}

/**
 * The seam between Grocery Pricer and whichever model is doing the looking.
 *
 * Implementations identify and interpret. They do not price anything: every method returns either
 * text the model read or an item id it picked, and the caller looks the money up locally.
 */
interface AiProvider {

    /** Stable identifier stored with each processed order, e.g. `anthropic`. */
    val id: String

    /** Which model actually ran, recorded for debugging. Never includes credentials. */
    val modelId: String

    suspend fun extractOrder(request: OrderExtractionRequest): AiResult<AiOrderExtraction>

    suspend fun classifyImages(request: ImageClassificationRequest): AiResult<List<AiImageClassification>>

    suspend fun identifyProducts(request: ProductIdentificationRequest): AiResult<ProductIdentification>

    suspend fun resolveQuestion(request: OrderQuestionRequest): AiResult<OrderQuestionResolution>

    /** Cheapest call that proves the key works. */
    suspend fun testConnection(): AiResult<Unit>
}
