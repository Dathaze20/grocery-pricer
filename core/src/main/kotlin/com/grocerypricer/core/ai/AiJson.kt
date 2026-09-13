package com.grocerypricer.core.ai

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Defensive reading of model output.
 *
 * Everything here assumes the JSON is wrong until proven otherwise. A field can be absent, null,
 * the wrong type, a number sent as a string or a string sent as a number, and none of those may
 * throw: they read as null and the validator decides whether the item survives.
 */
internal object AiJson {

    val lenient: Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
    }

    /**
     * Pull the first complete JSON object out of a reply.
     *
     * Models wrap JSON in prose, in ```json fences, or in an apology. Rather than trusting any of
     * that, scan for the first `{` and walk forward counting depth - while respecting string
     * literals and escapes, so a `}` inside a product name cannot end the object early.
     *
     * Returns null when there is no balanced object, which is what a truncated reply looks like.
     */
    fun extractFirstObject(raw: String?): String? {
        if (raw.isNullOrBlank()) return null
        val start = raw.indexOf('{')
        if (start < 0) return null

        var depth = 0
        var inString = false
        var escaped = false
        for (i in start until raw.length) {
            val c = raw[i]
            if (inString) {
                when {
                    escaped -> escaped = false
                    c == '\\' -> escaped = true
                    c == '"' -> inString = false
                }
                continue
            }
            when (c) {
                '"' -> inString = true
                '{' -> depth++
                '}' -> {
                    depth--
                    if (depth == 0) return raw.substring(start, i + 1)
                }
            }
        }
        return null
    }

    fun parseObject(raw: String?): JsonObject? {
        val text = extractFirstObject(raw) ?: return null
        return try {
            lenient.parseToJsonElement(text) as? JsonObject
        } catch (e: Exception) {
            null
        }
    }

    private fun JsonElement?.primitiveOrNull(): JsonPrimitive? =
        (this as? JsonPrimitive)?.takeIf { it !is JsonNull }

    /** A string field. An explicit `null`, an empty string or the literal text "null" all read as null. */
    fun JsonObject.str(key: String): String? {
        val p = this[key].primitiveOrNull() ?: return null
        val text = p.content.trim()
        return text.takeIf { it.isNotEmpty() && !it.equals("null", ignoreCase = true) }
    }

    /**
     * A money field, kept as the literal characters the model sent.
     *
     * `"33.99"` and `33.99` both read as `"33.99"`. Currency symbols, thousands separators and a
     * trailing minus are left for [com.grocerypricer.core.money.Money] to reject or accept, so
     * there is exactly one place in the codebase that decides what a price string means.
     */
    fun JsonObject.money(key: String): String? = str(key)

    fun JsonObject.int(key: String): Int? {
        val p = this[key].primitiveOrNull() ?: return null
        p.content.trim().toIntOrNull()?.let { return it }
        // Models sometimes answer "12 per case" or "12.0".
        return p.content.trim().toDoubleOrNull()
            ?.takeIf { it == Math.floor(it) && !it.isInfinite() }
            ?.toInt()
    }

    fun JsonObject.double(key: String): Double? =
        this[key].primitiveOrNull()?.content?.trim()?.toDoubleOrNull()

    fun JsonObject.bool(key: String): Boolean? {
        val p = this[key].primitiveOrNull() ?: return null
        return when (p.content.trim().lowercase()) {
            "true", "yes", "1" -> true
            "false", "no", "0" -> false
            else -> null
        }
    }

    fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

    fun JsonObject.array(key: String): JsonArray? = this[key] as? JsonArray

    fun JsonObject.stringList(key: String): List<String> =
        array(key).orEmpty().mapNotNull { el ->
            el.primitiveOrNull()?.content?.trim()?.takeIf { it.isNotEmpty() }
        }

    fun JsonObject.longList(key: String): List<Long> =
        array(key).orEmpty().mapNotNull { el ->
            val text = el.primitiveOrNull()?.content?.trim() ?: return@mapNotNull null
            text.toLongOrNull() ?: text.toDoubleOrNull()?.takeIf { it == Math.floor(it) }?.toLong()
        }

    fun JsonObject.objectList(key: String): List<JsonObject> =
        array(key).orEmpty().filterIsInstance<JsonObject>()
}
