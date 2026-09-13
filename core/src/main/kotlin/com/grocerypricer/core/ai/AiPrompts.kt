package com.grocerypricer.core.ai

/**
 * Every instruction Grocery Pricer gives a model, in one file.
 *
 * The through-line in all of them: the model reads, it never reckons. It is told what a receipt
 * is, what the store cares about, and - repeatedly - that `null` is a better answer than a
 * plausible guess. A wrong price here becomes a wrong shelf price in a real shop.
 */
object AiPrompts {

    val EXTRACTION_SYSTEM: String = """
        You read wholesale grocery receipts for a small neighbourhood deli and return structured
        data about what was bought. The receipts come from Jetro / Restaurant Depot and similar
        cash-and-carry wholesalers, usually as phone photographs or screenshots.

        You are given photographs, and often the device's own OCR text for each photograph. The
        OCR is supporting evidence, not the truth: it mangles characters and loses layout. When
        the OCR and the picture disagree, believe the picture.

        WHAT A RECEIPT LINE LOOKS LIKE

        A product usually occupies more than one printed line. A typical block is a product name,
        then a line carrying the case price, the pack size and the printed per-unit price, and
        sometimes a separate flyer or discount line underneath or several lines away.

          HELLM MAYONNAISE 8Z
          CASE ${'$'}33.99  SIZE 12  UNIT ${'$'}2.83
          Flyer 43 - HELLM MAYONNAISE
          -${'$'}8.00

        Group those lines into one item using where they sit on the page. A discount line belongs
        to a product only when the evidence says so - usually because it repeats the product name
        or sits directly against that block. If you cannot tell which product a discount belongs
        to, leave it off the item entirely and add a warning.

        THE RULES THAT MATTER MOST

        - Never invent a value. Not a price, not a UPC, not a pack count, not a discount.
        - If something is unreadable, blurred, cut off or simply absent, use null. A null costs
          the user one question later. A guess costs them money on every unit they sell.
        - Do not compute anything. Report the figures as printed. Do not divide a case price by a
          pack count to fill in a missing unit price, and do not subtract a discount. The
          application does that arithmetic itself.
        - Never assume a discount applies to the whole case. If the receipt does not make the
          scope explicit, use scope UNKNOWN and let the user decide.
        - Keep different package sizes apart. Hellmann's 8 oz and Hellmann's 15 oz are two items,
          never one. So are Tide 25 oz and Tide 40 oz. Match on name AND size together.
        - The same product bought as two separate cases on two separate lines is two entries only
          if the receipt really shows two lines; otherwise set casesPurchased.
        - Photographs overlap. If the same receipt section appears in two pictures, report the
          product ONCE and list both photo ids in sourcePhotoIds.
        - Put the receipt lines you used into sourceText, copied verbatim, mangling included.
        - Give a confidence between 0 and 1 that reflects how clearly you could read the block.
          Be honest and use low numbers. Something you half-guessed should be below 0.5.

        FIELDS

        - rawName: the product name exactly as printed, OCR damage preserved.
        - canonicalName: what that product actually is, spelled properly.
        - size: the retail unit size, e.g. "8 oz", "64 oz", "40 fl oz", "12 ct". Not the case size.
        - casePrice: the price of one case, as printed.
        - unitsPerCase: how many sellable retail units are in one case.
        - printedUnitCost: the per-unit price printed on the receipt, if one is printed.
        - casesPurchased: how many cases of this product were bought.
        - upc / supplierSku: only if actually printed. Never reconstructed from memory.

        Return only the JSON object. No commentary before or after it.
    """.trimIndent()

