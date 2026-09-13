# Grocery Pricer

**Grocery Pricer turns a wholesale receipt into a conversation.**

Photograph your Jetro / Restaurant Depot receipts once and press one button. Grocery Pricer reads
every photo, works out what each individual item really cost after case discounts, and opens the
order so you can just ask about it.

> **You:** How much is the Carnation milk?
>
> **Grocery Pricer:**
> Carnation Evaporated Milk 12 oz
> $4.20 → $7.99

Ask what anything cost. Ask what you should charge. Ask how many are in the case. Photograph a
product you are holding and ask what it is. Tell it the price you actually put on the shelf, and it
remembers for next time.

No spreadsheet. No approving 150 rows before you can use it.

**Photos → one button → ask questions.**

---

## Why it exists

One wholesale order can be 150 products. Working out the true cost of each one by hand - case price,
divided by units per case, minus a flyer discount that may or may not apply to the whole case - and
then deciding a shelf price for each is an evening's work, and it is easy to get wrong.

The receipt already has the numbers. The problem is that they are on paper, the discounts sit on
separate lines, and the printed "unit" price is the price *before* the discount.

Version 1 read the receipt and then made you check its work: 150 rows to scroll, confirm and save
before the app was any use. That is a different evening's work, not less of one. Version 2 does the
reading and the arithmetic and then waits to be asked a question, which is what you actually wanted
standing in the shop with a box in your hand.

### What is different in 2.0

| | Version 1 | Version 2 |
|---|---|---|
| After importing photos | Review and approve every row | Ask a question |
| Finding a price | Scan the barcode | Say the name, or photograph it |
| Reading the receipt | On-device OCR only | A multimodal model, with OCR as evidence |
| Uncertain rows | A list of 47 to work through | Mentioned once, asked about only if they matter |
| Home screen | Six financial stat cards | Two buttons |
| Who does the arithmetic | Kotlin | **Still Kotlin** |

That last row is the one that does not change, and section *How pricing works* below spells out why.

---

## Features

**Receipt import**
- Take photos or import screenshots from the gallery, many at a time
- Sideways and upside-down photos are rotated automatically
- On-device text recognition (Google ML Kit) - the model ships inside the APK
- Text blocks are stitched back into visual rows, so `CASE $33.99 SIZE 12 UNIT $2.83` is read as one line

**Receipt parsing**
- Understands the Jetro / Restaurant Depot layout: description, `CASE`/`SIZE`/`UNIT` detail line, flyer discount underneath
- Extracts description, UPC, supplier item number, size, case price, units per case, printed unit cost, cases purchased and discounts
- Corrects the characters OCR reliably confuses (`O`/`0`, `l`/`1`, `S`/`$`, `B`/`8`) inside numeric tokens only, and flags the row when it has to
- Detects duplicate lines and overlapping receipt photos without silently deleting a genuine second purchase

**Review before anything is saved**
- One card per product showing case price, units, printed cost, discount, net case cost and the true cost each
- Everything editable: name, UPC, size, case price, case quantity, discount, cases purchased
- Discounts can be re-scoped as whole-case, per-unit, "applies to N units", a flat amount, or ignored - and the cost recalculates as you type
- Rows with warnings cannot be bulk-approved; `APPROVE ALL HIGH-CONFIDENCE ITEMS` only touches clean rows

**Pricing**
- Deterministic cost tiers tuned for convenience-store margins, all editable
- Optional per-category rules (markup, ladder steps, price ending)
- Configurable price endings (`.99`, `.49`, `.00`, or your own)
- Remembers your previous shelf price and keeps it while the margin still holds
- Flags `PRICE REVIEW RECOMMENDED` when a cost rise breaks your minimum margin - it never reprices on its own

**In the store**
- Barcode scanning (UPC-A, UPC-E, EAN-8, EAN-13, Code 128) with a debounce so one item is not read twice
- Camera mode: scan, see the cost, tap the price, and the scanner comes straight back
- `IDENTIFY FROM PHOTO` reads a product label when no barcode is visible, and offers candidates rather than guessing
- Manual search across name, size, UPC and supplier item number

**Records**
- Permanent product catalogue with last cost, last price and package size
- Append-only price history per product
- Wholesale cost-change alerts against your own threshold
- Gross profit, gross margin and markup, kept clearly distinct
- Order summary, "today's price list", CSV export of an order or the whole catalogue
- Versioned JSON backup and restore, optionally including receipt photos

