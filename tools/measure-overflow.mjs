// Measures horizontal overflow at a given viewport width.
import WebSocket from 'ws';

const width = Number(process.argv[2] ?? 430);
const targets = await (await fetch('http://127.0.0.1:9555/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  const s = pending.get(m.id);
  if (!s) return;
  pending.delete(m.id);
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result);
});
await new Promise((r) => ws.on('open', r));

await send('Emulation.setDeviceMetricsOverride', {
  width,
  height: 900,
  deviceScaleFactor: 1,
  mobile: true,
});
await new Promise((r) => setTimeout(r, 600));

const { result } = await send('Runtime.evaluate', {
  expression: `(() => {
    const wide = [...document.querySelectorAll('body *')]
      .filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 8)
      .map((n) => ({ tag: n.tagName, cls: String(n.className).slice(0, 36), right: Math.round(n.getBoundingClientRect().right), w: Math.round(n.getBoundingClientRect().width) }));
    return JSON.stringify({ inner: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, offenders: wide });
  })()`,
  returnByValue: true,
});
console.log(result.value);

const shotPath = process.argv[3];
if (shotPath) {
  const { writeFileSync } = await import('node:fs');
  const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  writeFileSync(shotPath, Buffer.from(data, 'base64'));
  console.log('shot ->', shotPath);
}

ws.close();