    /**
     * Schema handed to the provider's structured-output mode.
     *
     * Deliberately conservative: `anyOf` for nullables rather than union type arrays, no
     * numeric or string constraints, and `additionalProperties: false` on every object, because
     * those are the documented limits of what the schema compiler accepts.
     */
    val EXTRACTION_SCHEMA: String = """
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["supplier", "items", "warnings"],
          "properties": {
            "supplier": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
            "warnings": { "type": "array", "items": { "type": "string" } },
            "items": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "rawName", "canonicalName", "brand", "size", "upc", "supplierSku",
                  "casePrice", "unitsPerCase", "printedUnitCost", "casesPurchased",
                  "discount", "category", "sourcePhotoIds", "sourceText", "confidence"
                ],
                "properties": {
                  "rawName": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                  "canonicalName": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                  "brand": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                  "size": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                  "upc": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                  "supplierSku": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                  "casePrice": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                  "unitsPerCase": { "anyOf": [{ "type": "integer" }, { "type": "null" }] },
                  "printedUnitCost": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                  "casesPurchased": { "anyOf": [{ "type": "integer" }, { "type": "null" }] },
                  "category": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                  "confidence": { "type": "number" },
                  "sourcePhotoIds": { "type": "array", "items": { "type": "integer" } },
                  "sourceText": { "type": "array", "items": { "type": "string" } },
                  "discount": {
                    "anyOf": [
                      { "type": "null" },
                      {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["amount", "scope", "appliesToUnits"],
                        "properties": {
                          "amount": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                          "scope": {
                            "type": "string",
                            "enum": ["WHOLE_CASE", "PER_UNIT", "UNITS_SUBSET", "CUSTOM", "UNKNOWN"]
                          },
                          "appliesToUnits": { "anyOf": [{ "type": "integer" }, { "type": "null" }] }
                        }
                      }
                    ]
                  }
                }
              }
            }
          }
        }
    """.trimIndent()

    val CLASSIFICATION_SYSTEM: String = """
        You are sorting photographs a shopkeeper imported alongside a wholesale order.

        Classify each image as exactly one of:
        - RECEIPT: a wholesale receipt, invoice or a screenshot of one.
        - CASE_LABEL: the printed panel on a shipping case, typically carrying brand, pack count
          and unit size, e.g. "6 - 23 FL OZ".
        - PRODUCT_PHOTO: an individual retail product, on a shelf or held up to the camera.
        - UNKNOWN: anything else, or too unclear to tell.

        Answer with the JSON object only.
    """.trimIndent()

    val CLASSIFICATION_SCHEMA: String = """
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["images"],
          "properties": {
            "images": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["photoId", "type", "confidence"],
                "properties": {
                  "photoId": { "type": "integer" },
                  "type": {
                    "type": "string",
                    "enum": ["RECEIPT", "CASE_LABEL", "PRODUCT_PHOTO", "UNKNOWN"]
                  },
                  "confidence": { "type": "number" }
                }
              }
            }
          }
        }
    """.trimIndent()

    val IDENTIFICATION_SYSTEM: String = """
        A shopkeeper has photographed one or more products and wants to know what they cost.

        Identify every distinct retail product clearly visible in the photograph. For each one
        report the brand, the product name, the variant or scent if the packaging shows one, and
        the size exactly as printed on the package, e.g. "10 fl oz", "23 FL OZ", "64 oz".

        Rules:
        - Size matters as much as the name. "Downy April Fresh 10 oz" and "Downy April Fresh
          40 oz" are different products with different costs.
        - Order the products left to right as they appear, starting at position 0, so the user
          can say "the second one".
        - Report only what you can actually see. If a label is turned away or out of focus, leave
          that field null rather than filling it in from what the brand usually sells.
        - Do not report a UPC unless the barcode digits are legible in the photograph.
        - If the user's question names a number of products - "these two", "all six" - and you
          can see a different number, report what you can genuinely see and add a warning.

        Answer with the JSON object only.
    """.trimIndent()

    val IDENTIFICATION_SCHEMA: String = """
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["products", "warnings"],
          "properties": {
            "warnings": { "type": "array", "items": { "type": "string" } },
            "products": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["brand", "productName", "size", "variant", "upc", "position", "confidence"],
                "properties": {
                  "brand": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                  "productName": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                  "size": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                  "variant": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                  "upc": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
                  "position": { "type": "integer" },
                  "confidence": { "type": "number" }
                }
              }
            }
          }
        }
    """.trimIndent()

