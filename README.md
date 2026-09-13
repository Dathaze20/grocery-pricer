# Grocery Pricer

Photograph a wholesale receipt. Press one button. Then ask what anything costs.

Grocery Pricer is an installable web app for a small grocery store. It reads the receipt from a
supplier, works out what each retail unit actually cost after discounts, suggests a shelf price,
and then lets the shopkeeper ask about it in plain language — including "how much is this?" while
holding the product up to the camera. It also checks a delivery against its invoice.

It installs from a link. There is no app store, no APK, and no Apple developer account. It runs on
Android, iPhone, iPad, and any desktop browser.

---

## The rule the whole app is built around

> **AI identifies and interprets. The local engine calculates money. The local database is
> authoritative.**

Gemini is allowed to say what characters are printed on a receipt and which product a sentence
refers to. It is never allowed to work out a cost, propose a price, or fill in a missing number.
Every figure the app shows was either read back out of its own database or computed by
`src/core/` — deterministic TypeScript with 170+ tests behind it.

Concretely:

- Money is stored and calculated as **integer ten-thousandths of a dollar**. No float ever touches
  a price. `Money.of('41.99')` parses digit by digit rather than through `parseFloat`.
- A true unit cost is a case price, minus the part of a discount that applies to one case, divided
  by the pack count. The app does that division. The receipt's own printed "unit price" is
  recorded but not trusted.
- A discount whose scope is unclear **does not move the cost at all** until the shopkeeper says
  what it applies to. Guessing would silently change what a customer is charged.
- If a cost could not be read, the app stores **no price**, not a zero.

## The two workflows

**Processing an order.** Photograph the receipt — several overlapping photos are fine. Press
PROCESS ORDER. The app sorts the photos, reads them in batches, merges lines that appeared in more
than one photo, computes each true unit cost, suggests a shelf price from the cost ladder, and
opens a conversation with a one-line summary. Then ask it things:

```
how much is the mayonnaise          → asks which one, if there are two sizes
what do I make on the corn oil at $5.99
how many in the case of evaporated milk
actually the oil goes out at 7.99   → saved, and remembered for next time
[photo of a product]                → identified, then priced from this order
```

Ordinary questions are answered on the device with no API call at all.

**Checking a delivery.** Photograph what the driver left. The app counts the cases it can see and
compares them to the invoice it already read. It reports what it counted and how sure it is —
never a verdict:

> Budweiser 24 CT: invoice says 8 cases, I can count 7. That is 1 short, but part of the stack may
> be hidden — take another photo from a different angle before calling it missing.

A photograph is evidence, not an inventory. A pallet hides its own back row, and telling a
shopkeeper that cases are missing when they are simply behind the front row starts an argument
with a supplier over nothing. Several photos of one stack are treated as one stack — the highest
count wins, never the sum.

---

## Setting it up

### 1. Get a free Gemini API key

Open **<https://aistudio.google.com/app/apikey>**, sign in with your Google account, and press
**Create API key**. This is the same Google AI Studio you may already use for other projects.

The key goes on Google's **free tier**. Grocery Pricer never enables billing, never selects a paid
model, and never upgrades anything on your behalf. If the free allowance runs out, it says exactly
this and stops:

> Free Gemini quota reached. Grocery Pricer will not charge you. Try again after the quota resets.

### 2. Open the app and paste the key in

Settings → AI setup → paste → Save. The key is stored in this browser, on this device.

### 3. Install it to the home screen

- **Android (Chrome):** open the link, then menu **⋮ → Add to Home screen** (or "Install app").
- **iPhone / iPad (Safari):** open the link, then **Share → Add to Home Screen**.
- **Desktop (Chrome/Edge):** the install icon appears at the right of the address bar.

After that it opens like any other app, full screen, with its own icon.

---

## About the API key (read this before making it public)

This version is **BYOK** — bring your own key. Each person who uses the app supplies their own
Gemini key, and that key is stored in their own browser's IndexedDB. It is sent to
`generativelanguage.googleapis.com` and nowhere else. It is not in the source, not in the build,
not in this repository, and there is no server of ours for it to reach. A CI check fails the build
if anything key-shaped appears in `dist/`.

**This is the right architecture for one shopkeeper's phone, and the wrong architecture for a
public service.** A key in a browser is readable by anything with access to that browser: an
extension, another script on the same origin, or anyone holding the unlocked device. If Grocery
Pricer ever becomes a product that many people sign into, the key must move to a backend that
holds one server-side credential, authenticates users, applies per-user rate limits, and proxies
the calls. Do not ship the browser-key model to strangers.

---

## Running it yourself

```bash
npm install
npm run dev          # local dev server
npm run typecheck
npm test             # 170+ unit tests, no key and no network needed
npm run build        # produces dist/
npm run test:browser # drives the built site in Chromium, Gemini intercepted
```

Tests never call Google. `FakeAiProvider` answers from a script, so the suite is deterministic and
spends nobody's quota. The browser smoke test intercepts every request to
`generativelanguage.googleapis.com` and answers it locally.

### Deploying

The included workflow (`.github/workflows/pwa.yml`) builds on every push and deploys the default
branch to GitHub Pages. To turn it on:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. Push to the default branch. The workflow builds and deploys.
3. The app is then at `https://<user>.github.io/grocery-pricer/` — that is the link to open on the
   phone and install.

The build's base path defaults to `/grocery-pricer/`. For a custom domain or a user page, build
with `BASE_PATH=/ npm run build`.

Any static host works just as well: `dist/` is a folder of files. It must be served over HTTPS —
service workers and the camera both require it (`localhost` is exempt).

---

## What is stored, and where

Everything is local to the device: orders, photos, products, price history, conversations, the
pricing rules, and the API key. Nothing is uploaded anywhere except the photographs that go to
Gemini on the calls you ask for.

The app shell is cached by a service worker, so a processed order opens and can be read with no
connection at all. Calls to Gemini are deliberately **never** cached — a stale answer about money
is worse than no answer.

Clearing the browser's site data deletes everything. There is no cloud backup.

## Layout

```
src/core/      money, cost, pricing, matching, queries, chat parsing, delivery reconciliation
src/ai/        the Gemini client, the prompts, the provider, and the fake used by every test
src/data/      IndexedDB schema and the repository
src/app/       the pipeline behind the one button, the conversation, the delivery check
src/ui/        React screens, mobile first
tools/         icon generation and the browser smoke test
```

`src/core/` has no imports from `src/ai/`, `src/data/`, or `src/ui/`. The arithmetic does not know
that a model exists.

## Licence

MIT. See [LICENSE](LICENSE).
