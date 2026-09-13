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
      executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
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
    await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
      const url = route.request().url();
      calls.push(url);
      const post = route.request().postDataJSON();
      const prompt = JSON.stringify(post?.contents ?? '');

      if (prompt.includes('"images"') || prompt.includes('RECEIPT:')) {
        await route.fulfill(
          geminiReply({
            images: [{ photoId: 1, type: 'RECEIPT', confidence: 0.95 }],
          }),
        );
        return;
      }
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
    check(
      'it asks for a key before the first order',
      await page.locator('text=/add your free Gemini key/i').isVisible(),
    );

    // --- settings ---------------------------------------------------------
    await page.click('text=Settings');
    await page.fill('#key', 'AIza-test-key');
    await page.click('button:has-text("Save")');
    await page.waitForTimeout(200);
    check('the key saves', (await page.locator('button:has-text("Saved")').count()) === 1);

    const link = page.locator('a:has-text("Get a free Gemini API key")');
    check(
      'the key link points at AI Studio',
      (await link.getAttribute('href')) === 'https://aistudio.google.com/app/apikey',
    );

    await page.click('button:has-text("Back")');
    check(
      'the setup prompt goes away once a key is stored',
      (await page.locator('text=/add your free Gemini key/i').count()) === 0,
    );

    // --- an order ---------------------------------------------------------
    await page.click('text=NEW ORDER');
    check('processing is refused with no photos', await page.isDisabled('text=PROCESS ORDER'));

    await page.setInputFiles('input[type=file]:not([multiple])', {
      name: 'receipt.jpg',
      mimeType: 'image/jpeg',
      buffer: JPEG,
    });
    await page.waitForSelector('.photo img');
    check('a photographed receipt appears', (await page.locator('.photo').count()) === 1);

    await page.click('text=PROCESS ORDER');
    await page.waitForSelector('.bubble.app', { timeout: 20000 });
    const opening = await page.locator('.bubble.app').first().innerText();
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
    const answer = await page.locator('.bubble.app').last().innerText();
    // $24.00 for 12 is $2.00 each, which is the $2.00-$2.99 rung: $4.99.
    check('the answer is priced from the local engine', answer.includes('$4.99'), answer);
    check('the answer names the product', answer.toLowerCase().includes('mayonnaise'), answer);
    check(
      'an ordinary question spends no quota',
      calls.length === callsBeforeQuestion,
      `${calls.length - callsBeforeQuestion} extra call(s)`,
    );

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
