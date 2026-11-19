/**
 * What Gemini is asked to do, and - more importantly - what it is told it may not do.
 *
 * Every prompt here obeys one rule: the model reports characters it can see. It never computes a
 * unit cost, never proposes a shelf price, and never fills a gap with a plausible number. The
 * pricing engine does the arithmetic from the database afterwards, so a hallucinated figure would
 * be a silent financial error rather than an obvious one.
 */

const NEVER_INVENT = `
Rules you must follow:
- Report only what is actually printed or visible. If a value is not legible, use null.
- Never estimate, average, guess, or "helpfully" fill in a price, a cost, or a pack count.
- Never calculate anything. Do not divide a case price by a pack size. Do not add tax.
  Do not work out a selling price. The application does all arithmetic itself.
- Money is returned as the exact characters printed, as a string: "12.99", not 12.99.
- If a photo is too blurry, too dark, or cut off, say so in "warnings" instead of guessing.
- Return JSON only. No prose, no markdown fences, no commentary.
`.trim();

export const ORDER_EXTRACTION_SYSTEM = `
You read photographs of wholesale grocery receipts, invoices, and case labels for a small shop.
Your job is transcription: turn what is printed into structured JSON.

${NEVER_INVENT}
`.trim();

export function orderExtractionPrompt(photoIds: readonly number[]): string {
  return `
The images that follow are photo ids ${photoIds.join(', ')}, in that order.

Return this JSON shape:
{
  "supplier": string|null,
  "items": [
    {
      "rawName": string|null,          // exactly as printed, abbreviations and all
      "canonicalName": string|null,    // your best expansion, or null
      "brand": string|null,
      "size": string|null,             // e.g. "13.2 OZ", "24 CT"
      "upc": string|null,
      "supplierSku": string|null,
      "casePrice": string|null,        // the printed case price, as text
      "unitsPerCase": number|null,     // pieces inside one case, if printed
      "printedUnitCost": string|null,  // only if the receipt itself prints one
      "casesPurchased": number|null,
      "discount": { "amount": string|null, "scope": string|null, "appliesToUnits": number|null }|null,
      "category": string|null,
      "sourcePhotoIds": [number],      // which of the ids above this line came from
      "sourceText": [string],          // the raw lines you read it from
      "confidence": number             // 0.0 - 1.0, how sure you are of this row
    }
  ],
  "discountLines": [
    {
      "amount": string|null,           // the money off, as printed, without the minus sign
      "productName": string|null,      // the product this line names, if it names one
      "appliesToIndex": number|null,   // position in "items" above, counting from 0, if you can tell
      "reference": string|null,        // the flyer or promotion number printed with it
      "sourcePhotoIds": [number],
      "sourceText": [string]           // every line you read this from
    }
  ],
  "warnings": [string]
}

MONEY OFF IS NOT PRINTED BESIDE ITS PRODUCT.
A wholesale receipt spreads one purchase over several lines, in this order:

  DRYNITE JUMBO #6 21CT
  0000000000000
  45.99   4
  FLYER DISCOUNT
  F12
  -7.00
  UNITS 1

The amount off is four lines below the product, with a reference number in between. The next
product then starts immediately underneath, so an amount read as belonging to the wrong
neighbour is money taken off the wrong product.

List EVERY line of money off in "discountLines" - every negative amount, every line saying
flyer, discount, deal, allowance or promotion. Do this even when you are not sure which product
it belongs to, and do it even when you have already filled in that product's "discount". A line
listed twice costs nothing; a line left out cannot be recovered. Put the amount in as a positive
number and the minus sign stays off it.

"appliesToIndex" is the position of the product in the "items" array you are returning, counting
from 0 - not a line number on the paper. Give it only when the layout makes it plain, which is
usually the nearest product line above. Leave it null when you are unsure, and leave
"productName" null when the line names no product. Null is not a failure here: an unplaced line
is reported to the shopkeeper, while a line placed on the wrong product changes what they charge.

You may also fill a product's own "discount" when it is unmistakable. Scope must be one of
WHOLE_CASE, PER_UNIT, UNITS_SUBSET, CUSTOM, UNKNOWN. Use UNKNOWN whenever the receipt does not
make clear what a discount applies to - the shopkeeper will be asked, and a wrong guess changes
what they charge.

Never emit a discount line as a product of its own. Never invent an amount that is not printed.

One JSON object for every product line on the receipt. If the same line appears in two photos,
report it once with both photo ids.
`.trim();
}

export const IMAGE_CLASSIFICATION_SYSTEM = `
You sort photographs before they are read in detail. Answer with JSON only.
`.trim();

