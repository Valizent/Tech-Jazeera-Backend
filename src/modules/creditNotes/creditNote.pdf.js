/**
 * Credit note PDF (pdfkit) — mirrors invoice.pdf.js's exact layout
 * conventions (same shared line-item table utility), swapping the
 * payments/balance section for the reason and the invoice it corrects.
 */
import PDFDocument from 'pdfkit';
import { drawLetterhead, LETTERHEAD_HEIGHT } from '../companySettings/letterhead.pdf.js';
import { formatMoney as money, formatShortDate as shortDate } from '../../utils/pdfFormat.js';
import { lineAmount } from '../../utils/moneyMath.js';
import { LINE_ITEM_COLUMNS, drawLineItemRow, drawTotalRow } from '../../utils/pdfLineItemTable.js';

export function buildCreditNotePdf(cn, company = null, logo = null) {
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

    doc.fontSize(20).font('Helvetica-Bold').fillColor('#111').text('CREDIT NOTE', left, top + 45);
    doc.fontSize(10).font('Helvetica').fillColor('#666');
    doc.text(`No.  ${cn.creditNoteNumber}`, left, top + 72);
    doc.text(`Date  ${shortDate(cn.date)}`, left, top + 86);
    doc.text(`Against invoice  ${cn.invoiceNumber}`, left, top + 100);

    doc.moveTo(left, top + 136).lineTo(right, top + 136).strokeColor('#ddd').stroke();
    doc.fontSize(9).font('Helvetica').fillColor('#666').text('BILL TO', left, top + 146);
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#111').text(cn.clientName, left, top + 159);

    doc.fontSize(9).font('Helvetica').fillColor('#666').text('REASON', left, top + 179);
    doc.fontSize(10).font('Helvetica').fillColor('#111').text(cn.reason, left, top + 191, { width: right - left - 200 });

    const headerCells = Object.fromEntries(LINE_ITEM_COLUMNS.map((c) => [c.key, c.label]));
    let y = top + 235;
    y = drawLineItemRow(doc, { left, right, y, cells: headerCells, bold: true });
    for (const li of cn.lineItems) {
      if (y > doc.page.height - 220) {
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

    y += 10;
    y = drawTotalRow(doc, { right, y, label: 'Subtotal', value: cn.subtotal });
    y = drawTotalRow(doc, { right, y, label: 'Discount', value: -cn.discountTotal });
    y = drawTotalRow(doc, { right, y, label: 'VAT / Tax', value: cn.taxTotal });
    doc.moveTo(right - 240, y).lineTo(right, y).strokeColor('#ccc').stroke();
    y += 6;
    y = drawTotalRow(doc, { right, y, label: 'Credit Total', value: cn.grandTotal, bold: true });

    doc.end();
  });
}
