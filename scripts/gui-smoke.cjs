// ============================================================================
// GUI smoke test (Playwright + Electron), run after `npm run build`:
//
//   npm run smoke:gui
//
// Starts the real app off-screen with a throw-away profile and a fake Ollama
// on 127.0.0.1, then checks the main paths: first conversation archived,
// offline status + Retry, settings dialog, the Models window (installed list,
// catalog badges, download with progress, cancel, delete confirm, minimum
// size), minimum size with large text, Markdown images never loaded, desktop
// list at minimum size, no CSP violations. Nothing touches the real
// %APPDATA%\Vellum.
//
// SMOKE_SCREENSHOTS=1 also saves docs/screenshots/models.png (2x, off-screen).
// ============================================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { _electron } = require('playwright-core');

const APP = path.resolve(__dirname, '..');
const HOOK = path.join(__dirname, 'gui-smoke-hook.cjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${!ok && detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ''}`);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const GB = 1e9;
const tagEntry = (name, size, family, parameterSize) => ({
  name,
  size,
  details: { family, families: [family], parameter_size: parameterSize, quantization_level: family === 'bert' ? 'F16' : 'Q4_K_M' },
});

/** Just enough of the Ollama API: tags, streaming chat, one-shot chat, embeddings, pull, delete. */
function fakeOllama() {
  let chats = 0;
  const state = {
    installed: [tagEntry('qwen3:8b', 5.2 * GB, 'qwen3', '8.2B'), tagEntry('bge-m3:latest', 1.2 * GB, 'bert', '566.70M')],
    pulls: [],
    aborted: [],
    deletes: [],
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const json = (value) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/api/tags') return json({ models: state.installed });
      if (req.url === '/api/delete' && req.method === 'DELETE') {
        const { name } = JSON.parse(body || '{}');
        state.deletes.push(name);
        const before = state.installed.length;
        state.installed = state.installed.filter((m) => m.name !== name);
        if (state.installed.length === before) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end('{"error":"model not found"}');
        }
        return json({});
      }
      if (req.url === '/api/pull' && req.method === 'POST') {
        // NDJSON progress like Ollama; gemma3:1b is slow enough to be cancelled
        const { name } = JSON.parse(body || '{}');
        state.pulls.push(name);
        const steps = name === 'gemma3:1b' ? 400 : 8;
        const total = 1.4 * GB;
        let step = 0;
        let finished = false;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
        const timer = setInterval(() => {
          step += 1;
          if (step <= steps) {
            res.write(`${JSON.stringify({ status: 'pulling 3a1b', digest: 'sha256:3a1b', total, completed: Math.round((total * step) / steps) })}\n`);
            return;
          }
          clearInterval(timer);
          finished = true;
          state.installed.push(tagEntry(name, total, 'qwen3', '2.0B'));
          res.write(`${JSON.stringify({ status: 'verifying sha256 digest' })}\n`);
          res.end(`${JSON.stringify({ status: 'success' })}\n`);
        }, 150);
        res.on('close', () => {
          if (finished) return;
          clearInterval(timer);
          state.aborted.push(name);
        });
        return;
      }
      if (req.url === '/api/version') return json({ version: '0.12.6' });
      if (req.url === '/api/ps') return json({ models: [] });
      if (req.url === '/api/embeddings') return json({ embedding: Array.from({ length: 1024 }, (_, i) => Math.sin(i)) });
      if (req.url === '/api/chat') {
        const request = JSON.parse(body || '{}');
        if (request.stream === false) return json({ message: { role: 'assistant', content: '{"title":"Smoke test"}' }, done: true });
        chats += 1;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ message: { content: `Hello from the fake model (#${chats}).` }, done: false })}\n`);
        res.end(`${JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 10, eval_count: 5, eval_duration: 1e9 })}\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  server.state = state;
  return server;
}

