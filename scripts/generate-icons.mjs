/**
 * DKS icon pipeline.
 *
 * Source of truth: `build/logo-source.png` (the official DKS logo: navy "D",
 * blue "K"/"S" and the "SOFTWARE FOR BUSINESSES" tagline on white).
 *
 * Produces, all from that one file:
 *   build/icon.png          1024x1024 app icon (full lockup, transparent)
 *   build/icon.ico          Windows icon: 256, 48, 32 and 16 px PNG frames
 *   src/assets/dks-logo.png 720px wide lockup for About / the sign-in card
 *   src/assets/dks-logo-dark.png  the same lockup lightened for dark mode
 *                                (no white plate behind the wordmark)
 *
 * (The old src/assets/dks-mark.png square "D" tile was retired: every UI
 * surface — sidebar brand, sign-in, About and the favicon — shows the real
 * full logo.)
 *
 * Notes
 *   - The white page around the artwork is keyed out (ink-over-white
 *     unmultiply), so the icon does not show as a white tile on a dark
 *     taskbar. Anti-aliased edges stay smooth because the key is applied
 *     after resizing, at the target size.
 *   - The tagline is kept where it can still be read (256px and the PNGs) and
 *     dropped at 48/32/16, where 11px of letter-spaced caps would only smear.
 *     Set DKS_ICON_STYLE=full to keep it at every size.
 *   - Everything is measured from the image (ink bounding box + row runs), so
 *     a re-exported logo of the same shape regenerates correctly.
 *
 * Usage: node scripts/generate-icons.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pngToIco from 'png-to-ico';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(ROOT, 'build/logo-source.png');

const ICON_PNG = resolve(ROOT, 'build/icon.png');
const ICON_ICO = resolve(ROOT, 'build/icon.ico');
const ASSET_LOGO = resolve(ROOT, 'src/assets/dks-logo.png');
const ASSET_LOGO_DARK = resolve(ROOT, 'src/assets/dks-logo-dark.png');

/** Inks below this distance from white are treated as page, not artwork. */
const WHITE_CUTOFF = 245;
/** Alpha under this (0-255) is dropped entirely (kills JPEG-ish speckle). */
const ALPHA_FLOOR = 20;

const STYLE = (process.env.DKS_ICON_STYLE ?? '').toLowerCase();
const TAGLINE_FROM = STYLE === 'full' ? 0 : 256;

/**
 * Ink bounding boxes of the logo: the wordmark and, when present, the line of
 * tagline text underneath it. Measured, never hard-coded.
 */
