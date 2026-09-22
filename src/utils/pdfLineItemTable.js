/**
 * Shared line-item table + totals-row rendering for pdfkit documents
 * (Invoice/Quotation PDFs) — extracted 2026-09-22 (a real QA-audit
 * finding: `invoice.pdf.js` and `quotation.pdf.js` had byte-identical
 * `drawRow`/`totalRow` closures and an identical `cols` layout). Each
 * document keeps everything ELSE that's genuinely its own — the page-break
 * threshold, what comes before the table and after the totals (Invoice's
 * payments/balance section, Quotation's notes) — this only covers the part
 * that was truly identical.
 *
 * Both functions take an explicit `y` and RETURN the new one, rather than
 * closing over a mutable outer variable the way the original per-document
 * closures did — that's what makes this safely shared: the caller stays in
 * full control of page-break checks and layout sequencing, this just draws
 * one row.
 */
import { formatMoney as money } from './pdfFormat.js';

export const LINE_ITEM_COLUMNS = [
  { key: 'type', label: 'Type', w: 55, align: 'left' },
  { key: 'description', label: 'Description', w: 165, align: 'left' },
  { key: 'quantity', label: 'Qty', w: 40, align: 'right' },
  { key: 'unitPrice', label: 'Unit', w: 70, align: 'right' },
  { key: 'discount', label: 'Disc%', w: 45, align: 'right' },
  { key: 'taxRate', label: 'Tax%', w: 40, align: 'right' },
  { key: 'amount', label: 'Amount', w: 90, align: 'right' },
];

/** One line-item (or header) row. Returns the y just below the row's own divider line. */
export function drawLineItemRow(doc, { left, right, y, cells, bold = false, cols = LINE_ITEM_COLUMNS }) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#111');
  let x = left;
  for (const col of cols) {
    doc.text(String(cells[col.key] ?? ''), x + 2, y + 5, { width: col.w - 4, align: col.align, ellipsis: true });
    x += col.w;
  }
  const newY = y + 20;
  doc.moveTo(left, newY).lineTo(right, newY).strokeColor('#eee').stroke();
  return newY;
}

/** One totals line ("Subtotal", "Grand Total", ...). Returns the y for the next line. */
export function drawTotalRow(doc, { right, y, label, value, bold = false }) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor('#111');
  doc.text(label, right - 240, y, { width: 130, align: 'right' });
  doc.text(money(value), right - 100, y, { width: 100, align: 'right' });
  return y + (bold ? 22 : 16);
}
