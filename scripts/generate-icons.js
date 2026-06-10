/**
 * scripts/generate-icons.js
 *
 * Generates simple PNG icons for the Chrome extension (16×16, 48×48, 128×128).
 * Uses pngjs (pure JS, no native deps) – no external tools required.
 * Run automatically as part of `npm run build` (prebuild hook).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const ICONS_DIR = path.resolve(__dirname, '..', 'icons');
fs.mkdirSync(ICONS_DIR, { recursive: true });

// Palette – dark background with a light-green ">" cursor accent
const BG   = { r: 30,  g: 30,  b: 46  };  // #1e1e2e
const ACC  = { r: 166, g: 227, b: 161 };  // #a6e3a1 (green)
const TEXT = { r: 205, g: 214, b: 244 };  // #cdd6f4 (white)

/**
 * Draws a simple "{ }" icon with a green prompt-arrow accent
 * at the given pixel size and writes it to icons/icon<size>.png.
 */
function generateIcon(size) {
  const png = new PNG({ width: size, height: size, filterType: -1 });

  // Fill background
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) * 4;
      png.data[idx]     = BG.r;
      png.data[idx + 1] = BG.g;
      png.data[idx + 2] = BG.b;
      png.data[idx + 3] = 255;
    }
  }

  // Helper: paint a pixel (bounds-checked)
  function pixel(x, y, col) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const idx = (size * y + x) * 4;
    png.data[idx]     = col.r;
    png.data[idx + 1] = col.g;
    png.data[idx + 2] = col.b;
    png.data[idx + 3] = 255;
  }

  // Helper: filled rectangle
  function rect(x, y, w, h, col) {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        pixel(x + dx, y + dy, col);
      }
    }
  }

  // Scale factor relative to 128-px reference
  const s = size / 128;

  // Draw ">" prompt symbol (green) in the left 40 % of the icon
  // Reference coords at 128 px:
  //   top-right vertex: (46, 40)
  //   middle vertex:    (58, 64)
  //   bottom-right:     (46, 88)
  //   stroke width: 8 px
  const stroke = Math.max(1, Math.round(8 * s));
  const pts = [
    [46 * s, 40 * s],
    [58 * s, 64 * s],
    [46 * s, 88 * s],
  ];
  // Draw thick lines between vertices
  function drawLine(x0, y0, x1, y1, col, w) {
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.ceil(Math.hypot(dx, dy));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = x0 + dx * t;
      const cy = y0 + dy * t;
      rect(Math.round(cx - w / 2), Math.round(cy - w / 2), w, w, col);
    }
  }
  drawLine(...pts[0], ...pts[1], ACC, stroke);
  drawLine(...pts[1], ...pts[2], ACC, stroke);

  // Draw "_" underscore (text colour) below ">" to suggest a cursor
  const cursorY = Math.round(80 * s);
  const cursorX = Math.round(68 * s);
  const cursorW = Math.max(1, Math.round(30 * s));
  const cursorH = Math.max(1, Math.round(6 * s));
  rect(cursorX, cursorY, cursorW, cursorH, TEXT);

  // Rounded-ish border (single pixel)
  for (let i = 0; i < size; i++) {
    pixel(i, 0, ACC);
    pixel(i, size - 1, ACC);
    pixel(0, i, ACC);
    pixel(size - 1, i, ACC);
  }

  const outPath = path.join(ICONS_DIR, `icon${size}.png`);
  const buf = PNG.sync.write(png);
  fs.writeFileSync(outPath, buf);
  console.log(`✓ icons/icon${size}.png`);
}

[16, 48, 128].forEach(generateIcon);
console.log('Icons generated.');
