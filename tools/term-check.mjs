// Types a command into the app's in-pod terminal and reads the screen back.
// usage: node tools/term-check.mjs "echo hello"
import WebSocket from 'ws';

const command = process.argv[2] ?? 'echo ui-terminal-ok';
const port = process.env.LENS_CDP_PORT ?? '9222';
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  const s = pending.get(m.id);
  if (!s) return;
  pending.delete(m.id);
  m.error ? s.reject(new Error(JSON.stringify(m.error))) : s.resolve(m.result);
});
await new Promise((r) => ws.on('open', r));
// Chromium can drop injected key events when the window is not foregrounded.
await send('Page.bringToFront').catch(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression) => {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails).slice(0, 500));
  return out.result.value;
};
const screen = () =>
  evaluate(`(() => {
    // several terminals can stay mounted (one per tab); read the visible one
    const rows = [...document.querySelectorAll('.xterm-rows')].filter((e) => e.offsetWidth > 0);
    return rows.length ? rows[rows.length - 1].innerText : '';
  })()`);

// open the Terminal tab inside the detail drawer
await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('button')].filter((e) => e.textContent.trim() === 'Terminal');
  if (!tabs.length) throw new Error('no Terminal tab');
  tabs[tabs.length - 1].click();
  return 'ok';
})()`);
await sleep(3000);
console.log('after open:', JSON.stringify((await screen()).slice(0, 200)));

// focus the xterm textarea so keystrokes land in the pty — several terminals
// stay mounted, so pick the visible one
const focused = await evaluate(`(() => {
  const areas = [...document.querySelectorAll('.xterm-helper-textarea')].filter((e) => e.offsetWidth > 0);
  if (!areas.length) return 'none';
  areas[areas.length - 1].focus();
  return document.activeElement?.className ?? 'none';
})()`);
console.log('focus:', focused);
// xterm reads keydown on its hidden textarea; insertText does not reach it,
// so send real per-character key events.
for (const ch of command) {
  const vk = ch.toUpperCase().charCodeAt(0);
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: ch, code: ch, text: ch, unmodifiedText: ch,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(35);
}
await sleep(300);
await send('Input.dispatchKeyEvent', {
  type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r',
});
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await sleep(2500);

const text = await screen();
console.log('screen:', JSON.stringify(text.slice(0, 600)));
console.log('marker present:', text.includes(command.split(' ').pop()));
ws.close();