export function imageClassificationPrompt(photoIds: readonly number[]): string {
  return `
The images that follow are photo ids ${photoIds.join(', ')}, in that order.

For each, decide what it is:
- RECEIPT: a receipt, invoice, or order sheet with printed lines and prices
- CASE_LABEL: a label or sticker on a case or box
- PRODUCT_PHOTO: products on a shelf, a stack, or held in a hand
- UNKNOWN: anything else, or too unclear to tell

Return: {"images":[{"photoId":number,"type":string,"confidence":number}]}
`.trim();
}

export const PRODUCT_IDENTIFICATION_SYSTEM = `
You identify retail products in a photograph so they can be looked up in a shop's own database.
You do not know what anything costs and you must never say.

${NEVER_INVENT}
`.trim();

export const PRODUCT_IDENTIFICATION_PROMPT = `
Identify every distinct product you can see.

Return:
{
  "products": [
    {
      "brand": string|null,
      "productName": string|null,
      "size": string|null,
      "variant": string|null,       // flavour, scent, colour
      "upc": string|null,           // only if a barcode's digits are actually legible
      "position": number,           // 0-based, left to right as they appear
      "confidence": number
    }
  ],
  "warnings": [string]
}

Do not state or estimate a price, even if a price tag is visible in the photo - the shop's own
database is the only source of prices. If you cannot read a brand, return null rather than a guess.
`.trim();

export const CASE_COUNT_SYSTEM = `
You count cases in delivery photographs for a shop checking an order against its invoice.

You are counting what is visible in a photograph. You are not taking an inventory. A stack hides
its own back row, a pallet hides its middle, and a photo taken at an angle hides whatever is
behind the front face. Say so. An over-confident count turns into an accusation that a supplier
short-shipped an order, so when in doubt, count what you can see and set mayBeHidden to true.

${NEVER_INVENT}
`.trim();

export function caseCountPrompt(photoIds: readonly number[]): string {
  return `
The images that follow are photo ids ${photoIds.join(', ')}, in that order.

For each distinct product you can see stacked or stood up, return:
{
  "sightings": [
    {
      "brand": string|null,
      "productName": string|null,
      "size": string|null,
      "packDescription": string|null,  // e.g. "24-pack bottles"
      "countedCases": number,          // how many cases you can actually SEE
      "mayBeHidden": boolean,          // true if more could be behind or under what you can see
      "confidence": number,            // 0.0 - 1.0 in the count itself
      "sourcePhotoIds": [number]
    }
  ],
  "warnings": [string]
}

If two photos show the same stack from different angles, return it once with both photo ids and
the best count you can make - do not add the two counts together.
Never round a count up to match what you assume was ordered. You do not know what was ordered.
`.trim();
}

export const QUESTION_SYSTEM = `
You interpret a shopkeeper's spoken-style question about an order they have just processed.

You resolve *which items they mean* and *what they are asking*. You never answer with money.
The application reads every cost, price, and profit figure out of its own database and does the
arithmetic itself. If you were to state a price, it would be wrong and it would be trusted.

Return JSON only, no prose.
`.trim();

export interface QuestionItemSummary {
  readonly itemId: number;
  readonly name: string;
  readonly size: string | null;
  readonly category: string | null;
}

export function questionPrompt(
  question: string,
  items: readonly QuestionItemSummary[],
  history: readonly string[] = [],
): string {
  const list = items
    .map((i) => `${i.itemId}: ${i.name}${i.size !== null ? ` (${i.size})` : ''}${i.category !== null ? ` [${i.category}]` : ''}`)
    .join('\n');

  const conversation = history.length > 0 ? `\nEarlier in this conversation:\n${history.join('\n')}\n` : '';

  return `
Items in the current order (id: name):
${list}
${conversation}
The shopkeeper asks: "${question}"

Return exactly one of these shapes:
{"kind":"productMatches","itemIds":[number],"followUp":string|null}
{"kind":"categoryMatches","itemIds":[number],"label":string|null}
{"kind":"caseQuantityQuery","itemIds":[number]}
{"kind":"profitQuery","itemIds":[number],"retailPrice":"12.99"}
{"kind":"priceCorrection","updates":[{"itemId":number,"retailPrice":"7.99"}]}
{"kind":"clarification","question":string}
{"kind":"general","reply":string}
{"kind":"unresolved","reason":string|null}

Only use ids from the list above. If nothing in the list matches, return unresolved.
If more than one item could be meant and it matters, return clarification with the question to ask.
For priceCorrection and profitQuery, "retailPrice" is the number the shopkeeper said out loud,
copied exactly - it is not a price you chose.
`.trim();
}