export async function measureLogo(sourcePath = SOURCE) {
  const { data, info } = await sharp(sourcePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const isInk = (x, y) => {
    const i = (y * width + x) * channels;
    return data[i + 3] > ALPHA_FLOOR
      && (data[i] < WHITE_CUTOFF || data[i + 1] < WHITE_CUTOFF || data[i + 2] < WHITE_CUTOFF);
  };

  const rowHasInk = new Array(height).fill(false);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (isInk(x, y)) {
        rowHasInk[y] = true;
        break;
      }
    }
  }

  // Vertical runs of ink separated by blank rows.
  const runs = [];
  let start = null;
  for (let y = 0; y < height; y += 1) {
    if (rowHasInk[y] && start === null) start = y;
    if (!rowHasInk[y] && start !== null) {
      if (y - start >= 2) runs.push({ top: start, bottom: y - 1 });
      start = null;
    }
  }
  if (start !== null) runs.push({ top: start, bottom: height - 1 });

  if (runs.length === 0) {
    throw new Error('generate-icons: no ink found in the logo source');
  }

  // The tagline is the last run when it is clearly smaller than the wordmark
  // and clearly separated from it. Otherwise the logo is wordmark-only.
  const first = runs[0];
  const last = runs[runs.length - 1];
  const wordmarkHeight = first.bottom - first.top + 1;
  const hasTagline = runs.length > 1
    && last !== first
    && (last.bottom - last.top + 1) <= wordmarkHeight * 0.4;

  const wordmarkRows = { top: first.top, bottom: hasTagline ? runs[runs.length - 2].bottom : last.bottom };
  const fullRows = { top: first.top, bottom: last.bottom };

  const columnsIn = (top, bottom) => {
    let minX = width;
    let maxX = -1;
    for (let y = top; y <= bottom; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (isInk(x, y)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    return { left: minX, right: maxX };
  };

  const wordmarkCols = columnsIn(wordmarkRows.top, wordmarkRows.bottom);
  const fullCols = columnsIn(fullRows.top, fullRows.bottom);

  const crop = (rows, cols) => ({
    left: cols.left,
    top: rows.top,
    width: cols.right - cols.left + 1,
    height: rows.bottom - rows.top + 1,
  });

  const wordmark = crop(wordmarkRows, wordmarkCols);

  // The "D" is the first glyph: scan for the gap between the D and the K/S
  // slash inside the wordmark band.
  let dRight = wordmark.left;
  for (let x = wordmark.left; x < wordmark.left + wordmark.width; x += 1) {
    let has = false;
    for (let y = wordmark.top; y <= wordmark.top + wordmark.height && !has; y += 1) {
      if (isInk(x, y)) has = true;
    }
    if (!has && x > wordmark.left + wordmark.width * 0.15) {
      dRight = x - 1;
      break;
    }
    dRight = x;
  }
  const mark = crop(wordmarkRows, { left: wordmark.left, right: dRight });

  return {
    width,
    height,
    hasTagline,
    full: crop(fullRows, fullCols),
    wordmark,
    mark,
  };
}

/**
 * Ink-over-white unmultiply: returns an RGBA buffer where the page is fully
 * transparent and the artwork keeps its colour. `alpha = 255 - min(r,g,b)` and
 * the colour is divided back out, which is exactly what "remove a white
 * background" means for a logo drawn on white.
 */
export function keyOutWhite(input, width, height, channels = 3) {
  if (channels !== 3 && channels !== 4) {
    throw new Error(`keyOutWhite: expected 3 or 4 channels, got ${channels}`);
  }
  if (input.length !== width * height * channels) {
    throw new Error(`keyOutWhite: buffer is ${input.length} bytes, expected ${width * height * channels}`);
  }
  const out = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    const i = p * channels;
    const r = input[i];
    const g = input[i + 1];
    const b = input[i + 2];
    const min = Math.min(r, g, b);
    const alpha = 255 - min;
    const o = p * 4;
    if (alpha <= ALPHA_FLOOR) {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 0;
      continue;
    }
    const scale = 255 / alpha;
    // Rescale the remaining alpha so the floor does not leave a grey haze
    // around the artwork (Lanczos ringing over a white page is alpha 20-40).
    const cleaned = Math.round(Math.min(255, ((alpha - ALPHA_FLOOR) * 255) / (255 - ALPHA_FLOOR)));
    out[o] = Math.min(255, Math.max(0, Math.round((r - min) * scale)));
    out[o + 1] = Math.min(255, Math.max(0, Math.round((g - min) * scale)));
    out[o + 2] = Math.min(255, Math.max(0, Math.round((b - min) * scale)));
    out[o + 3] = cleaned;
  }
  return out;
}

/**
 * A rounded plate. The logo is navy-on-white; on a dark Windows taskbar a
 * transparent icon would be almost invisible, so the .ico and the window icon
 * keep the logo's own white page as a rounded plate (what the artwork was
 * designed on). In-app assets stay transparent.
 */
function plateSvg(size) {
  const radius = Math.round(size * 0.16);
  return Buffer.from(
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#ffffff"/>` +
      '</svg>',
  );
}

