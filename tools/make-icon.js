// Generates build/icon.png (256x256 RGBA) with no external dependencies.
// KubePilot mark: a helmsman's wheel — Kubernetes is Greek for "helmsman".
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const S = 1024;
const SS = 3; // supersampling factor per axis

// The mark was drawn on a 256px grid; U maps that grid onto S so every constant
// below scales with the output size. Changing S rescales the whole drawing.
const U = S / 256;

const BG_TOP = [18, 26, 28];
const BG_BOTTOM = [10, 16, 18];
const TEAL_LIGHT = [45, 212, 191];
const TEAL_DARK = [13, 116, 134];
const HUB = [17, 94, 89];
const WHITE = [236, 254, 252];

const cx = S / 2;
const cy = S / 2;
const RING_R = 74 * U;
const RING_W = 13 * U;
const SPOKE_OUT = 108 * U;
const SPOKE_IN = 26 * U;
const SPOKE_W = 11 * U;
const HUB_R = 30 * U;
const corner = 56 * U;

function roundedAlpha(x, y) {
  const dx = Math.max(corner - x, 0, x - (S - corner));
  const dy = Math.max(corner - y, 0, y - (S - corner));
  return Math.max(0, Math.min(1, (corner - Math.hypot(dx, dy) + 0.5 * U) / U));
}

function mix(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

// distance from point to a segment
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

// Spokes at 45 degree steps, each a thick segment.
const spokes = [];
for (let i = 0; i < 8; i++) {
  const a = (i * Math.PI) / 4;
  spokes.push({
    ax: cx + Math.cos(a) * SPOKE_IN,
    ay: cy + Math.sin(a) * SPOKE_IN,
    bx: cx + Math.cos(a) * SPOKE_OUT,
    by: cy + Math.sin(a) * SPOKE_OUT,
  });
}

function sample(x, y) {
  const px = x + 0.5;
  const py = y + 0.5;
  const r = Math.hypot(px - cx, py - cy);

  // background: vertical gradient plate with a faint radial lift
  let col = mix(BG_TOP, BG_BOTTOM, py / S);
  col = mix(col, [26, 44, 46], Math.max(0, 1 - r / (120 * U)) * 0.55);

  const tealAt = (d) => mix(TEAL_LIGHT, TEAL_DARK, Math.min(1, d / (110 * U)));

  // spokes
  for (const s of spokes) {
    const d = segDist(px, py, s.ax, s.ay, s.bx, s.by);
    if (d < SPOKE_W / 2) {
      const edge = (SPOKE_W / 2 - d) / U;
      col = mix(col, tealAt(r), Math.min(1, edge));
    }
  }

  // outer rim
  const ringD = Math.abs(r - RING_R);
  if (ringD < RING_W / 2) {
    const edge = Math.min(1, (RING_W / 2 - ringD) / U);
    let ring = tealAt(r);
    const hl = Math.max(0, 1 - Math.hypot(px - (cx - 46 * U), py - (cy - 46 * U)) / (62 * U));
    ring = mix(ring, WHITE, hl * 0.45);
    col = mix(col, ring, edge);
  }

  // hub
  if (r < HUB_R) col = mix(col, HUB, Math.min(1, (HUB_R - r) / U));

  // hub ring accent
  const hubRing = Math.abs(r - (HUB_R - 6 * U));
  if (hubRing < 2.4 * U) col = mix(col, TEAL_LIGHT, 0.55 * Math.min(1, (2.4 * U - hubRing) / (1.2 * U)));

  // centre pin
  if (r < 7 * U) col = mix(col, WHITE, Math.min(1, (7 * U - r) / U));

  return col;
}

const buf = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS - 0.5, y + (sy + 0.5) / SS - 0.5);
        r += c[0];
        g += c[1];
        b += c[2];
      }
    }
    const n = SS * SS;
    const i = (y * S + x) * 4;
    buf[i] = Math.round(r / n);
    buf[i + 1] = Math.round(g / n);
    buf[i + 2] = Math.round(b / n);
    buf[i + 3] = Math.round(roundedAlpha(x, y) * 255);
  }
}

// PNG encode: signature + IHDR + IDAT + IEND
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
console.log('wrote', path.join(outDir, 'icon.png'), png.length, 'bytes');
