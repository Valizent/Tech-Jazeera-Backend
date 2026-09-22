/**
 * Quotation PDF generation (pdfkit). Renders a clean, printable quotation:
 * header, client block, line-item table, totals, and notes. Kept separate
 * from the service so the document-layout concern stays isolated.
 */
import PDFDocument from 'pdfkit';
import { drawLetterhead, LETTERHEAD_HEIGHT } from '../companySettings/letterhead.pdf.js';
import { formatMoney as money, formatShortDate as shortDate } from '../../utils/pdfFormat.js';
import { lineAmount } from '../../utils/moneyMath.js';
import { LINE_ITEM_COLUMNS, drawLineItemRow, drawTotalRow } from '../../utils/pdfLineItemTable.js';

/** `company`/`logo` are optional — a PDF generated before any company
 *  profile is filled in still works, just without a letterhead. */
export function buildQuotationPdf(q, company = null, logo = null) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 45 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const top = company ? LETTERHEAD_HEIGHT : 0;
    if (company) drawLetterhead(doc, company, logo);

    // Header
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#111').text('QUOTATION', left, top + 45);
    doc.fontSize(10).font('Helvetica').fillColor('#666');
    doc.text(`No.  ${q.quotationNumber}`, left, top + 72);
    doc.text(`Date  ${shortDate(q.date)}`, left, top + 86);
    if (q.validUntil) doc.text(`Valid until  ${shortDate(q.validUntil)}`, left, top + 100);
    doc.font('Helvetica-Bold').fillColor('#111').fontSize(11).text(q.status.toUpperCase(), right - 120, top + 72, { width: 120, align: 'right' });

    // Client block
    doc.moveTo(left, top + 122).lineTo(right, top + 122).strokeColor('#ddd').stroke();
    doc.fontSize(9).font('Helvetica').fillColor('#666').text('BILL TO', left, top + 132);
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#111').text(q.clientName, left, top + 145);

    // Table header
    const headerCells = Object.fromEntries(LINE_ITEM_COLUMNS.map((c) => [c.key, c.label]));
    let y = top + 180;
    y = drawLineItemRow(doc, { left, right, y, cells: headerCells, bold: true });
    for (const li of q.lineItems) {
      if (y > doc.page.height - 160) {
        doc.addPage();
        y = 60;
        y = drawLineItemRow(doc, { left, right, y, cells: headerCells, bold: true });
      }
      y = drawLineItemRow(doc, {
        left,
        right,
        y,
        cells: {
          type: li.type,
          description: li.description,
          quantity: li.quantity,
          unitPrice: money(li.unitPrice).replace('SAR ', ''),
          discount: li.discount ?? 0,
          taxRate: li.taxRate ?? 0,
          amount: money(lineAmount(li)).replace('SAR ', ''),
        },
      });
    }

    // Totals
    y += 10;
    y = drawTotalRow(doc, { right, y, label: 'Subtotal', value: q.subtotal });
    y = drawTotalRow(doc, { right, y, label: 'Discount', value: -q.discountTotal });
    y = drawTotalRow(doc, { right, y, label: 'VAT / Tax', value: q.taxTotal });
    doc.moveTo(right - 240, y).lineTo(right, y).strokeColor('#ccc').stroke();
    y += 6;
    y = drawTotalRow(doc, { right, y, label: 'Grand Total', value: q.grandTotal, bold: true });

    if (q.notes) {
      y += 14;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#666').text('NOTES', left, y);
      doc.font('Helvetica').fontSize(9).fillColor('#111').text(q.notes, left, y + 12, { width: right - left });
    }

    doc.end();
  });
}
