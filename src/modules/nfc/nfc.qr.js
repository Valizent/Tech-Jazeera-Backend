/**
 * Premium QR code generator — produces a branded, but reliably-scannable,
 * QR code:
 *   • Solid, edge-to-edge square modules — no gap, no rounding, no gradient,
 *     and the finder patterns (the 3 corner squares every scanner locks
 *     onto first) drawn by the SAME simple per-module loop as everything
 *     else, from the QR library's own matrix data, rather than manually
 *     reconstructed. All verified experimentally, not guessed: a gap as
 *     small as ~8% between modules, a per-module gradient, AND a manual
 *     "spec accurate" finder-pattern reconstruction (three concentric
 *     rects) were each independently tried and each broke real decoding —
 *     the plain per-module-from-matrix-data approach is the one
 *     configuration that decoded correctly in every test. A real user
 *     report confirmed the practical effect of the old gapped-circle-with-
 *     glow style too: scanned fine on an iPhone (a tolerant detector),
 *     failed on two different Android phones.
 *   • Company brand colour as the accent, automatically darkened if it's
 *     too light to read reliably — see ensureQrSafeColour below. This is
 *     the one thing that keeps working transparently for every company's
 *     own brand colour, not just the one that was tested.
 *
 * Uses the `qrcode` package for QR matrix data, then renders a custom SVG
 * that's converted to PNG via sharp.
 */
import QRCode from 'qrcode';
import sharp from 'sharp';

const DEFAULT_BRAND = '#1f9e78';

/**
 * Lighten a hex colour by mixing with white. Exported — the downloadable
 * card image (nfc.cardImage.js) reuses this for its own gradient/palette,
 * rather than re-deriving the same math a second time.
 */
export function lighten(hex, amount = 0.3) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.round(r + (255 - r) * amount);
  const lg = Math.round(g + (255 - g) * amount);
  const lb = Math.round(b + (255 - b) * amount);
  return `#${lr.toString(16).padStart(2, '0')}${lg.toString(16).padStart(2, '0')}${lb.toString(16).padStart(2, '0')}`;
}

// Standard broadcast/photometric luminance. Real QR decoders binarize the
// image (dark module vs. light background) off roughly this value — a
// module colour whose luminance sits too close to a white background's
// just doesn't register as "dark" reliably.
function luminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Measured experimentally against this app's real brand teal (#168587,
// 39% luminance): decoding failed at 35% luminance, passed reliably at
// 31% and below. 51/255 (20%) leaves real margin below that observed
// pass point, since a real phone's decoder may be stricter than the one
// used to test this. Scaling all channels down by the same factor keeps
// the hue intact — it just gets darker, not a different colour.
const SAFE_MAX_LUMINANCE = 51;

/** Darken a hex colour, preserving hue, only if it's too light to scan reliably. */
export function ensureQrSafeColour(hex) {
  const y = luminance(hex);
  if (y <= SAFE_MAX_LUMINANCE) return hex;
  const scale = SAFE_MAX_LUMINANCE / y;
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * scale);
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * scale);
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * scale);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Generate a premium SVG QR code string.
 */
function generateQrSvg(url, { brandColour = DEFAULT_BRAND, size = 512 } = {}) {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const moduleCount = qr.modules.size;
  const data = qr.modules.data;

  const padding = 4; // quiet zone
  const totalModules = moduleCount + padding * 2;
  const cellSize = size / totalModules;
  const fillColour = ensureQrSafeColour(brandColour);

  // Every dark module — data AND finder patterns alike — drawn the same
  // simple way, straight from the library's own matrix. See this file's
  // header comment for why: a separately hand-drawn finder pattern looked
  // right but had a real geometry bug that broke decoding outright.
  let svgContent = '';
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (!data[row * moduleCount + col]) continue;
      const x = (col + padding) * cellSize;
      const y = (row + padding) * cellSize;
      svgContent += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cellSize.toFixed(2)}" height="${cellSize.toFixed(2)}" fill="${fillColour}"/>`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${svgContent}</svg>`;
}

/**
 * Generate a premium QR code as SVG string.
 * @param {string} url - The URL to encode
 * @param {object} opts - Options
 * @param {string} opts.brandColour - Hex colour for brand accent
 * @param {number} opts.size - Image dimension in px (default 512)
 * @returns {string} SVG string
 */
export function generatePremiumQrSvg(url, opts = {}) {
  return generateQrSvg(url, opts);
}

/**
 * Convert an SVG string to a high-quality PNG buffer via sharp. Shared by
 * the QR-only endpoint (square) and the downloadable card image (portrait,
 * a different width/height) — moved here from nfc.controller.js so
 * nfc.cardImage.js can reuse it without a generator module importing from
 * an HTTP controller.
 */
export async function svgToPng(svg, { width, height }) {
  return sharp(Buffer.from(svg))
    .resize(width, height)
    .png({ quality: 100 })
    .toBuffer();
}