    val QUESTION_SYSTEM: String = """
        You route a shopkeeper's question about a wholesale order they have already imported.

        You are given the question, a short list of candidate products from that order - each with
        an id - and the recent conversation. Your only job is to decide WHICH products the person
        means and WHAT they are asking. You never state a price, a cost or a profit: the
        application looks those up and calculates them itself.

        Choose one kind:

        - PRODUCT_MATCHES: they mean one or more specific products. Put their ids in itemIds.
        - CATEGORY_MATCHES: they asked about a group, e.g. "the oils", "all the cereals".
        - CLARIFICATION: genuinely ambiguous. Ask ONE short question. Prefer naming the
          difference, e.g. "Which one - 8 oz or 15 oz?". Never ask if one candidate is clearly
          the answer.
        - PRICE_CORRECTION: they are telling you what they actually charge, e.g. "I put 7.99",
          "make that 8.99", "number two is 11.99". Put each product id with the price they said.
        - PROFIT_QUERY: they asked what they would make at a given selling price.
        - CASE_QUANTITY_QUERY: they asked how many units are in the case.
        - GENERAL: understood, but not about a specific product. Reply in one or two short
          sentences.

        Rules:
        - Only ever use an id from the candidate list. Never invent one.
        - Resolve references against the conversation. If the assistant just listed products and
          the person says "number two", that is the second product in that list. If they answered
          a clarifying question with "8 oz", they mean the 8 oz version of what was being
          discussed.
        - Different sizes are different products. Never merge them.
        - If nothing in the list plausibly matches, return CLARIFICATION asking what they meant.

        Answer with the JSON object only.
    """.trimIndent()

    val QUESTION_SCHEMA: String = """
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind"],
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "PRODUCT_MATCHES", "CATEGORY_MATCHES", "CLARIFICATION",
                "PRICE_CORRECTION", "PROFIT_QUERY", "CASE_QUANTITY_QUERY", "GENERAL"
              ]
            },
            "itemIds": { "type": "array", "items": { "type": "integer" } },
            "question": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
            "reply": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
            "label": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
            "followUp": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
            "retailPrice": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
            "updates": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["itemId", "retailPrice"],
                "properties": {
                  "itemId": { "type": "integer" },
                  "retailPrice": { "type": "string" }
                }
              }
            }
          }
        }
    """.trimIndent()

    /** The user turn for an extraction batch: which photo is which, plus the device's own OCR. */
    fun buildExtractionUserText(request: OrderExtractionRequest): String = buildString {
        append("Photographs in this batch, in order:\n")
        request.images.forEachIndexed { index, image ->
            append("  image ").append(index + 1)
                .append(" has photoId ").append(image.photoId).append('\n')
        }
        request.supplierHint?.takeIf { it.isNotBlank() }?.let {
            append("\nThe shop usually buys from: ").append(it).append('\n')
        }

        val ocr = request.ocr.filter { it.text.isNotBlank() }
        if (ocr.isNotEmpty()) {
            append("\nOn-device OCR for these photographs. Treat it as a hint only - it is often\n")
            append("wrong about characters and always wrong about layout.\n")
            ocr.forEach { evidence ->
                append("\n--- OCR for photoId ").append(evidence.photoId).append(" ---\n")
                append(evidence.text.trim()).append('\n')
            }
        }

        if (request.parserHints.isNotEmpty()) {
            append("\nThe app's own receipt parser thought it saw these rows. Same caveat.\n")
            request.parserHints.forEach { append("  ").append(it).append('\n') }
        }

        append("\nReturn every product you can read from these photographs.")
    }

    fun buildQuestionUserText(request: OrderQuestionRequest): String = buildString {
        if (request.history.isNotEmpty()) {
            append("Conversation so far:\n")
            request.history.forEach { turn ->
                append(turn.role).append(": ").append(turn.text.trim()).append('\n')
            }
            append('\n')
        }

        if (request.lastListedItemIds.isNotEmpty()) {
            append("The assistant's last list, in the order it was shown:\n")
            request.lastListedItemIds.forEachIndexed { index, id ->
                append("  ").append(index + 1).append(". id=").append(id).append('\n')
            }
            append('\n')
        }

        append("Candidate products from this order:\n")
        if (request.candidates.isEmpty()) {
            append("  (none matched locally)\n")
        } else {
            request.candidates.forEach { append("  ").append(it.describe()).append('\n') }
        }

        if (request.attachedImage != null) {
            append("\nThe person attached a photograph with this message.\n")
        }

        append("\nTheir message: ").append(request.question.trim())
    }
}
