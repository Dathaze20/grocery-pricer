package com.grocerypricer.core.ai

/**
 * The one place a model name or endpoint is written down.
 *
 * Section 8 of the V2 brief asks for exactly this: no model strings scattered through the
 * codebase, and room for a second provider later without a rewrite. Everything else refers to
 * these constants or to the value the user chose in Settings.
 */
object AiConfig {

    const val PROVIDER_ANTHROPIC = "anthropic"

    const val DEFAULT_PROVIDER = PROVIDER_ANTHROPIC

    /** Default model. Overridable in Settings so a new one needs no new build. */
    const val DEFAULT_MODEL = "claude-opus-5"

    /** Models offered in the Settings picker. The field stays free-text for anything newer. */
    val SUGGESTED_MODELS: List<String> = listOf(
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-haiku-4-5",
    )

    const val ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
    const val ANTHROPIC_VERSION = "2023-06-01"

    /**
     * Receipt photographs per extraction request.
     *
     * A whole Jetro order can be thirty screenshots. Sending them in one request risks the
     * provider's request-size ceiling and produces a reply long enough to hit the token ceiling,
     * and one failure would lose the entire order. Batching keeps each call small, lets the
     * progress bar move, and means a failed batch costs one batch.
     */
    const val IMAGES_PER_EXTRACTION_BATCH = 4

    /** Roughly 150 products of structured JSON, with room to spare. */
    const val EXTRACTION_MAX_TOKENS = 32_000

    const val IDENTIFICATION_MAX_TOKENS = 4_000

    const val QUESTION_MAX_TOKENS = 2_000

    const val CLASSIFICATION_MAX_TOKENS = 2_000

    /** Reading a page of receipt text is slow work; this is a ceiling, not a target. */
    const val EXTRACTION_TIMEOUT_SECONDS = 300L

    const val INTERACTIVE_TIMEOUT_SECONDS = 90L

    const val CONNECT_TIMEOUT_SECONDS = 30L

    /**
     * Transient failures worth one more go. Deliberately small: a stuck order should surface as a
     * clear failure the user can retry by hand, not as a silent twenty-minute retry storm on a
     * metered API key.
     */
    const val MAX_TRANSIENT_RETRIES = 2

    const val RETRY_BASE_DELAY_MILLIS = 2_000L

    /**
     * Longest edge, in pixels, that a photograph is scaled to before upload.
     *
     * Receipt text has to stay legible, so this is generous; anything larger is spending the
     * user's money on pixels the model does not need.
     */
    const val MAX_IMAGE_EDGE_PX = 1_568

    const val IMAGE_JPEG_QUALITY = 82
}
