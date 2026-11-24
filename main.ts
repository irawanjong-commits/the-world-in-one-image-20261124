// The World in One Image — Tuesday 24 November 2026
// An original, dependency-free Node program that draws a complete
// "extra edition" newspaper front page, pixel by pixel, and encodes
// it as a 1024 x 1024 PNG. Standard library only. Fully deterministic:
// no Date, no Math.random, no network, no external assets.
//
// Architecture:
//   1. A small software rasterizer over an RGB framebuffer
//      (rectangles, lines, circles, ellipses, polygons, stars).
//   2. A hand-authored 5x7 bitmap font, defined as string data below,
//      with measuring, word-wrap and multi-scale text layout.
//   3. Scene illustrations built from the rasterizer primitives:
//      a skyline under a magnifier for the lead, and one pictogram
//      per story panel.
//   4. A from-scratch PNG writer (CRC32 + zlib deflate, fixed settings).
//
// Run:  MAKEFUN_OUTPUT_DIR=<dir> node main.ts   ->  <dir>/entry.png

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Canvas and palette — a white "extra" sheet, black type, red masthead
// ---------------------------------------------------------------------------

const W = 1024;
const H = 1024;

const PAPER = [247, 245, 239];   // sheet white, barely warm
const PANEL = [238, 235, 226];   // panel fill
const PANEL2 = [243, 240, 231];  // lighter panel fill
const INK = [17, 17, 19];        // near-black type
const GREY = [84, 84, 90];       // secondary type
const FAINT = [172, 168, 158];   // hairlines
const RED = [176, 22, 32];       // masthead / signal red
const DARKRED = [128, 14, 24];   // deep red shade
const GOLD = [178, 128, 30];     // ochre accent
const BLUE = [30, 62, 124];      // wire blue accent
const TEAL = [20, 110, 104];     // space/health teal accent
const SKIN = [214, 164, 120];    // pictogram tone

const fb = new Uint8Array(W * H * 3);

function setPx(x, y, c) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  fb[i] = c[0]; fb[i + 1] = c[1]; fb[i + 2] = c[2];
}
function blendPx(x, y, c, a) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  fb[i] = Math.round(fb[i] * (1 - a) + c[0] * a);
  fb[i + 1] = Math.round(fb[i + 1] * (1 - a) + c[1] * a);
  fb[i + 2] = Math.round(fb[i + 2] * (1 - a) + c[2] * a);
}
function fillRect(x, y, w, h, c) {
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(W, Math.ceil(x + w)), y1 = Math.min(H, Math.ceil(y + h));
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) setPx(xx, yy, c);
}
function strokeRect(x, y, w, h, t, c) {
  fillRect(x, y, w, t, c); fillRect(x, y + h - t, w, t, c);
  fillRect(x, y, t, h, c); fillRect(x + w - t, y, t, h, c);
}
function drawLine(x0, y0, x1, y1, t, c) {
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  const r = Math.max(0, (t - 1) / 2);
  for (let s = 0; s <= steps; s++) {
    const x = x0 + (dx * s) / steps, y = y0 + (dy * s) / steps;
    for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) setPx(x + ox, y + oy, c);
  }
}
function fillCircle(cx, cy, r, c) {
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++)
    if (x * x + y * y <= r * r) setPx(cx + x, cy + y, c);
}
function ringCircle(cx, cy, r, t, c) {
  for (let y = -r - t; y <= r + t; y++) for (let x = -r - t; x <= r + t; x++) {
    const d = Math.sqrt(x * x + y * y);
    if (d >= r - t / 2 && d <= r + t / 2) setPx(cx + x, cy + y, c);
  }
}
function fillEllipse(cx, cy, rx, ry, c) {
  for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++)
    if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) setPx(cx + x, cy + y, c);
}
function fillPoly(pts, c) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const n = pts.length;
  for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
    const xs = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y))
        xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2)
      for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i + 1]); x++) setPx(x, y, c);
  }
}
function fillStar(cx, cy, rOuter, rInner, c, rot) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = (rot || 0) + (i * Math.PI) / 5 - Math.PI / 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  fillPoly(pts, c);
}