---

## How receipt scanning works

1. **Capture.** Photos are copied into the app's own storage, so the original is still there months
   later. Nothing is uploaded.
2. **Recognise.** Each image is decoded at a workable size, rotated using its EXIF orientation, and
   run through ML Kit's on-device Latin text recognizer. Lines whose vertical centres are close
   enough to be the same row on the paper are joined left-to-right, because a receipt row is often
   split across several recognition blocks.
3. **Normalise.** Characters are corrected only inside tokens that are already mostly numeric, so
   `SIZE` never becomes `5IZE` while `S33.99` does become `$33.99`. If anything was corrected, the
   row is flagged for a human to glance at.
4. **Parse.** Lines are classified (product description, detail line, discount label, discount
   amount, quantity, noise) and assembled into rows. A discount is attached to the product above it
   only when the flyer text actually names that product; otherwise it is marked `CHECK DISCOUNT` and
   changes nothing until you say how it applies.
5. **Validate.** Missing prices, impossible case quantities, a discount larger than the product, and
   a case price that does not match `unit cost x units` are all flagged. Nothing is invented: a value
   that could not be read stays empty.
6. **Review.** You approve each row, or bulk-approve the clean ones. Only approved rows are written
   to the catalogue.

---

## How pricing works

The true cost of one retail unit is:

```
net case cost = case price - discount applied to one case
true unit cost = net case cost / units per case
```

Worked example from a real receipt:

```
KELL FROOT LOOP FM 13.2Z
CASE $57.59  SIZE 10  UNIT $5.76
Flyer 43 - KELLOGGS FROOT LOOPS
-$12.00

net case cost   = $57.59 - $12.00 = $45.59
true unit cost  = $45.59 / 10      = $4.559   (displayed as $4.56)
```

The printed `UNIT $5.76` is the pre-discount figure. The number you price against is `$4.56`.

A suggested shelf price is then resolved in this order:

1. a price you pinned to that specific product
2. the price you sold it at last time, **if** it still clears your minimum gross margin
3. a category rule, if one is switched on
4. the global cost ladder
5. a markup, for anything above the top of the ladder

The ladder ships with these starting tiers, all editable in **Pricing rules**:

| Wholesale cost | Suggested retail | Second choice |
| --- | --- | --- |
| $0.00 - $1.24 | $2.99 | |
| $1.25 - $1.99 | $3.99 | |
| $2.00 - $2.99 | $4.99 | $5.99 |
| $3.00 - $3.99 | $5.99 | $6.99 |
| $4.00 - $4.99 | $7.99 | $8.99 |
| $5.00 - $5.99 | $8.99 | $9.99 |
| $6.00 - $7.99 | $10.99 | $12.99 |
| $8.00 - $9.99 | $13.99 | $15.99 |
| above $9.99 | cost + 60% | |

The tier decides the target price first; the price ending is applied afterwards. That is why `$5.16`
becomes `$5.99` rather than being rounded to the nearest `.99`.

The ranges above are printed to the cent, but a true unit cost is a case price divided by a pack
count and rarely lands on one — `$1.2450` is an ordinary result. The ladder is therefore read as
contiguous bands: a cost belongs to the last tier that starts at or below it, so nothing falls
through the gap between `$1.24` and `$1.25`. Only a cost above the top of the ladder uses the
markup rule.

Profit is always reported three ways, and margin is never labelled markup:

```
gross profit  = retail - cost
gross margin% = gross profit / retail x 100
markup%       = gross profit / cost   x 100
```

Money is `BigDecimal` throughout, held internally to four decimal places so a case can be divided
across its units without losing fractions of a cent, and stored in the database as an integer number
of ten-thousandths of a dollar. No floating point touches a price.

---

## Privacy

**Version 2 sends data off the phone. Version 1 did not. This section says exactly what and when.**

### What leaves the phone

- **Receipt photographs**, when you press PROCESS ORDER. They go to the AI provider you configured,
  along with the on-device OCR text, so it can read the order.
- **A product photograph**, when you attach one to the conversation and ask about it.
- **A short shortlist of product names from the current order**, when a typed question is ambiguous
  enough to need the model. Never the whole order, and never your prices - the model is asked which
  product you meant, not what anything costs.

That is the complete list.

### What never leaves the phone

