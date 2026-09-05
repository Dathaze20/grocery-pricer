package com.grocerypricer.core.util

/**
 * Minimal RFC 4180 CSV writer.
 *
 * Values that could be read as a formula by a spreadsheet are prefixed with an apostrophe, so an
 * exported product name never turns into something executable when the file is opened.
 */
object CsvWriter {

    private const val NEEDS_QUOTING = ",\"\n\r"
    private val FORMULA_STARTERS = charArrayOf('=', '+', '@')

    fun escape(value: String?): String {
        if (value.isNullOrEmpty()) return ""
        var text = value
        if (text.first() in FORMULA_STARTERS) text = "'$text"
        val mustQuote = text.any { it in NEEDS_QUOTING } || text != text.trim()
        if (!mustQuote) return text
        return "\"" + text.replace("\"", "\"\"") + "\""
    }

    fun row(values: List<String?>): String = values.joinToString(",") { escape(it) }

    fun build(header: List<String>, rows: List<List<String?>>): String {
        val builder = StringBuilder()
        builder.append(row(header)).append("\n")
        rows.forEach { builder.append(row(it)).append("\n") }
        return builder.toString()
    }
}
