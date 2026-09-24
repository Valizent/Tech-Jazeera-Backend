/**
 * ZATCA ("Fatoora") Phase 1 QR code — the "Generation phase" requirement
 * that applies to every taxable person in Saudi Arabia regardless of
 * whether they've been onboarded into Phase 2 ("Integration", real-time
 * clearance with a government-issued cryptographic certificate — a
 * separate, much bigger project this app does NOT attempt, since it needs
 * real credentials only ZATCA can issue directly to the company — see
 * docs/CHANGELOG.md's ZATCA planning entry).
 *
 * The QR encodes 5 fields as a TLV (Tag-Length-Value) byte sequence,
 * Base64'd — ZATCA's own published spec, not invented here:
 *   1. Seller name
 *   2. Seller VAT registration number
 *   3. Invoice timestamp (ISO 8601)
 *   4. Invoice total WITH VAT
 *   5. VAT total
 * Each tag: [tag byte][UTF-8 byte-length byte][UTF-8 value bytes].
 *
 * Reuses the `qrcode` package already a dependency for the NFC module's
 * card QR codes — no new dependency needed. Deliberately a plain black
 * PNG (not NFC's branded SVG renderer): a scanner/auditor app expects a
 * standard-looking tax QR code, not a company's brand colour.
 */
import QRCode from 'qrcode';

function tlvField(tag, value) {
  const valueBytes = Buffer.from(String(value ?? ''), 'utf8');
  if (valueBytes.length > 255) {
    throw new Error(`ZATCA QR field ${tag} exceeds the 255-byte TLV length limit.`);
  }
  return Buffer.concat([Buffer.from([tag]), Buffer.from([valueBytes.length]), valueBytes]);
}

/** Builds the Base64 TLV payload ZATCA's spec defines. */
export function buildZatcaTlvBase64({ sellerName, vatNumber, timestamp, invoiceTotal, vatTotal }) {
  const buffer = Buffer.concat([
    tlvField(1, sellerName),
    tlvField(2, vatNumber),
    tlvField(3, new Date(timestamp).toISOString()),
    tlvField(4, invoiceTotal.toFixed(2)),
    tlvField(5, vatTotal.toFixed(2)),
  ]);
  return buffer.toString('base64');
}

/**
 * A plain, reliably-scannable PNG buffer of the ZATCA QR — 'M' error
 * correction and a real quiet-zone margin, the same conservative choices
 * every generic tax/payment QR code uses (this one has to be readable by
 * whatever scanner app an auditor happens to have, not just one browser).
 */
export async function buildZatcaQrPng(fields, size = 130) {
  const payload = buildZatcaTlvBase64(fields);
  return QRCode.toBuffer(payload, { type: 'png', errorCorrectionLevel: 'M', margin: 1, width: size });
}