// ---------------------------------------------------------------------------
// Hand-authored 5x7 bitmap font. Each glyph is 7 rows of 5 pixels,
// '#' for ink. Text is always laid out in upper case.
// ---------------------------------------------------------------------------

const FONT = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".####", "#....", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", ".#.#.", "..#..", "..#..", "..#..", ".#.#.", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#..##", "#.#.#", "##..#", "#...#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", "#####"],
  "2": [".###.", "#...#", "....#", "..##.", ".#...", "#....", "#####"],
  "3": [".###.", "#...#", "....#", "..##.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", ".##..", ".#..."],
  "'": ["..#..", "..#..", ".#...", ".....", ".....", ".....", "....."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  ";": [".....", ".##..", ".##..", ".....", ".##..", ".#...", "....."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  "?": [".###.", "#...#", "....#", "..##.", "..#..", ".....", "..#.."],
  "$": ["..#..", ".####", "#.#..", ".###.", "..#.#", "####.", "..#.."],
  "%": ["##..#", "##.#.", "....#", "...#.", "..#..", ".#...", "#.##."],
  "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
  "/": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
  "(": ["...##", "..#..", ".#...", ".#...", ".#...", "..#..", "...##"],
  ")": [".##..", "..#..", "...#.", "...#.", "...#.", "..#..", ".##.."],
  "&": [".##..", "#..#.", "#.#..", ".#...", "#.#.#", "#..#.", ".##.#"],
  "*": [".....", "#.#.#", ".###.", "#####", ".###.", "#.#.#", "....."],
  '"': [".#.#.", ".#.#.", ".#.#.", ".....", ".....", ".....", "....."],
  "=": [".....", ".....", "#####", ".....", "#####", ".....", "....."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

function glyph(ch) {
  return FONT[ch] || FONT["?"];
}
function textWidth(str, scale) {
  if (str.length === 0) return 0;
  return str.length * 6 * scale - scale;
}
function drawText(x, y, str, scale, c) {
  const s = String(str).toUpperCase();
  let cx = x;
  for (const ch of s) {
    const g = glyph(ch);
    for (let row = 0; row < 7; row++)
      for (let col = 0; col < 5; col++)
        if (g[row][col] === "#")
          fillRect(cx + col * scale, y + row * scale, scale, scale, c);
    cx += 6 * scale;
  }
  return cx - scale;
}
function drawTextCentered(cx, y, str, scale, c) {
  return drawText(cx - textWidth(str, scale) / 2, y, str, scale, c);
}
function drawTextRight(xRight, y, str, scale, c) {
  return drawText(xRight - textWidth(str, scale), y, str, scale, c);
}
function wrapLines(str, scale, maxWidth) {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const trial = cur === "" ? w : cur + " " + w;
    if (textWidth(trial, scale) <= maxWidth || cur === "") cur = trial;
    else { lines.push(cur); cur = w; }
  }
  if (cur !== "") lines.push(cur);
  return lines;
}
// Draws wrapped text; returns the y just below the last line.
function drawPara(x, y, str, scale, c, maxWidth, lineGap) {
  const lines = wrapLines(str, scale, maxWidth);
  const lh = 7 * scale + (lineGap || 0);
  lines.forEach((ln, i) => drawText(x, y + i * lh, ln, scale, c));
  return y + lines.length * lh;
}

// ---------------------------------------------------------------------------
// PNG writer — CRC32 table, IHDR/IDAT/IEND, filter byte 0 per scanline,
// zlib deflate at a fixed level so every run writes the same bytes.
// ---------------------------------------------------------------------------

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
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG() {
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 3);
    raw[row] = 0;
    for (let x = 0; x < W; x++) {
      const src = (y * W + x) * 3, dst = row + 1 + x * 3;
      raw[dst] = fb[src]; raw[dst + 1] = fb[src + 1]; raw[dst + 2] = fb[src + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Illustrations
// ---------------------------------------------------------------------------

// Lead scene: a Shanghai-style skyline at dusk under a giant magnifier —
// the Politburo investigation. Drawn inside box (x, y, w, h).
function drawLeadScene(x, y, w, h) {
  fillRect(x, y, w, h, [26, 30, 44]);                       // night sky
  for (let i = 0; i < 40; i++) {                             // deterministic stars
    const sx = x + ((i * 173) % (w - 8)) + 4, sy = y + ((i * 97) % 70) + 4;
    setPx(sx, sy, [210, 214, 226]);
  }
  fillCircle(x + w - 52, y + 40, 17, [232, 226, 198]);       // moon
  fillCircle(x + w - 60, y + 34, 14, [26, 30, 44]);          // crescent cut
  const base = y + h - 26;
  const towers = [                                           // [dx, width, height]
    [8, 34, 96], [48, 26, 140], [80, 40, 74], [126, 24, 168],
    [156, 34, 108], [196, 26, 148], [228, 38, 84], [272, 24, 128],
  ];
  for (const [dx, tw, th] of towers) {
    fillRect(x + dx, base - th, tw, th, [13, 16, 26]);
    for (let wy = base - th + 10; wy < base - 8; wy += 14)   // lit windows
      for (let wx = x + dx + 5; wx < x + dx + tw - 5; wx += 9)
        if ((wx * 7 + wy * 13) % 5 !== 0) fillRect(wx, wy, 4, 6, [240, 196, 92]);
  }
  // Pearl-tower silhouette: column, two spheres, spire
  const tx = x + w - 92;
  drawLine(tx, base, tx, base - 176, 5, [13, 16, 26]);
  fillCircle(tx, base - 62, 17, [13, 16, 26]);
  fillCircle(tx, base - 128, 11, [13, 16, 26]);
  drawLine(tx, base - 176, tx, base - 204, 2, [13, 16, 26]);
  fillRect(x, base, w, 3, [240, 196, 92]);                   // riverfront light line
  fillRect(x, base + 3, w, h - (base + 3 - y), [16, 22, 38]); // water
  for (let i = 0; i < 12; i++)                               // reflections
    fillRect(x + ((i * 89) % (w - 40)) + 8, base + 8 + (i % 3) * 6, 22, 2, [120, 104, 60]);
  // The magnifier, held over the tallest tower
  ringCircle(x + 138, y + 96, 52, 7, [226, 228, 234]);
  for (let yy = -48; yy <= 48; yy++) for (let xx = -48; xx <= 48; xx++)
    if (xx * xx + yy * yy <= 48 * 48) blendPx(x + 138 + xx, y + 96 + yy, [190, 208, 235], 0.16);
  fillStar(x + 138, y + 96, 26, 11, RED, 0);                 // the red star, enlarged
  drawLine(x + 176, y + 134, x + 224, y + 182, 11, [120, 84, 40]); // handle
  drawLine(x + 176, y + 134, x + 224, y + 182, 6, [168, 122, 58]);
}

// Pictogram: apartment block with a burst — Zaporizhzhia.
function iconBlock(x, y) {
  fillRect(x, y, 34, 46, GREY);
  for (let r = 0; r < 4; r++) for (let cix = 0; cix < 3; cix++)
    fillRect(x + 5 + cix * 10, y + 6 + r * 10, 6, 6, (r === 1 && cix === 2) ? INK : [240, 196, 92]);
  fillPoly([[x + 30, y + 2], [x + 36, y - 8], [x + 38, y + 2], [x + 48, y - 2],
            [x + 42, y + 6], [x + 50, y + 10], [x + 40, y + 12], [x + 44, y + 20],
            [x + 36, y + 14], [x + 30, y + 20]], RED);
}
// Pictogram: jet over rooftops — Gaza.
function iconJet(x, y) {
  fillRect(x, y + 36, 52, 8, GREY);
  fillRect(x + 4, y + 28, 12, 8, GREY); fillRect(x + 24, y + 30, 16, 6, GREY);
  fillPoly([[x + 8, y + 14], [x + 34, y + 6], [x + 46, y + 6], [x + 38, y + 12],
            [x + 44, y + 18], [x + 30, y + 16], [x + 18, y + 20], [x + 10, y + 20]], INK);
  drawLine(x + 12, y + 20, x + 6, y + 28, 3, RED);
  fillStar(x + 6, y + 32, 6, 3, RED, 0);
}
// Pictogram: factory with a crowd — Bangladesh.
function iconFactory(x, y) {
  fillRect(x, y + 18, 40, 26, GREY);
  fillPoly([[x, y + 18], [x + 14, y + 8], [x + 28, y + 18], [x + 40, y + 8], [x + 40, y + 18]], GREY);
  fillRect(x + 44, y + 2, 6, 42, INK);
  fillCircle(x + 47, y - 4, 4, FAINT); fillCircle(x + 52, y - 9, 5, FAINT);
  for (let i = 0; i < 5; i++) { fillCircle(x + 2 + i * 11, y + 50, 3, INK); fillRect(x + i * 11, y + 53, 5, 6, INK); }
}
// Pictogram: pill capsule and cross — the Sanofi deal.
function iconPharma(x, y) {
  fillEllipse(x + 20, y + 16, 20, 9, TEAL);
  fillEllipse(x + 30, y + 16, 10, 9, [236, 238, 240]);
  ringCircle(x + 20, y + 16, 0, 1, TEAL);
  fillRect(x + 38, y + 30, 6, 20, RED); fillRect(x + 31, y + 37, 20, 6, RED);
}
// Pictogram: bird and shield cross — bird flu.
function iconBird(x, y) {
  fillPoly([[x + 4, y + 26], [x + 18, y + 14], [x + 30, y + 16], [x + 24, y + 22],
            [x + 34, y + 22], [x + 26, y + 30], [x + 12, y + 34], [x + 6, y + 32]], BLUE);
  fillPoly([[x + 16, y + 16], [x + 26, y + 4], [x + 28, y + 14]], BLUE);
  fillCircle(x + 27, y + 17, 2, PAPER);
  fillRect(x + 40, y + 30, 5, 18, RED); fillRect(x + 34, y + 36, 17, 5, RED);
}
// Pictogram: space station — Tiangong.
function iconStation(x, y) {
  drawLine(x + 6, y + 24, x + 50, y + 24, 4, INK);
  fillRect(x + 22, y + 18, 12, 12, GREY);
  fillRect(x, y + 14, 16, 20, GOLD); fillRect(x + 40, y + 14, 16, 20, GOLD);
  drawLine(x + 8, y + 14, x + 8, y + 34, 2, INK); drawLine(x + 48, y + 14, x + 48, y + 34, 2, INK);
  fillStar(x + 28, y + 4, 6, 3, RED, 0);
  fillCircle(x + 28, y + 44, 10, TEAL); fillEllipse(x + 28, y + 44, 16, 4, TEAL);
}

// ---------------------------------------------------------------------------
// Page composition — an "extra edition" sheet: red masthead, one lead
// story with a drawn scene, six panels, a markets band and a wire ticker.
// ---------------------------------------------------------------------------

function panel(x, y, w, h, accent, kicker, headline, body, icon) {
  fillRect(x, y, w, h, PANEL2);
  fillRect(x, y, w, 4, accent);
  strokeRect(x, y, w, h, 1, FAINT);
  drawText(x + 14, y + 12, kicker, 1, accent);
  icon(x + w - 64, y + 10);
  drawPara(x + 14, y + 27, headline, 2, INK, 208, 4);
  drawPara(x + 14, y + 88, body, 2, GREY, 272, 4);
}

function compose() {
  fillRect(0, 0, W, H, PAPER);
  strokeRect(24, 24, W - 48, H - 48, 3, INK);
  strokeRect(32, 32, W - 64, H - 64, 1, INK);

  // Masthead
  fillRect(48, 44, W - 96, 104, RED);
  fillRect(48, 44, W - 96, 4, DARKRED);
  drawTextCentered(W / 2, 56, "THE WORLD IN ONE IMAGE", 6, PAPER);
  fillRect(208, 104, W - 416, 2, PAPER);
  fillRect(64, 112, 66, 22, DARKRED);
  drawText(71, 116, "EXTRA", 2, PAPER);
  fillRect(W - 130, 112, 66, 22, DARKRED);
  drawText(W - 123, 116, "EXTRA", 2, PAPER);
  drawTextCentered(W / 2, 114, "TUESDAY 24 NOVEMBER 2026", 3, PAPER);
  drawText(48, 158, "ONE PAGE - THE WHOLE DAY", 1, GREY);
  drawTextRight(W - 48, 158, "SOURCES: REUTERS - AP - XINHUA - UN NEWS", 1, GREY);
  fillRect(48, 172, W - 96, 2, INK);

  // Lead story
  drawText(48, 184, "LEAD - BEIJING, VIA XINHUA", 2, RED);
  drawPara(48, 206, "CHINA PROBES POLITBURO MEMBER CHEN JINING", 5, INK, 540, 8);
  drawPara(48, 350,
    "Shanghai party chief Chen Jining is under investigation, the state " +
    "news agency Xinhua said on Tuesday. He is the fourth member of " +
    "China's elite Politburo to be probed since 2025, as the anti-" +
    "corruption drive reaches the very top of the party.",
    2, GREY, 540, 4);
  drawLeadScene(612, 184, 364, 272);
  drawText(612, 464, "SHANGHAI - WHOSE PARTY CHIEF FACES THE PROBE", 1, GREY);
  fillRect(48, 462, 540, 2, FAINT);

  // Six more stories
  drawText(48, 480, "THE DAY IN SIX MORE STORIES", 2, INK);
  fillRect(48, 500 - 6, W - 96, 1, FAINT);
  const pw = 300, ph = 182, gap = 14;
  const x0 = 48, y1 = 500, y2 = 698;
  panel(x0, y1, pw, ph, RED, "ZAPORIZHZHIA - UKRAINE",
    "NIGHT STRIKE KILLS 2 IN ZAPORIZHZHIA",
    "A Russian attack hit an apartment block overnight, wounding at least 22, including two children.",
    iconBlock);
  panel(x0 + pw + gap, y1, pw, ph, BLUE, "GAZA - MIDDLE EAST",
    "STRIKE KILLS HAMAS SECURITY CHIEF",
    "Israeli airstrikes killed Naeem Abu Nahel and six others, including two police officers, medics said.",
    iconJet);
  panel(x0 + 2 * (pw + gap), y1, pw, ph, GOLD, "GAZIPUR - BANGLADESH",
    "GARMENT WORKERS CLASH WITH POLICE",
    "Pay protests shut dozens of factories as police fired tear gas. Workers demand 30,000 taka a month.",
    iconFactory);
  panel(x0, y2, pw, ph, TEAL, "PARIS - BUSINESS",
    "SANOFI BETS $41 BILLION ON INSMED",
    "The French drugmaker will pay $175 a share in cash for the US firm, in its biggest deal in years.",
    iconPharma);
  panel(x0 + pw + gap, y2, pw, ph, BLUE, "WASHINGTON - HEALTH",
    "BIRD FLU: 3 US CASES, ONE DEATH",
    "The WHO says the US notified three confirmed human bird-flu cases in Washington state, one fatal.",
    iconBird);
  panel(x0 + 2 * (pw + gap), y2, pw, ph, RED, "ORBIT - SCIENCE",
    "A PAKISTANI TO FLY TO TIANGONG",
    "Zeeshan Ali is set to be the first foreign astronaut aboard China's space station, on Shenzhou-24.",
    iconStation);

  // Markets band
  fillRect(48, 892, W - 96, 44, INK);
  drawText(64, 906, "MARKETS", 2, [240, 120, 110]);
  drawText(160, 906, "THE HUANG EFFECT: S&P +4.7% - NASDAQ +6.5% - NIKKEI +3.9%", 2, PAPER);

  // Wire ticker
  drawText(48, 946, "GERMANY FIRST TO USE UKRAINE'S DELTA BATTLE SYSTEM + UN SEEKS BENGHAZI PROBE", 2, INK);
  drawText(48, 966, "NATO VOWS TO DEFEND SPACE + NEPAL 5.6 QUAKE + EBOLA TEAMS TRAPPED IN CONGO", 2, INK);
  drawTextCentered(W / 2, 984, "DRAWN BY A PROGRAM - NO PHOTOGRAPHS - 24 NOVEMBER 2026", 1, GREY);
}

compose();
const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
mkdirSync(outDir, { recursive: true });
const png = encodePNG();
writeFileSync(join(outDir, "entry.png"), png);
console.log("wrote", join(outDir, "entry.png"), png.length, "bytes");
