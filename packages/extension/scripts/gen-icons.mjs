/**
 * Dependency-free PNG icon generator for the Celeste extension.
 *
 * Writes solid, rounded-square "boba" icons (violet → cyan gradient with a
 * white pearl) at 16/32/48/128 px into `public/icons/`.
 *
 * The PNG encoder is hand rolled on top of `node:zlib` so the extension
 * package does not need an image dependency.
 *
 *   node scripts/gen-icons.mjs [outputDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/* -------------------------------------------------------------------------- */
/* PNG encoding                                                               */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type "none"
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* -------------------------------------------------------------------------- */
/* Drawing                                                                    */
/* -------------------------------------------------------------------------- */

const SAMPLES = 4; // 4x4 supersampling

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function roundedRectCoverage(x, y, size, radius) {
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  if (dx <= 0 && dy <= 0) return 1;
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  const distance = Math.sqrt(ox * ox + oy * oy);
  return Math.max(0, Math.min(1, radius - distance));
}

function circleCoverage(x, y, cx, cy, radius) {
  const distance = Math.hypot(x - cx, y - cy);
  return Math.max(0, Math.min(1, radius - distance + 0.5));
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.24;
  const pearlRadius = size * 0.22;
  const pearlX = size * 0.56;
  const pearlY = size * 0.58;

  const topLeft = [124, 92, 255];
  const bottomRight = [34, 211, 238];

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let coverage = 0;
      let pearlCoverage = 0;
      let gradientT = 0;

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = px + (sx + 0.5) / SAMPLES;
          const y = py + (sy + 0.5) / SAMPLES;
          const cover = roundedRectCoverage(x, y, size, radius);
          if (cover <= 0) continue;
          coverage += cover;
          gradientT += cover * ((x / size) * 0.35 + (y / size) * 0.65);
          pearlCoverage += cover * circleCoverage(x, y, pearlX, pearlY, pearlRadius);
        }
      }

      const total = SAMPLES * SAMPLES;
      if (coverage <= 0) continue;

      const alpha = Math.min(1, coverage / total);
      const t = gradientT / coverage;
      const base = mix(topLeft, bottomRight, Math.min(1, Math.max(0, t)));

      // Pearl: a white blob with a soft violet rim.
      const pearl = Math.min(1, pearlCoverage / total);
      const rim = Math.max(0, Math.min(1, (pearl - 0.55) / 0.45));
      const color = mix(base, [255, 255, 255], rim * 0.92);

      const offset = (py * size + px) * 4;
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = Math.round(alpha * 255);
    }
  }

  return encodePng(size, size, rgba);
}

export function generateIcons(outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const file = path.join(outputDir, `icon${size}.png`);
    fs.writeFileSync(file, renderIcon(size));
    console.log(`[celeste:extension] wrote ${path.relative(process.cwd(), file)}`);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const defaultDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
  generateIcons(process.argv[2] ? path.resolve(process.argv[2]) : defaultDir);
}