// overlap / off-window detector for the visible controls
const DETECT = () => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const W = window.innerWidth;
  const H = window.innerHeight;
  const controls = [...document.querySelectorAll('button, input, select, textarea, a, h1')]
    .filter((el) => visible(el) && !el.closest('.chat-scroll'));
  const offscreen = controls.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.right > W + 1 || r.bottom > H + 1 || r.left < -1 || r.top < -1;
  }).length;
  let overlaps = 0;
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i].getBoundingClientRect();
      const b = controls[j].getBoundingClientRect();
      if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ix > 2 && iy > 2) overlaps++;
    }
  }
  // the header title: no text-overflow ellipsis anywhere, and the word whole or hidden
  const header = document.querySelector('[data-header]');
  const truncated = header ? [...header.querySelectorAll('*')].filter((el) => getComputedStyle(el).textOverflow === 'ellipsis').length : 0;
  const word = header && header.querySelector('h1 span');
  const title = !word ? 'none' : getComputedStyle(word).display === 'none' ? 'hidden' : word.scrollWidth <= word.clientWidth ? 'whole' : 'cut';
  return { overlaps, offscreen, truncated, title };
};

// the same for the Models window: every control inside it, including the scrolled
// list (rows must not overlap either), and the window itself inside the viewport
const DETECT_MODELS = () => {
  const dialog = document.querySelector('[aria-labelledby="models-title"]');
  if (!dialog) return { missing: true };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const W = window.innerWidth;
  const H = window.innerHeight;
  const d = dialog.getBoundingClientRect();
  const inside = d.left >= -1 && d.top >= -1 && d.right <= W + 1 && d.bottom <= H + 1;
  const controls = [...dialog.querySelectorAll('button, input, h2, [data-fit]')].filter(visible);
  const offscreen = controls.filter((el) => {
    if (el.closest('.chat-scroll')) return false;
    const r = el.getBoundingClientRect();
    return r.right > d.right + 1 || r.bottom > d.bottom + 1 || r.left < d.left - 1 || r.top < d.top - 1;
  }).length;
  let overlaps = 0;
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i].getBoundingClientRect();
      const b = controls[j].getBoundingClientRect();
      if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ix > 2 && iy > 2) overlaps++;
    }
  }
  return { inside, overlaps, offscreen, controls: controls.length };
};

