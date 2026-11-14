/**
 * A real browser, the real build, a real service worker, a real IndexedDB.
 *
 * The unit tests run in jsdom, which is not a browser: it has no camera input, no storage
 * eviction, no service worker, and a Blob that is not quite a Blob. This script drives the
 * production build in Chromium so that "it works" means something. The only thing faked is
 * Google: every request to Gemini is intercepted and answered with a canned reply, so the
 * script spends nobody's quota and produces the same result every run.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:4173/grocery-pricer/';
const failures = [];
let checks = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name} ${detail}`);
    failures.push(name);
  }
}

/** A 1x1 JPEG. Small on purpose: the model is faked, so the pixels do not matter. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

function geminiReply(body) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] }, finishReason: 'STOP' }],
    }),
  };
}

async function main() {
  const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--host', '127.0.0.1'], {
    stdio: 'ignore',
  });

  try {
    await waitForServer();

    const browser = await chromium.launch({
      ...(chromeIn('/opt/pw-browsers') ?? {}),
      args: ['--no-sandbox'],
    });
    // A Samsung A17 in portrait, which is what this is actually used on.
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 2.625,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();

    const calls = [];
    const served = [];
    await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
      const url = route.request().url();
      calls.push(url);
      const post = route.request().postDataJSON();
      const prompt = JSON.stringify(post?.contents ?? '');

      if (prompt.includes('\\"products\\"') || prompt.includes('Identify every distinct product')) {
        served.push('identification');
        await route.fulfill(
          geminiReply({
            products: [
              { brand: 'HELLMANNS', productName: 'Mayonnaise', size: '8 OZ', variant: null, upc: null, position: 0, confidence: 0.93 },
            ],
            warnings: [],
          }),
        );
        return;
      }

      if (prompt.includes('"images"') || prompt.includes('RECEIPT:')) {
        served.push('classification');
        await route.fulfill(
          geminiReply({
            images: [{ photoId: 1, type: 'RECEIPT', confidence: 0.95 }],
          }),
        );
        return;
      }
      served.push('extraction');
      await route.fulfill(
        geminiReply({
          supplier: 'JETRO',
          items: [
            {
              rawName: 'HELLM MAYONNAISE 8Z',
              canonicalName: "Hellmann's Mayonnaise",
              size: '8 OZ',
              casePrice: '24.00',
              unitsPerCase: 12,
              casesPurchased: 1,
              sourcePhotoIds: [1],
              sourceText: ['HELLM MAYONNAISE 8Z 24.00'],
              confidence: 0.92,
            },
          ],
          warnings: [],
        }),
      );
    });

    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.goto(BASE, { waitUntil: 'networkidle' });

    check('the app loads', await page.locator('text=NEW ORDER').isVisible());
    // Waited for rather than read once: the prompt appears when the stored key has actually
    // been looked up, so asserting it immediately would pass before anything was checked.
    await page.waitForSelector('text=/add your Gemini API key/i', { timeout: 10000 });
    check('it asks for a key before the first order', true);

    // --- settings ---------------------------------------------------------
    // Typed the instant the screen appears, on purpose. Settings loads the stored key from
    // IndexedDB asynchronously, and on a slow device that read lands after the user has pasted
    // their key: it must not overwrite what they typed, and Save must not then store the blank.
    await page.click('button[aria-label="Settings"]');
    await page.fill('#key', 'AIza-test-key');
    await page.click('button:has-text("Save")');
    await page.waitForTimeout(200);
    check('the key saves', (await page.locator('button:has-text("Saved")').count()) === 1);
    check(
      'saving says so unmistakably',
      await page.locator('.toast', { hasText: 'Key saved' }).isVisible(),
    );
    check('the typed key survived the stored one loading', (await page.inputValue('#key')) === 'AIza-test-key');

    const link = page.locator('a:has-text("Get a free Gemini API key")');
    check(
      'the key link points at AI Studio',
      (await link.getAttribute('href')) === 'https://aistudio.google.com/app/apikey',
    );

    await page.click('button:has-text("Back")');
    await page.click('button[aria-label="Settings"]');
    check(
      'the key is still there when settings is reopened',
      await holdsValue(page, '#key', 'AIza-test-key'),
      `field held "${await page.inputValue('#key')}"`,
    );

    // Saving with the box empty must not delete a working key - that is what the Remove
    // button is for, and a blank field is usually a field that has not loaded yet.
    await page.fill('#key', '');
    await page.click('button:has-text("Save")');
    await page.waitForTimeout(200);
    await page.click('button:has-text("Back")');
    await page.click('button[aria-label="Settings"]');
    check(
      'saving an empty box does not throw the key away',
      await holdsValue(page, '#key', 'AIza-test-key'),
      `field held "${await page.inputValue('#key')}"`,
    );

    await page.click('button:has-text("Back")');
    await page.waitForTimeout(300);
    check(
      'the setup prompt goes away once a key is stored',
      (await page.locator('text=/add your Gemini API key/i').count()) === 0,
    );

    // --- an order ---------------------------------------------------------
    // Backing out of a new order must not leave an empty row behind: the order is created when
    // the button is pressed, so an abandoned one is litter that buries the real orders.
    await page.click('text=NEW ORDER');
    await page.click('button:has-text("Back")');
    await page.waitForTimeout(300);
    check(
      'backing out of a new order leaves nothing behind',
      (await page.locator('text=Not processed yet').count()) === 0,
    );

    await page.click('text=NEW ORDER');
    check(
      'processing is refused with no photos',
      await page.isDisabled('button[aria-label="Process order"]'),
    );

    await page.setInputFiles('input[type=file]:not([multiple])', {
      name: 'receipt.jpg',
      mimeType: 'image/jpeg',
      buffer: JPEG,
    });
    await page.waitForSelector('.photo img');
    check('a photographed receipt appears', (await page.locator('.photo').count()) === 1);

    await page.click('button[aria-label="Process order"]');
    await waitOrExplain(page, '.bubble.reply', { served, errors });
    const opening = await page.locator('.bubble.reply').first().innerText();
    check('the order is summarised', opening.includes('1 product'), opening);
    check('the total is the app\'s own arithmetic', opening.includes('$24.00'), opening);
    check('gemini was actually called', calls.length > 0);

    // --- a question -------------------------------------------------------
    const callsBeforeQuestion = calls.length;
    await page.fill('.composer input[type=text]', 'how much is the mayonnaise');
    await page.click('button[aria-label="Send"]');
    await page.waitForFunction(() => document.querySelectorAll('.bubble').length >= 3, null, {
      timeout: 20000,
    });
    const answer = await page.locator('.bubble.reply').last().innerText();
    // $24.00 for 12 is $2.00 each, which is the $2.00-$2.99 rung: $4.99.
    check('the answer is priced from the local engine', answer.includes('$4.99'), answer);
    check('the answer names the product', answer.toLowerCase().includes('mayonnaise'), answer);
    check(
      'an ordinary question spends no quota',
      calls.length === callsBeforeQuestion,
      `${calls.length - callsBeforeQuestion} extra call(s)`,
    );

    // --- photograph to price ------------------------------------------------
    // The receipt is processed. Now somebody photographs what they are unpacking and asks.
    await page.click('button[aria-label="Attach a photo"]');
    // The inputs are deliberately hidden - the camera is opened by the visible button - so the
    // file is handed to the element itself rather than clicked into it.
    await page.waitForTimeout(300);
    await page.locator('.composer input[type=file]:not([multiple])').setInputFiles({
      name: 'product.jpg',
      mimeType: 'image/jpeg',
      buffer: JPEG,
    });
    await page.waitForFunction(() => document.querySelectorAll('.bubble').length >= 5, null, {
      timeout: 20000,
    });
    const photoAnswer = await page.locator('.bubble.reply').last().innerText();
    check(
      'a photographed product is priced from the receipt',
      photoAnswer.includes('$2.00 each → $4.99 (suggested)'),
      photoAnswer,
    );
    check(
      'and the answer stays short',
      !/margin|markup|%/i.test(photoAnswer) && photoAnswer.split('\n').length <= 3,
      photoAnswer,
    );

    // --- profit per case ---------------------------------------------------
    // $24.00 for 12 was read from the (faked) receipt, so each is $2.00 and the suggested
    // $4.99 earns 12 x $4.99 - $24.00 = $35.88 on the case.
    await page.click('button[aria-label="The order"]');
    await page.waitForSelector('.pc-value');
    check(
      'the case profit is shown on the product',
      (await page.locator('.pc-value').first().innerText()).trim() === '$35.88',
      await page.locator('.pc-value').first().innerText(),
    );

    const priceBox = page.locator('input[aria-label^="Selling price"]').first();
    check('the suggested price is offered', (await priceBox.inputValue()) === '4.99');

    // + asks the case for a dollar more. A case of twelve moves in twelve-cent steps, so the
    // price rounds up and the case earns a little over the dollar - and says so.
    await page.locator('button[aria-label^="Raise profit per case"]').first().click();
    check(
      'plus raises the target by a dollar',
      (await page.locator('.pc-value').first().innerText()).trim() === '$36.96',
      await page.locator('.pc-value').first().innerText(),
    );
    check('and moves the shelf price with it', (await priceBox.inputValue()) === '5.08');
    check(
      'and says what the target really earns',
      await page.locator('text=/You asked for \\$36.88 a case/').isVisible(),
    );

    // Stepping the target rather than the result means + then - comes back to where it started
    // instead of drifting up a few cents each press.
    await page.locator('button[aria-label^="Lower profit per case"]').first().click();
    check(
      'minus returns exactly where it began',
      (await page.locator('.pc-value').first().innerText()).trim() === '$35.88',
      await page.locator('.pc-value').first().innerText(),
    );
    check('with the original price back', (await priceBox.inputValue()) === '4.99');

    // Typed by hand, to the cent.
    await priceBox.fill('6.25');
    check(
      'typing a price recalculates the case profit at once',
      (await page.locator('.pc-value').first().innerText()).trim() === '$51.00',
      await page.locator('.pc-value').first().innerText(),
    );

    // A price under cost has to say so rather than show a quiet negative.
    await priceBox.fill('1.50');
    check('a below-cost price is called out', await page.locator('text=/Below cost/i').isVisible());

    // The stale-draft bug: type a new price, then clear the box. Nothing is on screen to save,
    // so Save must not be offered - it used to still be holding the number that was wiped.
    await priceBox.fill('6.25');
    await priceBox.fill('');
    check(
      'an emptied price box offers nothing to save',
      (await page.locator('button[aria-label^="Save the price"]').count()) === 0,
    );
    check(
      'and says so instead of showing a price it would save',
      await page.locator('text=/Type a price, or press Cancel/').isVisible(),
    );
    check(
      'and the case profit goes blank with it',
      (await page.locator('.pc-value').first().innerText()).trim() === '—',
      await page.locator('.pc-value').first().innerText(),
    );

    // Half-typed is the same promise.
    await priceBox.fill('6.2.5');
    check(
      'a half-typed price offers nothing to save either',
      (await page.locator('button[aria-label^="Save the price"]').count()) === 0,
    );

    // A typed debt is refused, not quietly clamped to zero - that used to save a free product.
    await priceBox.fill('-3.00');
    check(
      'a negative price offers nothing to save',
      (await page.locator('button[aria-label^="Save the price"]').count()) === 0,
    );
    check(
      'and says a price cannot be negative',
      await page.locator('text=/A price cannot be negative/').isVisible(),
    );

    // Finer than a cent is refused rather than rounded behind the owner's back.
    await priceBox.fill('6.2549');
    check(
      'an amount finer than a cent offers nothing to save',
      (await page.locator('button[aria-label^="Save the price"]').count()) === 0,
    );
    check(
      'and says prices go to the cent',
      await page.locator('text=/two decimal places at most/').isVisible(),
    );

    await page.locator('button:has-text("Cancel")').first().click();
    check('cancel puts the suggestion back', (await priceBox.inputValue()) === '4.99');

    await priceBox.fill('6.25');
    await page.locator('button[aria-label^="Save the price"]').first().click();
    await page.waitForTimeout(700);
    check(
      'the saved price is the owner\'s, not a suggestion',
      (await page.locator('text=Your price').count()) > 0,
      'labels on screen: ' + (await page.locator('.row-button .t-cap').allInnerTexts()).join(' | '),
    );

    await page.click('button:has-text("Back")');
    await page.waitForTimeout(300);

    // --- the order survives a reload -------------------------------------
    await page.reload({ waitUntil: 'networkidle' });
    check('the order is still there after a reload', await page.locator('text=NEW ORDER').isVisible());
    check(
      'the processed order is listed',
      (await page.locator('text=/1 product/').count()) >= 1,
    );

    // --- offline ----------------------------------------------------------
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
      timeout: 20000,
    });
    check('a service worker is controlling the page', true);

    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    check('the app opens with no connection', await page.locator('text=NEW ORDER').isVisible());
    await page.click('text=/1 product/');
    await page.waitForSelector('.bubble');
    check(
      'a processed order can be read offline',
      (await page.locator('.bubble').first().innerText()).includes('$24.00'),
    );
    await context.setOffline(false);

    check('no uncaught errors', errors.length === 0, errors.join(' | '));

    if (process.env.SMOKE_SCREENSHOTS === '1') {
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.screenshot({ path: 'dist/screen-home.png' });
    }

    await browser.close();
  } finally {
    server.kill();
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length > 0) {
    console.log('failed: ' + failures.join(', '));
    process.exit(1);
  }
}

/**
 * Uses a pre-installed Chromium if this machine has one.
 *
 * Some environments ship browsers under PLAYWRIGHT_BROWSERS_PATH and forbid downloading more;
 * CI installs its own and knows where it is. Returning nothing lets Playwright decide.
 */