- Your costs, your shelf prices, and your price history.
- The database, the receipt images once processed, your backups and your CSV exports.
- Your API key. It is encrypted by the Android Keystore, it is sent only to the provider it
  authenticates to, and it is never written to a log.

There is no analytics, no crash reporting, no advertising, no account, and no cloud sync of your
data. Nothing is uploaded on a schedule or in the background - only when you press the button.

### Using it without AI

An order that has already been processed stays fully usable offline: product search, known costs,
known prices, barcode lookup, price history, the pricing engine, and any question the on-device
parser can answer. Only reading new receipt photos, understanding product photographs and the more
open-ended questions need a connection.

### Permissions

This app's own manifest declares two permissions. `CAMERA` is requested at runtime, only when you
first open the scanner. `VIBRATE` needs no prompt and is used for the buzz confirming a scan.

The installed APK holds **four**: the ML Kit libraries add `INTERNET` and `ACCESS_NETWORK_STATE`
through the manifest merger. In version 1 nothing used them. In version 2 `INTERNET` is used, for
exactly what is listed above.

Every CI run greps the *merged* manifest and prints the permission list into the build log and run
summary, so what the APK actually asks for is on the record next to the APK itself.

Gallery imports use the Android photo picker and exports use the Storage Access Framework, so no
storage permission is needed.

### The cost

The AI provider is billed to your own API key, by the provider, not by this app. Reading an order
is the expensive part and happens once per order; after that most questions are answered on the
phone and cost nothing. The app deliberately searches locally first, sends small batches rather than
whole orders, and scales photographs down before uploading them.

---

## Architecture

```
grocery-pricer/          <- this repository
  core/     pure Kotlin, no Android dependencies
    money/      BigDecimal-backed Money
    model/      domain models, discounts, pricing rules
    pricing/    CostCalculator, PricingEngine, PriceRounding, ProfitCalculator
    parser/     OcrTextNormalizer, ReceiptParser, ReceiptItemValidator
    matching/   NameNormalizer, SizeParser, ProductMatcher
    dedup/      DuplicateDetector
    util/       CsvWriter
  app/      the Android application
    data/db         Room entities, DAOs, mappers
    data/repository OrderRepository, ProductRepository, PricingRulesRepository
    data/settings   DataStore preferences
    data/files      receipt image storage
    ocr/            ML Kit text recognition
    scanner/        ML Kit barcode analysis and scan debounce
    export/         CSV export
    backup/         versioned JSON backup and restore
    ui/             Jetpack Compose screens, MVVM view models
```

The split matters: **every calculation the store depends on lives in `core/` and has no Android
dependency at all**, so the money, discount, pricing, parsing and matching logic is covered by plain
JVM unit tests that run in milliseconds. The `app/` module is the database, the camera and the
screens.

MVVM throughout: view models expose `StateFlow`, screens collect with
`collectAsStateWithLifecycle()`, repositories return `Flow` off Room. Dependencies are wired by a
small hand-written `AppContainer` rather than a DI framework - there is one process and a handful of
objects.

Deliberate design decisions:
- **AI/OCR reads, it does not decide.** The pipeline is capture, extract, review, approve, save.
  Every calculation after extraction is deterministic Kotlin.
- **Nothing uncertain is saved silently.** A value that cannot be read stays null and the row is
  flagged, rather than being guessed.
- **Order items are snapshots.** They keep the figures they were saved with, so an old order still
  shows what was actually paid after the catalogue moves on.
- **Price history is append-only** and Room migrations are real - destructive migration is never
  enabled.
- **The database schema is exported** to `app/schemas/`, so a version 2 migration can be tested
  against the exact version 1 it has to upgrade. The version 1 JSON is not in the repository yet: it
  is produced by the Android build, which needs the SDK, and it has only ever been generated on CI.
  Every run attaches it to the **Grocery-Pricer-reports** artifact and warns if it is missing or
  stale, so it can be committed before anyone writes that migration.

### Future-proofing

The repository interfaces are the seam: `ReceiptParser` takes `ReceiptLine`s from any source, so
electronic invoices or PDF receipts are another producer of lines rather than a rewrite.
`ProductMatcher` works on a `MatchableProduct` interface, not a Room entity. `BackupManager` uses a
versioned document format so a future schema can migrate old backups. Bluetooth scanners, label
printing, POS integration and multi-store support would all attach at those seams. None of that
complexity is present today.