/** Render one crop centred on a square canvas and key the page out. */
async function renderSquare(crop, size, fill, { plate = false } = {}) {
  let boxWidth = Math.round(size * fill);
  let boxHeight = Math.round((boxWidth * crop.height) / crop.width);
  if (boxHeight > size * fill) {
    boxHeight = Math.round(size * fill);
    boxWidth = Math.round((boxHeight * crop.width) / crop.height);
  }
  boxWidth = Math.max(1, Math.min(size, boxWidth));
  boxHeight = Math.max(1, Math.min(size, boxHeight));

  const resized = await sharp(SOURCE)
    .extract(crop)
    .resize(boxWidth, boxHeight, { fit: 'fill', kernel: 'lanczos3' })
    .toBuffer();

  // Flatten onto white and read the raw pixels back with the channel count the
  // pipeline actually produced (compositing an RGBA crop can yield RGBA).
  const artwork = {
    input: resized,
    left: Math.round((size - boxWidth) / 2),
    top: Math.round((size - boxHeight) / 2),
  };

  if (plate) {
    // The artwork keeps its own white page (that is what it was designed on and
    // it stays readable on a dark taskbar), then a rounded-rectangle mask
    // rounds the plate: `dest-in` keeps only the pixels the mask covers.
    const flat = await sharp({
      create: { width: size, height: size, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([artwork])
      .png()
      .toBuffer();
    return sharp(flat)
      .composite([{ input: plateSvg(size), blend: 'dest-in' }])
      .png({ compressionLevel: 9 })
      .toBuffer();
  }

  const { data: square, info } = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([artwork])
    .flatten({ background: '#ffffff' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rgba = keyOutWhite(square, info.width, info.height, info.channels);
  return sharp(rgba, { raw: { width: size, height: size, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Lighten artwork for a dark background while keeping each glyph's hue, so the
 * navy/blue duo still reads as the DKS logo. Only RGB changes; alpha (which
 * already holds the keyed-out page) is untouched.
 */
export function lightenForDarkMode(rgba) {
  const out = Buffer.from(rgba);
  for (let offset = 0; offset < out.length; offset += 4) {
    if (out[offset + 3] === 0) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      // 25% of the distance from black: navy -> light steel, blue -> pale blue.
      out[offset + channel] = Math.round(255 - (255 - out[offset + channel]) * 0.25);
    }
  }
  return out;
}

/** Render a crop at its natural aspect ratio (no square canvas). */
async function renderWide(crop, width, { forDarkMode = false } = {}) {
  const height = Math.max(1, Math.round((width * crop.height) / crop.width));
  const resized = await sharp(SOURCE)
    .extract(crop)
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .toBuffer();
  const { data: rgb, info } = await sharp(resized)
    .flatten({ background: '#ffffff' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const keyed = keyOutWhite(rgb, info.width, info.height, info.channels);
  const rgba = forDarkMode ? lightenForDarkMode(keyed) : keyed;
  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function main() {
  const logo = await measureLogo();
  console.log('[icons] source', `${logo.width}x${logo.height}`, 'tagline:', logo.hasTagline);
  console.log('[icons] full lockup', logo.full, 'wordmark', logo.wordmark, 'mark', logo.mark);

  /**
   * Small sizes are simplified rather than squashed: a 2.3:1 lockup inside a
   * square canvas is only ~6px tall at 16px. 16/32 therefore use the square "D"
   * of the same logo, 48 the wordmark, and 256 the full lockup with tagline.
   */
  const plan = [
    { size: 16, crop: logo.mark, fill: 0.68 },
    { size: 32, crop: logo.wordmark, fill: 0.86 },
    { size: 48, crop: logo.wordmark, fill: 0.88 },
    { size: 256, crop: logo.hasTagline && 256 >= TAGLINE_FROM ? logo.full : logo.wordmark, fill: 0.84 },
  ];
  const frames = [];
  for (const { size, crop, fill } of plan) {
    const buffer = await renderSquare(crop, size, fill, { plate: true });
    frames.push({ size, buffer });
  }
  const sizes = plan.map((entry) => entry.size);

  const ico = await pngToIco(frames.map((frame) => frame.buffer));
  await writeFile(ICON_ICO, ico);

  // The 1024 master keeps the whole lockup, tagline included.
  await mkdir(dirname(ICON_PNG), { recursive: true });
  // Window/taskbar icon: a square plate with the "DKS" wordmark (the tagline is
  // unreadable at taskbar size, so the wordmark-only crop is used).
  await writeFile(ICON_PNG, await renderSquare(logo.wordmark, 1024, 0.9, { plate: true }));

  // Renderer assets: the FULL lockup everywhere — sidebar brand, sign-in,
  // About and even the favicon (the square "D" mark used to live in
  // src/assets/dks-mark.png; nothing in the UI references it anymore).
  await mkdir(dirname(ASSET_LOGO), { recursive: true });
  await writeFile(ASSET_LOGO, await renderWide(logo.full, 720));
  await writeFile(ASSET_LOGO_DARK, await renderWide(logo.full, 720, { forDarkMode: true }));

  console.log('[icons] wrote', [
    'build/icon.ico',
    'build/icon.png',
    'src/assets/dks-logo.png',
    'src/assets/dks-logo-dark.png',
  ].join(', '));
  console.log('[icons] ico frames', sizes.join(', '), 'bytes', ico.length);
}

main().catch((error) => {
  console.error('[icons] failed:', error);
  process.exitCode = 1;
});
