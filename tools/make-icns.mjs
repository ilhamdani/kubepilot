// Builds build/icon.icns from build/icon.png without macOS `iconutil` and
// without adding a dependency: the PNG is decoded here, resampled to every size
// Apple asks for, and packed into an ICNS container by hand.
//
//   node tools/make-icns.mjs
//
// ICNS is a flat container: the 8-byte header ("icns" + total byte length,
// big-endian) followed by elements of [4-byte OSType][4-byte length][payload].
// For modern macOS every element payload is simply a PNG file, which is why a
// source PNG is all this needs.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, '..', 'build');
const srcPath = path.join(buildDir, 'icon.png');
const outPath = path.join(buildDir, 'icon.icns');

// OSType -> pixel size. The ic11..ic14 types are the @2x retina variants:
// a 32px image in ic11 is the 16pt icon at 2x, and so on.
const ELEMENTS = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];

// macOS icons are drawn on a grid with a margin: the rounded tile covers 824 of
// 1024 pixels, the rest is transparent. A full-bleed icon (what Windows wants,
// and what build/icon.png is) sits visibly larger than its Dock neighbours, so
// the inset is applied here, in the ICNS only, and never to the PNG.
const HIG_TILE = 824 / 1024;

// Minimum source size. Anything smaller means the 512 and 1024 entries would be
// interpolated, which reads as a soft icon next to native ones.
const MIN_SOURCE = 1024;

// ---------------------------------------------------------------- PNG decode

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(file) {
  const buf = fs.readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) throw new Error(`${file}: not a PNG`);
  }

  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];

  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error(`${file}: interlaced PNG is not supported`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  if (depth !== 8) throw new Error(`${file}: only 8-bit PNG is supported, got ${depth}`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`${file}: unsupported PNG color type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`${file}: unknown PNG filter ${filter}`);
      cur[x] = v & 0xff;
    }
  }

  // Normalise everything to RGBA.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 4) {
      rgba[d] = px[s];
      rgba[d + 1] = px[s + 1];
      rgba[d + 2] = px[s + 2];
      rgba[d + 3] = px[s + 3];
    } else if (channels === 3) {
      rgba[d] = px[s];
      rgba[d + 1] = px[s + 1];
      rgba[d + 2] = px[s + 2];
      rgba[d + 3] = 255;
    } else if (channels === 2) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s];
      rgba[d + 3] = px[s + 1];
    } else {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s];
      rgba[d + 3] = 255;
    }
  }

  return { width, height, data: rgba };
}

// ---------------------------------------------------------------- resampling

// Catmull-Rom, for the rare case where the source is smaller than an entry.
// build/icon.png is 1024, so in practice every entry here is a downscale.
function catmullRom(t) {
  const a = -0.5;
  const x = Math.abs(t);
  if (x < 1) return (a + 2) * x * x * x - (a + 3) * x * x + 1;
  if (x < 2) return a * x * x * x - 5 * a * x * x + 8 * a * x - 4 * a;
  return 0;
}

// For each destination index, the source indices and normalised weights.
function contributions(srcLen, dstLen) {
  const scale = srcLen / dstLen;
  const out = [];
  for (let d = 0; d < dstLen; d++) {
    const list = [];
    if (scale >= 1) {
      // Shrinking: box filter over the covered source span (area average).
      const start = d * scale;
      const end = start + scale;
      for (let i = Math.floor(start); i < Math.min(srcLen, Math.ceil(end)); i++) {
        const w = Math.min(end, i + 1) - Math.max(start, i);
        if (w > 0) list.push([i, w / scale]);
      }
    } else {
      const center = (d + 0.5) * scale - 0.5;
      let total = 0;
      for (let i = Math.floor(center) - 1; i <= Math.floor(center) + 2; i++) {
        if (i < 0 || i >= srcLen) continue;
        const w = catmullRom(center - i);
        if (w !== 0) {
          list.push([i, w]);
          total += w;
        }
      }
      for (const item of list) item[1] /= total;
    }
    out.push(list);
  }
  return out;
}

function resample(src, sw, sh, dw, dh) {
  const tmp = new Float32Array(dw * sh * 4);
  const hw = contributions(sw, dw);

  // Horizontal pass, alpha premultiplied so transparent corners do not bleed
  // dark fringes into the edges.
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [i, w] of hw[x]) {
        const s = (y * sw + i) * 4;
        const alpha = src[s + 3] / 255;
        r += src[s] * alpha * w;
        g += src[s + 1] * alpha * w;
        b += src[s + 2] * alpha * w;
        a += src[s + 3] * w;
      }
      const o = (y * dw + x) * 4;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
      tmp[o + 3] = a;
    }
  }

  const vw = contributions(sh, dh);
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [i, w] of vw[y]) {
        const s = (i * dw + x) * 4;
        r += tmp[s] * w;
        g += tmp[s + 1] * w;
        b += tmp[s + 2] * w;
        a += tmp[s + 3] * w;
      }
      const o = (y * dw + x) * 4;
      const alpha = a / 255;
      // Un-premultiply. Both ends need clamping: Catmull-Rom undershoots below
      // zero on a hard edge, and a negative value written into a Buffer wraps to
      // 255 - which showed up as a ring of opaque black pixels around the tile.
      out[o] = alpha > 0 ? clamp255(r / alpha) : 0;
      out[o + 1] = alpha > 0 ? clamp255(g / alpha) : 0;
      out[o + 2] = alpha > 0 ? clamp255(b / alpha) : 0;
      out[o + 3] = clamp255(a);
    }
  }
  return out;
}

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// Draws the source onto a transparent canvas with the HIG margin. The artwork is
// scaled to HIG_TILE of the edge and centred; everything outside stays clear.
function compose(source, size) {
  const art = Math.max(1, Math.round(size * HIG_TILE));
  const offset = Math.floor((size - art) / 2);
  const scaled =
    art === source.width && art === source.height
      ? source.data
      : resample(source.data, source.width, source.height, art, art);

  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < art; y++) {
    scaled.copy(out, ((y + offset) * size + offset) * 4, y * art * 4, (y + 1) * art * 4);
  }
  return out;
}

// ---------------------------------------------------------------- PNG encode

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICNS build

function buildIcns(elements) {
  const parts = [];
  for (const [type, png] of elements) {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    parts.push(head, png);
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

const source = decodePng(srcPath);

if (source.width !== source.height) {
  throw new Error(
    `${path.relative(process.cwd(), srcPath)} is ${source.width}x${source.height}; the icon must be square`,
  );
}
if (source.width < MIN_SOURCE) {
  throw new Error(
    `${path.relative(process.cwd(), srcPath)} is ${source.width}x${source.height}; at least ${MIN_SOURCE}x${MIN_SOURCE} is required, otherwise the 512 and 1024 entries are upscaled and look soft next to native icons`,
  );
}

const cache = new Map();
const elements = ELEMENTS.map(([type, size]) => {
  if (!cache.has(size)) {
    cache.set(size, encodePng(size, compose(source, size)));
  }
  return [type, cache.get(size)];
});

const icns = buildIcns(elements);
fs.writeFileSync(outPath, icns);

console.log(
  `wrote ${path.relative(process.cwd(), outPath)} (${icns.length} bytes) from a ${source.width}x${source.height} source`,
);
console.log(`elements: ${ELEMENTS.map(([t, s]) => `${t}=${s}px`).join(', ')}`);