---

## Tech stack

Kotlin - Jetpack Compose - Material 3 - MVVM - Room - DataStore - CameraX - ML Kit Text Recognition -
ML Kit Barcode Scanning - Coroutines and Flow - Navigation Compose - Android Photo Picker - Storage
Access Framework.

- `versionName` 1.0.0, `versionCode` 1 — both in `app/build.gradle.kts`. Raise `versionCode` on
  every release you distribute; Android uses it, not `versionName`, to decide what is an upgrade.
- `minSdk` 26 (Android 8.0), `targetSdk`/`compileSdk` 35
- Java 17 toolchain, Kotlin 2.0, AGP 8.7, Gradle 8.11
- No Firebase, no server, no accounts, no secrets in the APK

---

## Building locally

You need JDK 17+ and the Android SDK (platform 35). Android Studio installs both.

```bash
./gradlew assembleDebug
```

The APK lands at `app/build/outputs/apk/debug/app-debug.apk`.

In Android Studio, use **File -> Open** and select this repository's root folder.

## Running tests

```bash
./gradlew :core:test :app:testDebugUnitTest   # what CI runs
./gradlew :core:test                          # pricing, parsing and matching only
```

**160 unit tests: 123 in `core`, 37 in `app`.** `:core:test` is plain JVM and runs without the
Android SDK installed at all, which makes it a fast way to work on the pricing and parsing logic.
The `app` tests use Robolectric to exercise the real Room database and the backup round-trip.

The suite deliberately concentrates on what costs money if it is wrong: exact decimal arithmetic,
every discount scope, true unit cost, the cost ladder and its boundaries, price endings, margin
versus markup, receipt parsing and OCR correction, duplicate and photo-overlap detection, product
matching, CSV output, database writes, and backup restore.

## Building an APK

```bash
./gradlew clean :core:test :app:testDebugUnitTest lintDebug assembleDebug
cp app/build/outputs/apk/debug/app-debug.apk grocery-pricer-1.0.0-debug.apk
```

## GitHub Actions

`.github/workflows/android.yml` runs on every push and pull request. It runs the unit tests, runs
Android Lint, builds the debug APK, and uploads it.

To download the APK: **GitHub -> Actions -> a successful "Android" run -> Artifacts ->
`Grocery-Pricer-Android-debug`**. Test and lint reports are uploaded as `Grocery-Pricer-reports`.

A failing unit test or an error-severity lint finding fails the run, so no APK is published from a
build that did not pass.

`.github/workflows/release.yml` builds a signed release APK, and only does anything
when release signing secrets are configured on the repository. No signing material is committed.

## Installing the APK on Android

1. Download `Grocery-Pricer-Android-debug` from the Actions run and unzip it.
2. Copy `grocery-pricer-1.0.0-debug.apk` to the phone (USB, Drive, email - anything).
3. Open it with the phone's file manager.
4. Android will ask to allow installs from that app - allow it, then confirm the install.
5. Launch **Grocery Pricer**. Grant the camera permission the first time you open the scanner.

The debug APK is signed with the standard Android debug key, so it installs alongside anything else
and does not need Play Store distribution.

---

## Known limitations

- **Receipt parsing is tuned for the Jetro / Restaurant Depot layout.** Other suppliers' receipts
  will produce rows, but more of them will be flagged for review. Manual entry always works.
- **OCR quality is OCR quality.** A blurred, folded or badly lit photo produces flagged rows rather
  than good data. The review screen is the safety net, not a formality.
- **Loose units are not read off receipts.** The cost engine supports them and you can set them by
  hand, but the parser treats `UNITS n` alongside `CASES n` as the receipt's packing count, not extra
  loose pieces.
- **Long-receipt video capture is not implemented.** Multi-photo import covers the same ground and is
  more reliable; video mode was explicitly secondary.
- **Inventory is a count, not a stock system.** Quantity received plus a manual adjustment. There is
  no sales deduction, because there is no POS integration.
- **No automated UI tests.** Coverage is on the calculation, parsing, matching, database and backup
  layers; the Compose screens are not instrumented.
- **Android Lint gates on errors only.** Error-severity findings fail CI; warnings are reported and
  uploaded but do not block a release.
- **Release builds are unsigned unless you supply a keystore**, and the release workflow skips
  itself when no signing secrets are present.

---

## License

MIT. See [LICENSE](LICENSE).
