/**
 * Proves the installed app updates itself, and only when it is safe to.
 *
 * Two real builds are made and served from the same directory, so the second one replaces the
 * first underneath a running app exactly as a deployment does. Nothing about the service worker
 * is mocked: this is Chromium's own update lifecycle.
 *
 * What it checks, in order:
 *   1. a new deployment is noticed without anyone visiting the site
 *   2. busy work is not interrupted - the update waits and says it is ready
 *   3. it applies by itself once the work is done
 *   4. stored data survives the update
 *   5. it does not reload again afterwards
 *   6. an offline check is harmless
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const BASE_PATH = '/grocery-pricer/';
const PORT = 4186;
const BASE = `http://127.0.0.1:${PORT}${BASE_PATH}`;
const V2_TITLE = 'Grocery Pricer Mk II';
const V3_TITLE = 'Grocery Pricer Mk III';

/** A 1x1 JPEG. The model is faked, so the pixels do not matter. */
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
/** Mirrors MIN_CHECK_GAP_MS in src/ui/pwa.ts. */
const MIN_CHECK_GAP_MS = 10 * 1000;

const failures = [];
let checks = 0;

function check(name, ok, detail = '') {
  checks += 1;
  console.log(ok ? `  ok   ${name}` : `  FAIL ${name} ${detail}`);
  if (!ok) failures.push(name);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Serves whatever is in `dir` right now, so replacing the files is a deployment. */
function serve(dir) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
    let path = url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) : url.pathname.slice(1);
    if (path === '' || path.endsWith('/')) path += 'index.html';
    const file = join(dir, normalize(path).replace(/^(\.\.(\/|\\|$))+/, ''));
    if (!existsSync(file)) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      // Deterministic: the point of the test is the service worker lifecycle, not HTTP caching.
      'cache-control': 'no-cache',
    });
    response.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

function build() {
  execFileSync('npm', ['run', 'build'], { stdio: 'pipe' });
}

function chromeIn(root) {
  if (!existsSync(root)) return null;
  const dir = readdirSync(root).find((name) => name.startsWith('chromium-'));
  if (dir === undefined) return null;
  const binary = join(root, dir, 'chrome-linux', 'chrome');
  return existsSync(binary) ? { executablePath: binary } : null;
}

const work = mkdtempSync(join(tmpdir(), 'gp-update-'));
const served = join(work, 'served');
const second = join(work, 'v2');
const third = join(work, 'v3');
const indexHtml = 'index.html';
const originalIndex = readFileSync(indexHtml, 'utf8');
let server;
let browser;

