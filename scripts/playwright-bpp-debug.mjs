#!/usr/bin/env node
/**
 * Loads this repo as an unpacked extension, opens GenStudio (GENSTUDIO_URL), opens Brand/Product/Persona
 * suggestion menus, dumps listbox rows (data-key, soft-hide, top) and recent [GS4PM Filter] console lines.
 *
 * --- Mode A (default): isolated Playwright Chromium + unpacked extension ---
 *   Empty chrome.storage — good for CI / extension load smoke test only.
 *   npx playwright install chromium
 *   npm run playwright:bpp-debug
 *
 * --- Mode B: attach to YOUR real Chrome (same tags / customers / filter as daily use) ---
 *   Extension data lives in chrome.storage per browser profile. The isolated profile has no data.
 *   Use Chrome DevTools Protocol (CDP):
 *     1. Quit Chrome completely (Cmd+Q on Mac).
 *     2. bash scripts/chrome-with-remote-debugging.sh
 *     3. PLAYWRIGHT_CONNECT_CDP=1 npm run playwright:bpp-debug
 *   Optional: CDP_ENDPOINT=http://127.0.0.1:9333 if you use a different port.
 *   We do NOT call browser.close() in CDP mode so your Chrome keeps running.
 *
 * After the run, browser stays open until Enter (set KEEP_BROWSER_OPEN=0 to exit immediately in Mode A).
 */
import { chromium } from 'playwright';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');
const userDataDir = path.join(extensionRoot, '.pw-bpp-profile');
const outReport = path.join(extensionRoot, 'playwright-bpp-debug-report.json');

const GENSTUDIO_URL =
  process.env.GENSTUDIO_URL ||
  'https://experience.adobe.com/#/@demoemea/genstudio/create/from-template/urn:aaid:aem:e6f9fc80-ba6a-4f95-a142-ee9fed2c214e';

const gatherListboxDump = () => {
  const out = [];
  for (const f of document.querySelectorAll('iframe')) {
    let doc;
    try {
      doc = f.contentDocument;
    } catch (e) {
      continue;
    }
    if (!doc) continue;
    doc.querySelectorAll('[role="listbox"]').forEach((lb) => {
      const rows = [];
      lb.querySelectorAll('[role="presentation"]').forEach((pr) => {
        const opt = pr.querySelector('[role="option"]');
        if (!opt) return;
        rows.push({
          top: pr.style.top,
          bppSoftHide: pr.getAttribute('data-gs4pm-bpp-soft-hide'),
          dataKey: opt.getAttribute('data-key'),
          dataItemId: opt.getAttribute('data-item-id'),
          text: (opt.textContent || '').trim().slice(0, 80),
        });
      });
      if (rows.length) {
        out.push({
          id: lb.id,
          ariaLabel: lb.getAttribute('aria-label'),
          rowCount: rows.length,
          rows,
        });
      }
    });
  }
  return out;
};

const CLICK_TIMEOUT_MS = 90_000;
const IFRAME_WAIT_MS = 180_000;

async function waitForGenStudioShell(page) {
  if (process.env.PLAYWRIGHT_SKIP_GOTO !== '1') {
    await page.goto(GENSTUDIO_URL, { waitUntil: 'load', timeout: 180000 });
  } else {
    await page.waitForTimeout(2000);
  }
  await page
    .waitForURL(/experience\.adobe\.com/i, { timeout: 60000 })
    .catch(() => {});
  const sel =
    'iframe[name="Main Content"], iframe[name="Main_Content"], iframe[title*="GenStudio" i], iframe[src*="thunderbird"], iframe[src*="genstudio" i]';
  await page.waitForSelector(sel, { state: 'attached', timeout: IFRAME_WAIT_MS });
  await page.waitForTimeout(process.env.PLAYWRIGHT_SKIP_GOTO === '1' ? 3000 : 10000);
}

function attachConsoleLogger(page) {
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[GS4PM Filter]')) {
      process.stdout.write('[page] ' + t + '\n');
    }
  });
}

/**
 * CDP: same Chrome profile as you started with --remote-debugging-port (tags + storage intact).
 */
async function connectExistingChrome() {
  const endpoint = process.env.CDP_ENDPOINT || process.env.PLAYWRIGHT_CDP_ENDPOINT || 'http://127.0.0.1:9222';
  console.log('[playwright-bpp-debug] CDP mode — attaching to:', endpoint);
  console.log(
    '[playwright-bpp-debug] Using your real Chrome profile (extension storage: customers, tags, filter).'
  );

  const browser = await chromium.connectOverCDP(endpoint);
  const contexts = browser.contexts();
  if (!contexts.length) {
    throw new Error('No browser contexts from CDP. Is Chrome running with --remote-debugging-port?');
  }

  let page = null;
  for (const ctx of contexts) {
    const ps = ctx.pages();
    const hit = ps.find((p) => {
      try {
        return /experience\.adobe\.com/i.test(p.url());
      } catch (e) {
        return false;
      }
    });
    if (hit) {
      page = hit;
      break;
    }
    if (!page && ps.length) page = ps[0];
  }
  if (!page) {
    page = await contexts[0].newPage();
  }

  attachConsoleLogger(page);
  return { browser, page, mode: 'cdp' };
}

