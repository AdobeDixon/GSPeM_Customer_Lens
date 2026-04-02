#!/usr/bin/env node
/**
 * Cursor MCP stdio wrapper: merges playwright-mcp.config.json with Chrome flags to load
 * this repo as an unpacked extension (workspace root = extension directory).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const workspaceRoot = path.resolve(__dirname, '..');
const baseConfigPath = path.join(workspaceRoot, 'playwright-mcp.config.json');
const generatedPath = path.join(workspaceRoot, '.cursor', 'playwright-mcp.generated.json');

let base = {};
if (fs.existsSync(baseConfigPath)) {
  try {
    base = JSON.parse(fs.readFileSync(baseConfigPath, 'utf8'));
  } catch (e) {
    console.error('[playwright-mcp-with-extension] Invalid JSON in playwright-mcp.config.json:', e.message);
    process.exit(1);
  }
}

base.browser = base.browser || {};
base.browser.browserName = base.browser.browserName || 'chromium';
base.browser.launchOptions = base.browser.launchOptions || {};
// Google Chrome no longer supports --load-extension; use Playwright's bundled Chromium.
base.browser.launchOptions.channel = base.browser.launchOptions.channel || 'chromium';

const prevArgs = base.browser.launchOptions.args || [];
const extArgs = [
  `--load-extension=${workspaceRoot}`,
  `--disable-extensions-except=${workspaceRoot}`,
];
base.browser.launchOptions.args = [
  ...extArgs,
  ...prevArgs.filter(
    (a) => !a.startsWith('--load-extension=') && !a.startsWith('--disable-extensions-except='),
  ),
];
// Playwright/Chromium defaults include --disable-extensions, which blocks --load-extension.
base.browser.launchOptions.ignoreDefaultArgs = base.browser.launchOptions.ignoreDefaultArgs || [
  '--disable-extensions',
];

if (!base.capabilities) {
  base.capabilities = ['core', 'devtools', 'network'];
}
if (!base.console) {
  base.console = { level: 'debug' };
}

fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
fs.writeFileSync(generatedPath, JSON.stringify(base, null, 2));

const isWin = process.platform === 'win32';
const npx = isWin ? 'npx.cmd' : 'npx';
const child = spawn(npx, ['-y', '@playwright/mcp@latest', '--config', generatedPath], {
  stdio: 'inherit',
  shell: isWin,
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