async function main() {
  const ollama = fakeOllama();
  const port = await listen(ollama);
  const fake = ollama.state;
  const shots = Boolean(process.env.SMOKE_SCREENSHOTS);
  const imageHits = [];
  const imageServer = http.createServer((req, res) => {
    imageHits.push(req.url);
    res.end();
  });
  const imagePort = await listen(imageServer);
  const host = `http://127.0.0.1:${port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vellum-gui-'));
  const dataDir = path.join(profile, 'Vellum');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'migration.json'), '{"from":"none"}');
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({ language: 'en', ollamaHost: host, ollamaModel: 'qwen3:8b', globalHotkey: '', alwaysOnTop: false, routerEnabled: false, compactionEnabled: false }),
  );

  const consoleLines = [];
  const pageErrors = [];
  const env = { ...process.env, VELLUM_PROFILE_DIR: profile };
  if (shots) env.VELLUM_SMOKE_SCALE = '2';
  delete env.VITE_DEV_SERVER_URL;
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await _electron.launch({ executablePath: require('electron'), args: ['-r', HOOK, '.'], cwd: APP, env, timeout: 60000 });
  const page = await app.firstWindow();
  page.on('console', (message) => consoleLines.push(message.text()));
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  // Polls from Node: an off-screen window may stop animation frames and throttle its own
  // timers, so an in-page waitForFunction can miss text that is already on the page.
  const waitText = async (text, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await page.evaluate((t) => document.body.innerText.includes(t), text).catch(() => false)) return true;
      await sleep(250);
    }
    return false;
  };
  const waitFor = async (fn, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await fn().catch(() => false)) return true;
      await sleep(200);
    }
    return false;
  };
  const count = (selector) => page.locator(selector).count();
  const modelsOpen = async () => (await count('[aria-labelledby="models-title"]')) === 1;
  const resize = (w, h) => app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [w, h]);

  try {
    await page.waitForSelector('button[title="Vellum"]', { timeout: 30000 });
    await page.click('button[title="Vellum"]');
    await page.waitForSelector('textarea');
    const layout = await page.evaluate(DETECT);
    check('panel opens without overlapping controls, title word whole', layout.overlaps === 0 && layout.offscreen === 0 && layout.truncated === 0 && layout.title === 'whole', layout);
    check('status shows the reachable model', await waitText('Local model · qwen3:8b'));

    await page.fill('textarea', 'Hello');
    await page.keyboard.press('Enter');
    check('streamed answer arrives', await waitText('Hello from the fake model (#1)'));
    await sleep(800);
    const conversations = await page.evaluate(() => window.companion.conversations.list({}));
    check('first conversation is archived with both messages', conversations.length === 1 && conversations[0].messageCount === 2, conversations);

    await page.evaluate(() => window.companion.updateSettings({ ollamaHost: 'http://127.0.0.1:9' }));
    check('status turns to "not reachable"', await waitText('Ollama not reachable'));
    await page.fill('textarea', 'Second');
    await page.keyboard.press('Enter');
    check('friendly error with Retry', (await waitText('Could not reach Ollama')) && (await page.locator('button', { hasText: 'Retry' }).count()) === 1);
    await page.evaluate((h) => window.companion.updateSettings({ ollamaHost: h }), host);
    await page.click('button:has-text("Retry")');
    check('Retry gets an answer', await waitText('Hello from the fake model (#2)'));

    await page.click('button[aria-label="Settings"]');
    await page.waitForSelector('[role="dialog"]');
    await page.keyboard.press('Escape');
    check('Esc closes the settings dialog', (await page.locator('[role="dialog"]').count()) === 0);

    // --- Models window ---
    await page.click('button[aria-label="Models"]');
    check('header button opens the Models window', await waitFor(modelsOpen));
    check('installed list shows the model in use', await waitFor(async () =>
      (await page.locator('[data-installed="qwen3:8b"]').innerText()).includes('In use')));
    check('installed models show a fit badge', await waitFor(async () =>
      (await count('[data-installed] [data-fit]')) === (await count('[data-installed]'))));
    check('embedding model has no Use button', (await count('[data-installed="bge-m3:latest"] button:has-text("Use")')) === 0);
    await page.click('[role="tab"]:has-text("Catalog")');
    check('catalog lists 20+ models, each with a fit badge', await waitFor(async () =>
      (await count('[data-catalog]')) >= 20 && (await count('[data-catalog] [data-fit]')) === (await count('[data-catalog]'))));
    check('installed catalog entry offers Use instead of Download',
      (await count('[data-catalog="qwen3:8b"] button:has-text("Download")')) === 0);

    await page.fill('input[aria-label="Any Ollama model tag…"]', 'bad tag!');
    check('free tag field rejects an invalid tag', (await waitText('Not a valid model tag')) &&
      (await page.locator('[role="dialog"] button:has-text("Download")').first().isDisabled()));
    await page.fill('input[aria-label="Any Ollama model tag…"]', '');

    await page.click('[data-catalog="qwen3:1.7b"] button:has-text("Download")');
    check('download shows a progress bar with percent and MB', await waitFor(async () =>
      /\d+% · \d+ \/ 1400 MB/.test(await page.locator('[data-download="running"]').innerText())));
    check('other downloads are disabled while one runs',
      await page.locator('[data-catalog="gemma3:1b"] button:has-text("Download")').isDisabled());
    check('download completes and offers Use now', await waitFor(async () => (await count('button:has-text("Use now")')) === 1));
    check('installed list is refreshed after the download', (await count('[data-catalog="qwen3:1.7b"] button:has-text("Download")')) === 0);
    await page.click('button:has-text("Use now")');
    check('Use now switches the chat model', await waitFor(async () =>
      (await page.evaluate(() => window.companion.getBootstrap())).settings.ollamaModel === 'qwen3:1.7b'));
    await page.evaluate(() => window.companion.updateSettings({ ollamaModel: 'qwen3:8b' }));

    await page.click('[data-catalog="gemma3:1b"] button:has-text("Download")');
    await waitFor(async () => /\d+%/.test(await page.locator('[data-download="running"]').innerText()));
    await page.click('[data-download="running"] button:has-text("Cancel")');
    check('Cancel stops the download', (await waitFor(async () => (await count('[data-download]')) === 0)) &&
      (await waitFor(async () => fake.aborted.includes('gemma3:1b'))) &&
      !fake.installed.some((m) => m.name === 'gemma3:1b'), fake.aborted);

    await page.click('[role="tab"]:has-text("Installed")');
    await page.click('[data-installed="qwen3:1.7b"] button:has-text("Delete")');
    await page.waitForSelector('[role="alertdialog"]');
    await page.keyboard.press('Escape');
    check('Esc closes only the delete confirm', (await count('[role="alertdialog"]')) === 0 && (await modelsOpen()) && fake.deletes.length === 0);
    await page.click('[data-installed="qwen3:1.7b"] button:has-text("Delete")');
    await page.click('[role="alertdialog"] button:has-text("Delete")');
    check('confirmed delete removes the model', (await waitFor(async () => (await count('[data-installed="qwen3:1.7b"]')) === 0)) &&
      fake.deletes.join() === 'qwen3:1.7b', fake.deletes);

    for (const large of [false, true]) {
      await page.evaluate((v) => window.companion.updateSettings({ largeText: v }), large);
      await sleep(400);
      await resize(200, 200);
      await sleep(600);
      for (const tab of ['Installed', 'Catalog']) {
        await page.click(`[role="tab"]:has-text("${tab}")`);
        await sleep(300);
        const fit = await page.evaluate(DETECT_MODELS);
        check(`Models at minimum size${large ? ' with large text' : ''} (${tab}): no overlap`, fit.inside && fit.overlaps === 0 && fit.offscreen === 0, fit);
      }
    }
    await page.evaluate(() => window.companion.updateSettings({ largeText: false }));
    await resize(452, 652);
    await sleep(400);
    await page.mouse.click(24, 330); // on the dimmed overlay, beside the window
    check('click outside closes the Models window', await waitFor(async () => !(await modelsOpen())));

    await page.click('button[aria-label="Settings"]');
    await page.click('[role="tab"]:has-text("Model")');
    await page.click('button:has-text("Browse models…")');
    check('Settings > Browse models opens the Models window', await waitFor(modelsOpen));
    await page.keyboard.press('Escape');
    check('Esc closes the Models window', await waitFor(async () => !(await modelsOpen())));

    await page.evaluate(() => window.companion.updateSettings({ largeText: true }));
    await sleep(400);
    await resize(200, 200);
    await sleep(600);
    const small = await page.evaluate(DETECT);
    check('minimum size with large text: no overlap, no truncated header text', small.overlaps === 0 && small.offscreen === 0 && small.truncated === 0 && (small.title === 'whole' || small.title === 'hidden'), small);
    await page.evaluate(() => window.companion.updateSettings({ largeText: false }));

    for (let i = 1; i <= 4; i++) {
      await page.evaluate((n) => window.companion.conversations.appendMessage({ conversationId: `conv-seed-${n}`, role: 'user', content: `Seeded question ${n}` }), i);
    }
    await page.evaluate((p) => window.companion.conversations.appendMessage({
      conversationId: 'conv-seed-1',
      role: 'assistant',
      content: `A picture ![chart](http://127.0.0.1:${p}/exfil.png?d=secret) and text.`,
    }), imagePort);
    await page.evaluate(() => window.companion.updateSettings({ layout: 'desktop' }));
    await sleep(800);
    await page.reload();
    await page.waitForSelector('aside', { timeout: 15000 });
    await resize(200, 200);
    await sleep(800);
    const rows = await page.evaluate(() => {
      const box = document.querySelector('aside .chat-scroll');
      const outer = box.getBoundingClientRect();
      return [...box.children].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= outer.top - 1 && r.bottom <= outer.bottom + 1 && r.height > 20;
      }).length;
    });
    check('desktop minimum size shows at least 3 conversations', rows >= 3, rows);
    await page.locator('aside .chat-scroll .group button').first().click();
    await sleep(1500);
    check('Markdown image is shown as a link and never requested', (await waitText('[image: chart]', 5000)) && imageHits.length === 0, imageHits);

    await page.click('button[aria-label="Models"]');
    check('desktop titlebar opens the Models window', await waitFor(modelsOpen));
    await page.click('[role="tab"]:has-text("Catalog")');
    await sleep(300);
    const desktopFit = await page.evaluate(DETECT_MODELS);
    check('desktop minimum size: Models window without overlap', desktopFit.inside && desktopFit.overlaps === 0 && desktopFit.offscreen === 0, desktopFit);
    if (shots) {
      await resize(1132, 752);
      await sleep(800);
      await page.mouse.move(1, 1); // no hover highlight in the picture
      await page.screenshot({ path: path.join(APP, 'docs', 'screenshots', 'models.png'), omitBackground: true });
      console.log('  saved docs/screenshots/models.png');
    }
    await page.keyboard.press('Escape');

    check('no Content-Security-Policy violations', !consoleLines.some((l) => /Content.Security.Policy|Refused to/i.test(l)));
    check('no page errors', pageErrors.length === 0, pageErrors);
  } finally {
    await app.close().catch(() => undefined);
    ollama.close();
    imageServer.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? '\nALL GOOD\n' : `\n${failed} FAILED\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