async function launchIsolatedChromiumWithExtension() {
  const useGoogleChrome = process.env.PLAYWRIGHT_USE_GOOGLE_CHROME === '1';
  const channel = useGoogleChrome ? 'chrome' : 'chromium';
  if (useGoogleChrome) {
    console.warn(
      '[playwright-bpp-debug] PLAYWRIGHT_USE_GOOGLE_CHROME=1: Google Chrome often ignores --load-extension; extension may not load. Prefer default (bundled Chromium).'
    );
  }

  console.log('[playwright-bpp-debug] Browser channel:', channel);
  console.log('[playwright-bpp-debug] Isolated profile — empty extension storage unless you import data elsewhere.');
  console.log('[playwright-bpp-debug] Loading unpacked extension from:\n  ', extensionRoot);

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
    ],
  });

  let extensionServiceWorkerOk = false;
  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 25000 });
    }
    extensionServiceWorkerOk = !!sw;
    console.log('[playwright-bpp-debug] Extension service worker:', sw.url());
  } catch (e) {
    console.error('[playwright-bpp-debug] No extension service worker — MV3 background did not load:', e.message);
  }

  const page = context.pages()[0] || (await context.newPage());
  attachConsoleLogger(page);
  return { context, page, mode: 'persistent', extensionServiceWorkerOk };
}

async function main() {
  fs.mkdirSync(userDataDir, { recursive: true });

  const useCdp =
    process.env.PLAYWRIGHT_CONNECT_CDP === '1' ||
    process.env.CDP_ENDPOINT ||
    process.env.PLAYWRIGHT_CDP_ENDPOINT;

  let browser = null;
  let context = null;
  let page;
  let mode;
  let extensionServiceWorkerOk = false;

  if (useCdp) {
    const r = await connectExistingChrome();
    browser = r.browser;
    page = r.page;
    mode = r.mode;
    extensionServiceWorkerOk = true;
  } else {
    const r = await launchIsolatedChromiumWithExtension();
    context = r.context;
    page = r.page;
    mode = r.mode;
    extensionServiceWorkerOk = r.extensionServiceWorkerOk;
  }

  await waitForGenStudioShell(page);

  const barVisible = await page
    .locator('#gs4pm-workspace-bar')
    .count()
    .then((n) => n > 0)
    .catch(() => false);
  if (!barVisible) {
    console.warn(
      '[playwright-bpp-debug] #gs4pm-workspace-bar not found — content script may not have run (extension not loaded or host_permissions).'
    );
  } else {
    console.log('[playwright-bpp-debug] Workspace bar detected (extension content script running).');
  }

  const report = {
    url: page.url(),
    requestedUrl: GENSTUDIO_URL,
    connectMode: mode,
    usesRealChromeStorage: mode === 'cdp',
    browserChannel: mode === 'cdp' ? 'cdp-existing-chrome' : process.env.PLAYWRIGHT_USE_GOOGLE_CHROME === '1' ? 'chrome' : 'chromium',
    extensionServiceWorkerOk,
    workspaceBarDetected: barVisible,
    at: new Date().toISOString(),
    steps: [],
  };

  const frame = page.frameLocator(
    'iframe[name="Main Content"], iframe[name="Main_Content"], iframe[src*="thunderbird"], iframe[src*="genstudio" i]'
  );

  const names = ['Brand', 'Product', 'Persona'];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      const btn = frame.getByRole('button', { name: new RegExp(`Show suggestions ${name}`, 'i') });
      await btn.waitFor({ state: 'visible', timeout: CLICK_TIMEOUT_MS });
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: CLICK_TIMEOUT_MS, force: false });
      await page.waitForTimeout(2500);
      const dump = await page.evaluate(gatherListboxDump);
      report.steps.push({ kind: name, listboxes: dump });
      if (i < names.length - 1) {
        await frame.locator('body').press('Escape').catch(() => {});
        await page.waitForTimeout(800);
      }
    } catch (e) {
      report.steps.push({ kind: name, error: String(e) });
    }
  }

  const finalDump = await page.evaluate(gatherListboxDump);
  report.finalListboxDump = finalDump;

  fs.writeFileSync(outReport, JSON.stringify(report, null, 2), 'utf8');
  console.log('\nWrote', outReport);

  if (mode === 'cdp') {
    console.log(
      '\n[playwright-bpp-debug] CDP mode: left Chrome running (did not close the browser). Close the terminal when done.'
    );
    return;
  }

  if (process.env.KEEP_BROWSER_OPEN === '0') {
    await context.close();
    return;
  }

  console.log(
    '\nBrowser left open — check chrome://extensions (GenStudio Customer Lens should be ON) and the page for the workspace bar.\nPress Enter in this terminal to close Chromium...'
  );
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
  await context.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
