// Tiny CDP driver: evaluate JS in the running app and capture a screenshot.
// usage: node tools/cdp.mjs "<js expression>" [out.png]
import { writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const expression = process.argv[2] ?? '1';
const out = process.argv[3];

const port = process.env.LENS_CDP_PORT ?? '9222';
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('no page target', targets.map((t) => t.type));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
let id = 0;
const pending = new Map();

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const messageId = ++id;
    pending.set(messageId, { resolve, reject });
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

await new Promise((resolve) => ws.on('open', resolve));

try {
  if (expression.startsWith('KEYS:')) {
    const text = expression.slice(5);
    for (const ch of text) {
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: ch,
        key: ch,
        windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
        nativeVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
      });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      await new Promise((r) => setTimeout(r, 40));
    }
    await new Promise((r) => setTimeout(r, 500));
    const state = await send('Runtime.evaluate', {
      expression:
        "JSON.stringify({items: document.querySelectorAll('.palette-item').length, labels: [...document.querySelectorAll('.palette-item')].slice(0,6).map(e=>e.textContent), input: document.querySelector('.palette-input input')?.value})",
      returnByValue: true,
    });
    console.log(state.result?.value);
    if (out) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log('screenshot ->', out);
    }
    ws.close();
    process.exit(0);
  }

  if (expression.startsWith('TYPE:')) {
    const text = expression.slice(5);
    await send('Runtime.evaluate', { expression: "document.querySelector('.palette-input input, .search-input input')?.focus()" });
    await send('Input.insertText', { text });
    await new Promise((r) => setTimeout(r, 500));
    const state = await send('Runtime.evaluate', {
      expression:
        "JSON.stringify({items: document.querySelectorAll('.palette-item').length, labels: [...document.querySelectorAll('.palette-item')].slice(0,6).map(e=>e.textContent)})",
      returnByValue: true,
    });
    console.log(state.result?.value);
    if (out) {
      await new Promise((r) => setTimeout(r, 400));
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log('screenshot ->', out);
    }
    ws.close();
    process.exit(0);
  }

  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    console.error('EXCEPTION', JSON.stringify(result.exceptionDetails, null, 1).slice(0, 1200));
  } else {
    console.log(JSON.stringify(result.result?.value ?? result.result, null, 1)?.slice(0, 4000));
  }

  if (out) {
    await new Promise((r) => setTimeout(r, 700));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('screenshot ->', out);
  }
} finally {
  ws.close();
}
