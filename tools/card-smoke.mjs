/**
 * The product card on a phone, looked at rather than assumed.
 *
 * A card can pass every unit test and still be unusable: a placeholder cut off mid-character,
 * a figure wrapped away from its label, a button too small for a thumb, money shown in a
 * colour nobody reads as money. This drives the real built app on a real Android viewport,
 * checks the things that only exist on screen, and leaves screenshots to look at.
 *
 * It also exercises the automatic flyer discount end to end through the browser: the mocked
 * reply contains the discount as a separate printed line, exactly as the receipt prints it,
 * and nothing is typed in by hand.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:4173/grocery-pricer/';
const failures = [];
let checks = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name} ${detail}`);
  }
}

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
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

/** A nappy case with a flyer line printed four rows below it, as the paper does. */
const EXTRACTION = {
  supplier: 'SUPPLIER',
  items: [
    {
      rawName: 'DRYNITE JUMBO #6 21CT',
      canonicalName: 'DryNite Jumbo Size 6 Nappies Extra Absorbent',
      size: '21 CT',
      upc: '0000000000016',
      casePrice: '45.99',
      unitsPerCase: 4,
      casesPurchased: 1,
      sourcePhotoIds: [1],
      sourceText: ['DRYNITE JUMBO #6 21CT', '45.99   4'],
      confidence: 0.92,
    },
  ],
  discountLines: [
    {
      amount: '-7.00',
      productName: null,
      productLineAbove: 'DRYNITE JUMBO #6 21CT',
      upc: '0000000000016',
      appliesToIndex: 0,
      reference: 'F12',
      sourcePhotoIds: [1],
      sourceText: ['FLYER DISCOUNT', 'F12', '-7.00', 'UNITS 1'],
    },
  ],
  warnings: [],
};

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
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();

    await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
      const prompt = JSON.stringify(route.request().postDataJSON()?.contents ?? '');
      if (prompt.includes('"images"') || prompt.includes('RECEIPT:')) {
        await route.fulfill(geminiReply({ images: [{ photoId: 1, type: 'RECEIPT', confidence: 0.95 }] }));
        return;
      }
      if (prompt.includes('\\"products\\"') || prompt.includes('Identify every distinct product')) {
        await route.fulfill(geminiReply({ products: [], warnings: [] }));
        return;
      }
      await route.fulfill(geminiReply(EXTRACTION));
    });

    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto(BASE, { waitUntil: 'networkidle' });

    // --- a receipt with a flyer line, read without anybody typing anything -----
    await page.waitForSelector('text=/add your Gemini API key/i', { timeout: 15000 });
    await page.click('button[aria-label="Settings"]');
    await page.fill('#key', 'AIza-test-key');
    await page.click('button:has-text("Save")');
    await page.waitForTimeout(400);
    await page.click('button:has-text("Back")');

    await page.click('text=NEW ORDER');
    await page.setInputFiles('input[type=file]:not([multiple])', {
      name: 'receipt.jpg',
      mimeType: 'image/jpeg',
      buffer: JPEG,
    });
    await page.waitForSelector('.photo img');
    await page.click('button[aria-label="Process order"]');
    await page.waitForSelector('.bubble', { timeout: 30000 });
    await page.waitForTimeout(2500);

    await page.click('button[aria-label="The order"]');
    await page.waitForSelector('.money', { timeout: 15000 });
    // The details live behind the row, so open it.
    await page.waitForTimeout(3200);
    await page.locator('.row-button.bare').first().click();
    await page.waitForSelector('input[aria-label^="Printed discount"]', { timeout: 10000 });

    // --- the flyer money came off by itself -----------------------------------
    const collapsed = await page.locator('main').innerText();
    check('the flyer discount was applied without being typed in', collapsed.includes('$9.75'), collapsed.slice(0, 400));
    check('the case shows what was printed', collapsed.includes('$45.99'));
    check('and the money off it', collapsed.includes('$7.00'));
    check('and what is left', collapsed.includes('$38.99'));

    const money = await page.locator('.money').innerText();
    check('the card reads as a subtraction', /Case[\s\S]*Flyer discount[\s\S]*Net case[\s\S]*Cost each/.test(money), money);
    check('the packs in the case are shown', /4 to sell/.test(money), money);

    // --- colour that means something ------------------------------------------
    const offColour = await page.locator('.money .money-off dd').evaluate((el) => getComputedStyle(el).color);
    const netColour = await page.locator('.money .money-net dd').evaluate((el) => getComputedStyle(el).color);
    check('the money off is red', offColour !== netColour && /^rgb\(1[0-9]{2}, [0-9]{1,2}, /.test(offColour), offColour);

    const profitColour = await page.locator('.pc-value').first().evaluate((el) => getComputedStyle(el).color);
    check('the profit is green', /rgb\(20, 83, 45\)/.test(profitColour), profitColour);

    // Green means money the shop keeps. A cost in the same green reads as earnings.
    const costColour = await page.locator('.money .money-each dd').evaluate((el) => getComputedStyle(el).color);
    check('the cost each is not green', costColour !== profitColour, costColour);

    check('no internal code is shown to the shopkeeper', !collapsed.includes('WHOLE_CASE'), collapsed.slice(0, 300));
    check(
      'the discount says what it comes off, in words',
      collapsed.includes('Discount applied:') && collapsed.includes('off the whole case'),
    );

    await mkdirSync('dist/shots', { recursive: true });
    await page.screenshot({ path: 'dist/shots/card-discounted.png', fullPage: true });

    // --- nothing overflows, nothing is clipped ---------------------------------
    const overflow = await page.evaluate(() => {
      const d = document.documentElement;
      return { scroll: d.scrollWidth, client: d.clientWidth };
    });
    check('the page does not scroll sideways', overflow.scroll <= overflow.client + 1, JSON.stringify(overflow));

    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll('main *')]
        .filter((el) => el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== 'auto')
        .map((el) => `${el.tagName}.${el.className}`.slice(0, 60))
        .slice(0, 5),
    );
    check('no element is cut off by its own box', clipped.length === 0, clipped.join(' | '));

    const box = await page.locator('input[aria-label^="Printed discount"]').boundingBox();
    check('the discount box is wide enough to read', box !== null && box.width >= 96, JSON.stringify(box));
    check('and tall enough to tap', box !== null && box.height >= 44, JSON.stringify(box));

    const small = await page.evaluate(() =>
      [...document.querySelectorAll('main button')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.height < 44;
        })
        .map((el) => el.textContent.trim().slice(0, 30))
        .slice(0, 5),
    );
    check('every button is big enough for a thumb', small.length === 0, small.join(' | '));

    // --- removing a discount is a button, and says so --------------------------
    const remove = page.locator('button:has-text("Remove discount")');
    check('removing a discount is a labelled button', (await remove.count()) === 1);
    check(
      'the card no longer contradicts itself',
      !collapsed.includes('There is no discount on this product'),
    );

    await remove.click();
    await page.waitForTimeout(900);
    const afterRemove = await page.locator('main').innerText();
    check('removing it says so plainly', afterRemove.includes('No discount recorded'), afterRemove.slice(0, 300));
    check('and the cost goes back to the undiscounted one', afterRemove.includes('$11.50'), afterRemove.slice(0, 300));
    check('with no subtraction left on screen', !afterRemove.includes('Flyer discount'));
    await page.screenshot({ path: 'dist/shots/card-plain.png', fullPage: true });

    // --- typing one back in, with the arithmetic shown first --------------------
    await page.fill('input[aria-label^="Printed discount"]', '7.00');
    await page.waitForTimeout(250);
    const preview = await page.locator('.discount-preview').innerText();
    check('the arithmetic is shown before saving', /45\.99[\s\S]*7\.00[\s\S]*38\.99[\s\S]*9\.75/.test(preview), preview);
    await page.screenshot({ path: 'dist/shots/card-typing.png', fullPage: true });

    await page.click('button:has-text("Off the whole case")');
    await page.waitForTimeout(900);
    const afterTyping = await page.locator('main').innerText();
    check('a typed discount comes off the case', afterTyping.includes('$38.99'));
    check('and the cost each follows', afterTyping.includes('$9.75'));

    // --- a long name must not shove the money off the card ----------------------
    const nameWidth = await page.locator('.name').first().evaluate((el) => {
      const row = el.closest('.row-line');
      const price = row.querySelector('.amount');
      return {
        overlap: el.getBoundingClientRect().right > price.getBoundingClientRect().left + 1,
        priceVisible: price.getBoundingClientRect().width > 0,
      };
    });
    check('a long product name does not run into the price', !nameWidth.overlap, JSON.stringify(nameWidth));
    check('the price is still on screen', nameWidth.priceVisible);

    check('no uncaught errors', errors.length === 0, errors.join(' | '));

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

function chromeIn(root) {
  if (!existsSync(root)) return null;
  const dir = readdirSync(root).find((name) => name.startsWith('chromium-'));
  if (dir === undefined) return null;
  const binary = join(root, dir, 'chrome-linux', 'chrome');
  return existsSync(binary) ? { executablePath: binary } : null;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(BASE);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('vite preview never came up');
}

await main();
