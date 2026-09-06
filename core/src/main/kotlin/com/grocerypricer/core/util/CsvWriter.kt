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

    /**
     * A UTF-8 byte-order mark.
     *
     * Excel on Windows assumes the system code page for a .csv unless a BOM is present, which
     * turns an accented product name into mojibake. Every other common spreadsheet tool skips
     * the mark, so prefixing it is the safer default for a file the user opens by double-click.
     */
    const val UTF8_BOM = "\uFEFF"

    /** The document plus a UTF-8 BOM, for a file that will be opened in a spreadsheet. */
    fun buildForSpreadsheet(header: List<String>, rows: List<List<String?>>): String =
        UTF8_BOM + build(header, rows)

    fun build(header: List<String>, rows: List<List<String?>>): String {
        val builder = StringBuilder()
        builder.append(row(header)).append("\n")
        rows.forEach { builder.append(row(it)).append("\n") }
        return builder.toString()
    }
}