function chromeIn(root) {
  if (!existsSync(root)) return null;
  const dir = readdirSync(root).find((name) => name.startsWith('chromium-'));
  if (dir === undefined) return null;
  const binary = join(root, dir, 'chrome-linux', 'chrome');
  return existsSync(binary) ? { executablePath: binary } : null;
}

/**
 * Waits for a selector, and if it never arrives, reports what the page was saying.
 *
 * The app writes the reason it could not process an order into a notice on screen. Without this,
 * a failure here is a bare timeout: true, useless, and worth a whole CI run to turn into a fact.
 */
/** True once a field holds the expected value. The screen fills it from storage, so give it a moment. */
async function holdsValue(page, selector, expected, timeout = 5000) {
  try {
    await page.waitForFunction(
      ([sel, want]) => document.querySelector(sel)?.value === want,
      [selector, expected],
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

async function waitOrExplain(page, selector, context, timeout = 20000) {
  try {
    await page.waitForSelector(selector, { timeout });
  } catch (error) {
    const notice = await page.locator('.notice').allInnerTexts().catch(() => []);
    const visible = await page.locator('main').innerText().catch(() => '(no main element)');
    console.log('\n--- the page never showed ' + selector + ' ---');
    console.log('notices on screen: ' + (notice.length > 0 ? notice.join(' | ') : '(none)'));
    console.log('gemini calls served: ' + (context.served.length > 0 ? context.served.join(', ') : '(none)'));
    console.log('console errors: ' + (context.errors.length > 0 ? context.errors.join(' | ') : '(none)'));
    console.log('page text: ' + visible.replace(/\s+/g, ' ').slice(0, 600));
    console.log('--- end ---\n');
    throw error;
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(BASE);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error('vite preview never came up');
}

await main();
