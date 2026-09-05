# Grocery Pricer

Turn a wholesale receipt into shelf prices, without retyping anything.

Grocery Pricer is an offline Android app for a small neighbourhood deli or grocery store. You
photograph the receipt from a Jetro / Restaurant Depot run, it reconstructs the order and works out
what each individual item really cost after case discounts, and then you walk the store scanning
barcodes and approving prices.

Everything stays on the phone. No account, no server, no API key, no internet connection needed.

---

## Why it exists

One wholesale order can be 150 products. Working out the true cost of each one by hand - case price,
divided by units per case, minus a flyer discount that may or may not apply to the whole case - and
then deciding a shelf price for each is an evening's work, and it is easy to get wrong.

The receipt already has the numbers. The problem is that they are on paper, the discounts are on
separate lines, and the printed "unit" price is the price *before* the discount. Grocery Pricer does
the arithmetic, shows its working, and gets out of the way.

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

## Screenshots

_Screenshots go here._

| Home | Review | Pricing |
| --- | --- | --- |
| _dashboard_ | _receipt review cards_ | _scan result with cost and suggested price_ |

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

- Receipt photos, product photos, costs and prices stay on the device.
- Nothing is uploaded. There is no analytics, no crash reporting, no account, and no server.
- Text recognition and barcode scanning run entirely on the phone; the models are bundled in the APK.
- The only permission requested is `CAMERA`, and only when you first open the scanner. Gallery
  imports use the Android photo picker and exports use the Storage Access Framework, so no storage
  permission is needed.
- Data leaves the device only when *you* export a CSV or a backup to a location you choose.

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

`:core:test` is plain JVM and runs without the Android SDK installed at all, which makes it a fast
way to work on the pricing and parsing logic.

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
- **Android Lint does not gate the build.** It runs and its report is uploaded on every CI run, but a
  warning does not fail the APK build.
- **Release builds are unsigned unless you supply a keystore**, and the release workflow skips
  itself when no signing secrets are present.

---

## License

MIT. See [LICENSE](LICENSE).