try {
  console.log('building the version that is already installed…');
  build();
  cpSync('dist', served, { recursive: true });

  console.log('building the version to be deployed…');
  writeFileSync(indexHtml, originalIndex.replace('<title>Grocery Pricer</title>', `<title>${V2_TITLE}</title>`));
  build();
  cpSync('dist', second, { recursive: true });

  console.log('building a third version, for the interrupted-work test…');
  writeFileSync(indexHtml, originalIndex.replace('<title>Grocery Pricer</title>', `<title>${V3_TITLE}</title>`));
  build();
  cpSync('dist', third, { recursive: true });
  writeFileSync(indexHtml, originalIndex);

  server = await serve(served);
  browser = await chromium.launch({ ...(chromeIn('/opt/pw-browsers') ?? {}), args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();

  let loads = 0;
  page.on('load', () => {
    loads += 1;
  });
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  /** Reports the worker's state when something does not happen, instead of a bare timeout. */
  const explain = async (what) => {
    const state = await page
      .evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return {
          controller: navigator.serviceWorker.controller?.scriptURL ?? null,
          installing: registration?.installing?.state ?? null,
          waiting: registration?.waiting?.state ?? null,
          active: registration?.active?.state ?? null,
        };
      })
      .catch((error) => ({ error: String(error) }));
    console.log(`\n--- ${what} ---`);
    console.log('title: ' + (await page.title().catch(() => '(gone)')));
    console.log('loads: ' + loads);
    console.log('worker: ' + JSON.stringify(state));
    console.log('banner visible: ' + (await page.locator('.update-banner').count()));
    console.log('console errors: ' + (consoleErrors.join(' | ') || '(none)'));
    console.log('--- end ---\n');
  };

  await page.goto(BASE, { waitUntil: 'networkidle' });
  // The installed version has to be in charge before anything can replace it.
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30000 });
  check('the installed version is running', (await page.title()) !== V2_TITLE);

  // Something worth not losing: this is what a reload at the wrong moment would cost.
  await page.click('text=Settings');
  await page.fill('#key', 'AIzaStoredBeforeTheUpdate');
  await page.click('button:has-text("Save")');
  await page.waitForTimeout(300);

  // --- a deployment happens while the app is open and in use ---------------
  cpSync(second, served, { recursive: true });
  const loadsBeforeDeploy = loads;

  // Checks are rate limited so that flicking in and out of the app cannot hammer the server.
  // Waiting that out keeps this test about the update lifecycle rather than about the clock.
  await page.waitForTimeout(MIN_CHECK_GAP_MS + 1000);

  // Reopening an installed app on Android resumes it rather than reloading it, so this - not a
  // navigation - is what has to notice the new version.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForSelector('.update-banner', { timeout: 30000 });

  check('a deployment is noticed without visiting the site', true);
  check(
    'work in hand is not interrupted',
    loads === loadsBeforeDeploy && (await page.title()) !== V2_TITLE,
    `${loads - loadsBeforeDeploy} reload(s) during the settings screen`,
  );
  check('it says the update is ready', await page.locator('.update-banner').isVisible());

  // --- finishing the work lets it through ----------------------------------
  await page.click('button:has-text("Back")');
  await page
    .waitForFunction((title) => document.title === title, V2_TITLE, { timeout: 30000 })
    .catch(async (error) => {
      await explain('the update never took over after the work finished');
      throw error;
    });
  check('it applies itself once the work is done', (await page.title()) === V2_TITLE);
  check('the new version is in charge', await page.locator('text=NEW ORDER').isVisible());

  // --- nothing was lost, and nothing keeps happening -----------------------
  await page.click('text=Settings');
  check(
    'the stored key survived the update',
    (await page.inputValue('#key').catch(() => '')) === 'AIzaStoredBeforeTheUpdate' ||
      (await page.waitForFunction(() => document.querySelector('#key')?.value === 'AIzaStoredBeforeTheUpdate', null, { timeout: 5000 }).then(() => true).catch(() => false)),
  );

  const loadsAfterUpdate = loads;
  await page.waitForTimeout(4000);
  check('it does not reload again', loads === loadsAfterUpdate, `${loads - loadsAfterUpdate} extra reload(s)`);
  check('the update notice is gone', (await page.locator('.update-banner').count()) === 0);

  // --- offline --------------------------------------------------------------
  await context.setOffline(true);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(1500);
  check('an offline check changes nothing', await page.locator('#key').isVisible());
  await context.setOffline(false);

  // ---------------------------------------------------------------------------
  // A request still in the air after its screen has gone.
  //
  // Pressing Back during processing unmounts the screen while the receipt is still being read.
  // Anything that tied the hold to the screen would release it there, and an update waiting in
  // the wings would reload the page on top of a half-read order.
  // ---------------------------------------------------------------------------
  console.log('\n--- a receipt still being read after Back ---');

  const second_ = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const work_ = await second_.newPage();

  let releaseGemini = () => {};
  const geminiHeld = new Promise((resolve) => {
    releaseGemini = resolve;
  });
  await second_.route('https://generativelanguage.googleapis.com/**', async (route) => {
    // Held open so the request is genuinely in flight for as long as the test needs.
    await geminiHeld;
    const prompt = JSON.stringify(route.request().postDataJSON()?.contents ?? '');
    if (prompt.includes('"images"') || prompt.includes('RECEIPT:')) {
      await route.fulfill(geminiReply({ images: [{ photoId: 1, type: 'RECEIPT', confidence: 0.9 }] }));
      return;
    }
    await route.fulfill(
      geminiReply({
        supplier: 'JETRO',
        items: [
          {
            rawName: 'CORN OIL 48Z',
            canonicalName: 'Corn Oil',
            size: '48 OZ',
            casePrice: '30.00',
            unitsPerCase: 6,
            casesPurchased: 1,
            sourcePhotoIds: [1],
            sourceText: ['CORN OIL 48Z 30.00'],
            confidence: 0.9,
          },
        ],
        warnings: [],
      }),
    );
  });

  let workLoads = 0;
  work_.on('load', () => {
    workLoads += 1;
  });

  await work_.goto(BASE, { waitUntil: 'networkidle' });
  await work_.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30000 });
  const installedTitle = await work_.title();

  await work_.click('text=Settings');
  await work_.fill('#key', 'AIzaKeyForTheInterruptedRun');
  await work_.click('button:has-text("Save")');
  await work_.waitForTimeout(300);
  await work_.click('button:has-text("Back")');

  await work_.click('text=NEW ORDER');
  await work_.setInputFiles('input[type=file]:not([multiple])', {
    name: 'receipt.jpg',
    mimeType: 'image/jpeg',
    buffer: JPEG,
  });
  await work_.waitForSelector('.photo img');
  await work_.click('button[aria-label="Process order"]');

  // Back, while the receipt is still being read.
  await work_.click('button:has-text("Back")');
  await work_.waitForSelector('text=NEW ORDER');
  check('Back during processing returns to the home screen', true);

  // A deployment lands at the worst possible moment.
  cpSync(third, served, { recursive: true });
  await work_.waitForTimeout(MIN_CHECK_GAP_MS + 1000);
  await work_.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await work_.waitForSelector('.update-banner', { timeout: 30000 });

  const loadsWhileWorking = workLoads;
  await work_.waitForTimeout(3000);
  check(
    'leaving the screen does not release the hold on a running request',
    workLoads === loadsWhileWorking && (await work_.title()) === installedTitle,
    `${workLoads - loadsWhileWorking} reload(s) while the receipt was still being read`,
  );

  // Asking for it outright must not override work in flight either: the person tapping cannot
  // see that a request is still running.
  await work_.click('.update-banner');
  await work_.waitForTimeout(2000);
  check(
    'tapping the update does not interrupt the request',
    workLoads === loadsWhileWorking && (await work_.title()) === installedTitle,
  );
  check(
    'it says the update is waiting for the work to finish',
    (await work_.locator('.update-banner').innerText()).toLowerCase().includes('when this finishes'),
  );

  // The receipt finally comes back.
  releaseGemini();
  await work_.waitForFunction((title) => document.title === title, V3_TITLE, { timeout: 30000 });
  check('the update lands once the request has settled', (await work_.title()) === V3_TITLE);

  // And the order the request was for is still there.
  await work_.waitForSelector('text=NEW ORDER', { timeout: 15000 });
  check(
    'the order the receipt was read into survived',
    (await work_.locator('text=/1 product|Corn Oil/').count()) > 0,
  );

  await second_.close();
} finally {
  writeFileSync(indexHtml, originalIndex);
  if (browser !== undefined) await browser.close();
  if (server !== undefined) server.close();
  rmSync(work, { recursive: true, force: true });
  // This test builds a doctored second version, so dist/ is left holding it. Rebuild so that
  // whatever runs next - an artifact upload, a deployment - gets the real thing.
  try {
    build();
  } catch {
    console.log('warning: could not rebuild dist/ after the test; run npm run build');
  }
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.log('failed: ' + failures.join(', '));
  process.exit(1);
}
