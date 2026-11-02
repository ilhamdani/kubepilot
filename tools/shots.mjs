// Drives the running app through its main screens and saves screenshots for the docs site.
// usage: node tools/shots.mjs [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const outDir = path.resolve(process.argv[2] ?? 'site/assets/shots');
mkdirSync(outDir, { recursive: true });

const port = process.env.LENS_CDP_PORT ?? '9222';
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.error) slot.reject(new Error(JSON.stringify(msg.error)));
  else slot.resolve(msg.result);
});

await new Promise((r) => ws.on('open', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
  return res.result.value;
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
  console.log('shot', name);
}

async function typeText(text) {
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'char', text: ch });
    await sleep(45);
  }
}

async function pressEnter() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
}

async function pressEscape() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
}

// Reset the renderer so every run starts from the same state (dark theme).
await evaluate(`window.kube.settings.set({ themeId: 'kubepilot-dark' }).then(() => 'ok')`);
await sleep(600);
await send('Page.reload', { ignoreCache: false });
await sleep(2600);

const helpers = `
  window.__kp = {
    // smallest element whose trimmed text equals the label (works for icon buttons)
    byText(text, tag) {
      const all = [...document.querySelectorAll(tag ?? '*')]
        .filter((n) => n.textContent.trim() === text);
      all.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      return all[0];
    },
    row(i) { return document.querySelectorAll('.tr')[i]; },
    dblclick(el) { el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); },
    click(el) { el?.click(); },
    key(key, opts = {}) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }));
    },
    state() {
      return {
        drawer: !!document.querySelector('.drawer'),
        dock: !!document.querySelector('.dock'),
        palette: !!document.querySelector('.palette'),
        term: !!document.querySelector('.xterm'),
        tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim()),
      };
    },
  };
  'ok';
`;
await evaluate(helpers);

// 1. Overview (default tab)
await sleep(800);
await shot('hero');

// 2. Pods table with live metrics
await evaluate(`__kp.click(__kp.byText('Pods')); 'ok'`);
await sleep(1600);
await shot('pods');

// 3. Details drawer
await evaluate(`__kp.dblclick(__kp.row(0)); 'ok'`);
await sleep(1300);
console.log('after drawer:', JSON.stringify(await evaluate('__kp.state()')));
await shot('details');

// 4. Logs dock (the Logs/Terminal actions live on the Overview tab)
await evaluate(`__kp.click(__kp.byText('Logs', 'button')); 'ok'`);
await sleep(2600);
console.log('after logs:', JSON.stringify(await evaluate('__kp.state()')));
await shot('logs');

// 5. Exec terminal for the same pod, then run `ls`
await evaluate(`__kp.click(__kp.byText('Terminal', 'button')); 'ok'`);
await sleep(2400);
await evaluate(`document.querySelector('.xterm-screen')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); 'ok'`);
await sleep(400);
await typeText('ls');
await pressEnter();
await sleep(1800);
console.log('after terminal:', JSON.stringify(await evaluate('__kp.state()')));
await shot('terminal');

// 6. YAML tab inside the drawer
await evaluate(`__kp.click(__kp.byText('YAML', 'button')); 'ok'`);
await sleep(2000);
await shot('yaml');

// 7. Command palette
await evaluate(`__kp.key('k', { ctrlKey: true }); 'ok'`);
await sleep(1000);
await shot('palette');
await pressEscape();
await sleep(600);
console.log('after palette:', JSON.stringify(await evaluate('__kp.state()')));

// 8. Nodes with usage/capacity
await evaluate(`__kp.click(__kp.byText('Nodes')); 'ok'`);
await sleep(1800);
await shot('nodes');

// 9. Preferences
await evaluate(`__kp.click(document.querySelector('.rail-footer .rail-btn:last-child')); 'ok'`);
await sleep(1400);
console.log('after settings:', JSON.stringify(await evaluate('__kp.state()')));
await shot('settings');

// 10. Light theme from Preferences
await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Light');
    b?.click();
    return !!b;
  })()
`);
await sleep(1500);
await shot('light');

console.log('done ->', outDir);
ws.close();
